// scripts/e2e-shard-plan.mjs
//
// COST-BASED e2e shard assignment (#1538).
//
// ── Why Playwright's own --shard is not enough ─────────────────────────────
//
// `--shard=N/M` splits the ordered test list into M contiguous chunks BY TEST
// COUNT. Measured on run 31679812131 (2,695 tests, 344 files, 19,319 CPU-s),
// that produces near-perfect count balance and badly broken cost balance:
//
//     shard 10:  287 tests   ~795 s wall   2.8 s/test   video-orientation,
//                                                        wavesculpt, workflow-dock…
//     shard  6:  288 tests    348 s wall   1.2 s/test   per-module-per-port
//
// A video/WebGL test under SwiftShader costs ~2.3x a DOM test, and count-based
// sharding is blind to that by construction. The worst shard sat at 89% of its
// hard `--global-timeout` of 900 s while another finished in under half that.
//
// Because files are ordered by path, alphabetically adjacent specs land on the
// same shard — which is why the `video*` / `workflow*` family clusters on 10.
//
// ── What this does instead ────────────────────────────────────────────────
//
// Longest-Processing-Time-first bin packing over MEASURED per-file cost:
// sort files by cost descending, repeatedly place the next file on the
// currently-lightest shard. LPT is the standard greedy for makespan and is
// within 4/3 of optimal; on this suite it lands on the ideal exactly.
//
// Predicted, with `per-module-per-port` split into its three dimensions (#1556):
//
//     worst shard 805 s -> 483 s   (spread 2.31x -> 1.00x)
//
// ── The property that actually matters ────────────────────────────────────
//
// Assigning files explicitly means WE are now responsible for covering the
// whole suite — Playwright is no longer doing it. A partition that silently
// drops a spec would look exactly like a speedup. So `scripts/e2e-shard-plan.test.ts`
// asserts the union of all shards equals the full discovered spec list, and
// that no file appears twice.
//
// Unknown files (a spec added since the last timings accept) are NOT dropped:
// they get the median cost so they are still scheduled, and `--report-unknown`
// lists them so the artifact can be refreshed deliberately.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanContention } from './e2e-contention-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {Record<string, number>} file -> seconds */
export function loadTimings(path = join(ROOT, 'e2e/e2e-timings.generated.json')) {
  return JSON.parse(readFileSync(path, 'utf8')).files;
}

/** @returns {Record<string, string>} file -> contention class (e.g. 'media')
 *
 *  DERIVED AT PLAN TIME by scanning the spec sources (#1600) — never read from
 *  a committed snapshot. The snapshot this replaced was the class map going
 *  stale the moment any media spec landed: layers-survive (262 CPU-s of video
 *  decode) joined no class and was packed beside other media specs, the exact
 *  shape PASS 1 exists to prevent. The scan is ~10 ms; staleness is impossible
 *  by construction. */
export function loadContention(dir = join(ROOT, 'e2e/tests')) {
  return scanContention(dir);
}

/**
 * Specs awaiting their FIRST measured cost (#1600) — the ONLY sanctioned way
 * for a scheduled spec to be absent from e2e-timings.generated.json.
 *
 * Deny by default: the freshness gate (e2e-shard-plan.test.ts) reddens on any
 * scheduled spec that is neither measured nor named here, and reddens AGAIN on
 * an entry that has become stale (its spec was deleted, or its first accept
 * has landed and the entry was not removed). An unmeasured spec rides the
 * MEDIAN, which is how a 309 CPU-s media spec was once scheduled at ~6 s and
 * failed a shard that was green everywhere else — being on this list is a debt
 * with a deadline, not a parking lot.
 *
 * @type {{ spec: string, why: string }[]}
 */
