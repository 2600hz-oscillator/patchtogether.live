import { readFileSync } from 'node:fs';
import { planShards, loadTimings, loadContention } from '../scripts/e2e-shard-plan.mjs';

const timings = loadTimings();
const contention = loadContention();
const list = JSON.parse(readFileSync('.ci-measure/e2e-list.json', 'utf8'));
const files = new Set();
(function w(ss) { for (const s of ss ?? []) { for (const sp of s.specs ?? []) files.add(sp.file); w(s.suites); } })(list.suites);
const discovered = [...files].sort();
const actual = [538, 502, 540, 645, 423, 490, 536, 426, 626, 510];

const { groups, loads } = planShards(discovered, timings, 10, contention);
const med = (() => { const s = Object.values(timings).sort((a, b) => a - b); return s[s.length >> 1]; })();
const cost = (f) => timings[f] ?? med;

console.log('shard  CPU   maxFile  wall/4  actual  top-3 files by cost');
for (let i = 0; i < 10; i++) {
  const top = [...groups[i]].sort((a, b) => cost(b) - cost(a)).slice(0, 3);
  console.log(
    `  ${String(i + 1).padStart(2)}  ${loads[i].toFixed(0).padStart(4)}  ${cost(top[0]).toFixed(0).padStart(7)}  ${(loads[i] / 4).toFixed(0).padStart(6)}  ${String(actual[i]).padStart(6)}   ` +
      top.map((f) => `${f}(${cost(f).toFixed(0)}s)`).join(' '),
  );
}
console.log('\ncorrelation(maxFile, actualWall):', (() => {
  const x = groups.map((g) => Math.max(...g.map(cost)));
  const y = actual;
  const mx = x.reduce((a, b) => a + b) / 10, my = y.reduce((a, b) => a + b) / 10;
  const num = x.reduce((a, _, i) => a + (x[i] - mx) * (y[i] - my), 0);
  const den = Math.sqrt(x.reduce((a, v) => a + (v - mx) ** 2, 0) * y.reduce((a, v) => a + (v - my) ** 2, 0));
  return (num / den).toFixed(2);
})());
console.log('correlation(CPUload, actualWall):', (() => {
  const x = loads, y = actual;
  const mx = x.reduce((a, b) => a + b) / 10, my = y.reduce((a, b) => a + b) / 10;
  const num = x.reduce((a, _, i) => a + (x[i] - mx) * (y[i] - my), 0);
  const den = Math.sqrt(x.reduce((a, v) => a + (v - mx) ** 2, 0) * y.reduce((a, v) => a + (v - my) ** 2, 0));
  return (num / den).toFixed(2);
})());
console.log('\nfile-count per shard:', groups.map((g) => g.length).join(' '));
