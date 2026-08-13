// Does the e2e cost model predict the SHARD WALL TIMES that actually happened?
// If it does not, rebalancing against it cannot help — validate the instrument
// before spending a lever on it.
import { readFileSync } from 'node:fs';
import { planShards, loadTimings, loadContention } from '../scripts/e2e-shard-plan.mjs';

const timings = loadTimings();
const contention = loadContention();
const list = JSON.parse(readFileSync('.ci-measure/e2e-list.json', 'utf8'));
const files = new Set();
(function w(ss) { for (const s of ss ?? []) { for (const sp of s.specs ?? []) files.add(sp.file); w(s.suites); } })(list.suites);
const discovered = [...files].sort();

// Measured Playwright STEP seconds, run 31736165616, shard 1..10.
const actual = [538, 502, 540, 645, 423, 490, 536, 426, 626, 510];
const W = 4; // workers per shard

function report(label, roster) {
  const { loads } = planShards(roster, timings, 10, contention);
  const scale = actual.reduce((a, b) => a + b, 0) / (loads.reduce((a, b) => a + b, 0) / W);
  console.log(`\n== ${label} (${roster.length} files) ==`);
  console.log('shard  predictedCPU  predWall  actualWall  err');
  let worst = 0;
  for (let i = 0; i < 10; i++) {
    const pred = (loads[i] / W) * scale;
    const err = ((pred - actual[i]) / actual[i]) * 100;
    worst = Math.max(worst, Math.abs(err));
    console.log(`  ${String(i + 1).padStart(2)}  ${loads[i].toFixed(0).padStart(11)}  ${pred.toFixed(0).padStart(8)}  ${String(actual[i]).padStart(10)}  ${err.toFixed(1).padStart(6)}%`);
  }
  console.log(`predicted spread ${(Math.max(...loads) / Math.min(...loads)).toFixed(2)}x · actual spread ${(Math.max(...actual) / Math.min(...actual)).toFixed(2)}x · worst |err| ${worst.toFixed(0)}%`);
  return loads;
}

report('A. as CI plans today (every discovered file, unknowns at median)', discovered);

// The e2e shard command greps OUT @collab / @capacity / BEHAVIORAL, but the
// PLANNER is blind to that: those specs get the median cost and their shard is
// charged for work it will never do.
const INVERTED = new Set([
  'awareness.spec.ts', 'cadillac-collab.spec.ts', 'capacity.spec.ts', 'collab.spec.ts',
  'doom-identity-crossview.spec.ts', 'doom-late-join.spec.ts', 'doom-launch.spec.ts',
  'doom-mp-latejoin-freeze.spec.ts', 'doom-mp-lockstep-sharedstate.spec.ts', 'doom-mp-real.spec.ts',
  'doom-multiplayer.spec.ts', 'mike-rackspace.spec.ts', 'picturebox-sync.spec.ts',
  'rackspace-isolation.spec.ts', 'shared-rack-sync.spec.ts', 'workflow-dock-collab.spec.ts',
  '_per-module-per-port-shared.ts',
]);
report('B. same, minus the specs the run greps away', discovered.filter((f) => !INVERTED.has(f)));

const unknown = discovered.filter((f) => timings[f] === undefined);
console.log(`\nunknown-to-the-artifact: ${unknown.length} files`);
console.log(`  of which grep-inverted (phantom load): ${unknown.filter((f) => INVERTED.has(f)).length}`);
console.log(`  genuinely new + unmeasured:            ${unknown.filter((f) => !INVERTED.has(f)).join(', ')}`);