export const PENDING_FIRST_MEASUREMENT = [
  {
    spec: 'videoout-detach-display.spec.ts',
    why:
      '#1821 — new with the videoOut detach display + bridge-on-delete. Measured locally, single '
      + 'worker: 2.0 min wall for 16 tests (it grew from 10 across two review rounds). ⚠ TREAT THAT '
      + 'AS A FLOOR: backdraft-preview-toggle measured 57.5 s locally and 358.2 CPU-s on CI, ~6x. '
      + '⚠ AND THE REASON IS THE MACHINE, NOT CONTENTION — a note here previously blamed "ten shards '
      + 'competing for one software rasterizer" and that is WRONG twice over: each shard is its own '
      + 'VM so shards never contend, and a local headless run is ALREADY SwiftShader, so '
      + 'E2E_SWIFTSHADER=1 changes nothing locally. The delta is a 2-core CI VM against a dev '
      + 'machine. Run `flox activate -- task e2e:timings:accept` on the first green CI run after '
      + 'this merges and DELETE this entry.',
  },
  {
    spec: 'videoout-drop-patch.spec.ts',
    why:
      '#1819 — the per-module drop-gesture coverage that lands with the videoOut face. Measured '
      + 'locally, single worker: 24.7 s wall for 5 tests. Same ~6x floor caveat as its sibling '
      + 'above, and the same correction — the gap is the 2-core CI VM, not shard contention. For '
      + 'calibration the generic card-drop-patch.spec.ts measures 246 CPU-s. Run '
      + '`flox activate -- task e2e:timings:accept` on the first green CI run after this merges and '
      + 'DELETE this entry.',
  },
  {
    spec: 'main-thread-cost.spec.ts',
    why:
      'lands with #1811 as the instrument that MEASURED AND REJECTED the worker migration, so no ' +
      'ci.yml run containing it has completed and there is no blob report to accept a cost from. ' +
      'MEASURED under E2E_SWIFTSHADER=1, single worker, in the configuration CI actually runs ' +
      '(both perturbation phases gated OFF): 14.5 s cold, 10.2 s warm across a 3/3 flake-check. ' +
      'The full three-phase form costs 32.1 s and is OPT-IN ONLY (PT_COST_PERTURB=1, which nothing ' +
      'in CI sets): the planner co-schedules this spec onto shard 2/10 with two DOOM specs, and ' +
      'DOOM runs runTic() inside surface.draw, so its game clock IS its frame clock — a co-tenant ' +
      'that pins a core does not delay a DOOM assertion, it changes how far the marine walks. ' +
      'Owner ruling: DOOM is not touched without specific approval, and reaching that outcome ' +
      'through a neighbouring spec is the same violation through the side door. ' +
      '⚠ TREAT 10.2 s AS A FLOOR, NOT A PREDICTION. This is a VIDEO spec — it drives a real ' +
      'spirographs -> videoOut chain and asserts on engine frame counts — and the entry deleted ' +
      'directly above this one is the precedent: backdraft-preview-toggle predicted 57.5 s from ' +
      'exactly this kind of local single-worker run and measured 358.2 CPU-s, 6x, because ' +
      'the CI VM is 2-core where a dev machine is not (⚠ NOT "shards competing for one rasterizer" — every `runs-on:` here is `ubuntu-latest` and a GitHub-hosted job gets its OWN VM, so shards never contend; see the ci.yml note of 2026-08-12. A local headless run is ALREADY SwiftShader too, so E2E_SWIFTSHADER=1 changes nothing locally). Do not use the local ' +
      'number for shard-balance reasoning; it is here to prove the spec was measured at all. ' +
      'Run `task e2e:timings:accept -- <run-id>` on the first green main run after this merges and ' +
      'DELETE this entry — the gate reddens on a stale entry as loudly as on a missing one.',
  },
  {
    spec: 'freezeframe-screen-toggle.spec.ts',
    why:
      '#1861 — new with the freezeframe faceplate: the SCREEN ON/OFF preview-collapse toggle '
      + '(owner ruling 2026-08-18, every video module gets one). MEASURED locally, single worker, '
      + 'in the configuration CI runs: 8.8 s cold for 4 tests, 4.5 s warm, across a 3/3 '
      + 'flake-check (12/12, zero flaky). '
      + '⚠ TREAT 8.8 s AS A FLOOR, NOT A PREDICTION — this is a VIDEO spec and the entries above '
      + 'are the precedent (backdraft-preview-toggle predicted 57.5 s locally and measured '
      + '358.2 CPU-s on CI, ~6x, because the CI VM is 2-core; a local headless run is ALREADY '
      + 'SwiftShader so E2E_SWIFTSHADER=1 changes nothing locally). '
      + '⚠ AND THIS SPEC HAS ALREADY BEEN BITTEN BY EXACTLY THAT GAP, which is why the number '
      + 'above is lower than the first version of this entry would have carried. Its first CI run '
      + 'TIMED OUT two legs at 30 s while passing locally: FreezeframeCard drives a per-frame '
      + 'GL blit + canvas downscale, and on a two-core box under a software rasterizer that '
      + 'saturates the main thread, so an injected page.evaluate promise (a double rAF) never got '
      + 'scheduled. The spec now freezes the per-frame draw (__videoEngineFreezeRender, the lever '
      + 'card-control-overflow.spec.ts already pulls for backdraft) and waits only on '
      + 'auto-retrying expects, which is what brought the two failing legs from 2.4 s / 1.7 s to '
      + '1.0 s / 0.98 s locally. The CI cost should therefore be far below the 6x floor, but it '
      + 'has not been MEASURED on CI yet, which is the whole reason this entry exists. '
      + 'Run `task e2e:timings:accept -- <run-id>` on the first green main run after this merges '
      + 'and DELETE this entry — the gate reddens on a stale entry as loudly as on a missing one.',
  },
  {
    spec: 'b3ntb0x-hue-claim.spec.ts',
    why:
      'lands with #1901 as the acceptance test for the GLSL readout harness ' +
      '(e2e/_helpers/glsl-claim.ts), so no ci.yml run containing it has completed green and there ' +
      'is no blob report to accept a cost from. MEASURED locally, single worker: 10.7 s for both ' +
      'tests (4.1 s + 6.1 s) across a 3/3 flake-check. ' +
      '⚠ TREAT THAT AS A FLOOR, NOT A PREDICTION — and this entry exists because the FIRST version ' +
      'of this spec proved the point the hard way. It cost 34.6 s locally and BLEW THE 180 s TEST ' +
      'TIMEOUT on CI, i.e. worse than the 6x that backdraft-preview-toggle (57.5 s local vs ' +
      '358.2 CPU-s) calibrated: a video spec driving a real 4-pass NTSC float pipeline pays the ' +
      '2-core CI VM on EVERY frame, so cost scales with frames driven and nothing else. The fix ' +
      'was to stop paying a fixed 8-frame warm-up per read: bootRig now warms ONCE by observation ' +
      '(warmUntilMeasurable) and each subsequent read drives 2 frames, because a param change was ' +
      'measured to settle in 1. Frames driven per test fell ~4x. ' +
      'Do not use the local number for shard-balance reasoning; it is here to prove the spec was ' +
      'measured at all. Run `task e2e:timings:accept -- <run-id>` on the first green main run ' +
      'after this merges and DELETE this entry — the gate reddens on a stale entry as loudly as ' +
      'on a missing one.',
  },
  // Every entry here is a debt with a deadline.
  //
  // All six that stood on 2026-08-17 were paid in one accept against ci.yml run
  // 32069537806. `backdraft-preview-toggle.spec.ts` (#1784) was paid the same
  // way against run 32095771313 — its own entry named the deadline ("run
  // `task e2e:timings:accept` on the first green run after this merges and
  // DELETE this entry"), and this is that deletion.
  //
  // ⚠ ITS MEASURED COST IS 358.2 CPU-s, against the 57.5 s its entry predicted
  // from a local single-worker `E2E_SWIFTSHADER=1` run — 6x. That is not a
  // regression in the spec, it is the gap this artifact exists to close: a local
  // measurement runs on a dev machine, and CI runs on a 2-core VM. ⚠ NOT shard
  // contention — every `runs-on:` here is `ubuntu-latest` and a GitHub-hosted job
  // gets its OWN VM (ci.yml, checked 2026-08-12), and a local headless run is
  // already SwiftShader. It is now the 11th most expensive file in the suite,
  // and the planner can finally see that.
  //
  // The gate reddens on a STALE entry exactly as loudly as on a missing one, so
  // an entry whose first measurement has landed MUST be deleted rather than left
  // as a record that it once existed.
];

/** Median of a numeric array (used as the cost of an unmeasured file). */
export function median(xs) {
  if (xs.length === 0) return 1;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Partition `files` into `shards` groups, balancing measured cost.
 *
 * Deterministic: ties broken by filename, so the same inputs always produce the
 * same plan. That matters because CI computes this independently in every shard
 * job — they must agree without communicating.
 *
 * @param {string[]} files    every spec file the lane should run
 * @param {Record<string, number>} timings
 * @param {number} shards
 * @returns {{ groups: string[][], loads: number[], unknown: string[] }}
 */
export function planShards(files, timings, shards, contention = {}) {
  if (shards < 1) throw new Error(`shards must be >= 1, got ${shards}`);
  const known = Object.values(timings);
  const fallback = median(known);
  const unknown = files.filter((f) => timings[f] === undefined).sort();

  const cost = (f) => timings[f] ?? fallback;
  const byCost = (a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0);

  const groups = Array.from({ length: shards }, () => []);
  const loads = new Array(shards).fill(0);
  const place = (f, i) => {
    groups[i].push(f);
    loads[i] += cost(f);
  };

  // ── PASS 1: SPREAD each contention class, before cost packing ─────────────
  //
  // Cost balancing alone assumes specs are INDEPENDENT — that only their
  // duration matters. That is false here, and it cost a required lane:
  // `camera-input.spec.ts` failed 3/3 when cost-packing put it on a shard with
  // five other media specs (multi-video-playback, videobox-upload-perf,
  // 4plexvid, live-glyphs, mappy-export-import). At 4 workers that is up to
  // four concurrent media decodes competing for the fake webcam, and the
  // symptom was `{present: true, tracks: []}` — the element outliving its
  // stream. Main was green 5/5 throughout; the OLD count-based partition had
  // been protecting it by accident.
  //
  // Expensive specs cluster under LPT precisely BECAUSE they are expensive, so
  // the packing actively concentrates a contention class. Round-robining each
  // class across shards first makes co-location structurally impossible up to
  // `shards` members, and the cost pass then fills around it.
  //
  // Same shape as #1539 (heavy WebGL renders must not co-schedule), solved once
  // here rather than a second time per class.
  const classes = new Map();
  for (const f of files) {
    const c = contention[f];
    if (!c) continue;
    if (!classes.has(c)) classes.set(c, []);
    classes.get(c).push(f);
  }
  for (const [, members] of [...classes.entries()].sort()) {
    members.sort(byCost);
    // Start each class on the lightest shard so classes do not all pile onto 0.
    let i = loads.indexOf(Math.min(...loads));
    for (const f of members) {
      place(f, i);
      i = (i + 1) % shards;
    }
  }

  // ── PASS 2: LPT over everything else ──────────────────────────────────────
  const rest = files.filter((f) => !contention[f]).sort(byCost);
  for (const f of rest) {
    let pick = 0;
    for (let i = 1; i < shards; i++) if (loads[i] < loads[pick]) pick = i;
    place(f, pick);
  }
  for (const g of groups) g.sort();
  return { groups, loads, unknown };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('e2e-shard-plan.mjs');

if (isMain) {
  // Usage: node scripts/e2e-shard-plan.mjs <shardIndex 1-based> <shardCount> [--files <list…>]
  //        node scripts/e2e-shard-plan.mjs --report
  const args = process.argv.slice(2);
  const timings = loadTimings();
  const contention = loadContention();

  if (args[0] === '--report') {
    const files = Object.keys(timings);
    const { loads } = planShards(files, timings, Number(args[1] ?? 10), contention);
    const W = 4;
    const max = Math.max(...loads);
    const min = Math.min(...loads);
    console.log(`files=${files.length} totalCPU=${Math.round(loads.reduce((a, b) => a + b, 0))}s`);
    console.log(`predicted wall @${W} workers: max=${Math.round(max / W)}s min=${Math.round(min / W)}s spread=${(max / min).toFixed(2)}x`);
    process.exit(0);
  }

  const idx = Number(args[0]);
  const count = Number(args[1]);
  const fileArgIdx = args.indexOf('--files');
  if (fileArgIdx === -1) throw new Error('need --files <newline-or-space separated spec list>');
  const files = args
    .slice(fileArgIdx + 1)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean);
  const { groups, unknown } = planShards(files, timings, count, contention);
  if (unknown.length) {
    console.error(`::warning::${unknown.length} spec(s) have no measured cost (using median): ${unknown.join(', ')}`);
  }
  // stdout is consumed by CI as the file list for this shard.
  console.log(groups[idx - 1].join('\n'));
}
