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
    spec: 'extras-producer-lifetime.spec.ts',
    why:
      'lands 2026-08-16 with the #1720 fix (painter/textmarquee/picturebox/toybox ' +
      'rendered placeholders with no card mounted, in the DEFAULT state). No ci.yml ' +
      'run containing it has completed, so there are no blob reports to accept a cost ' +
      'from. Measured 21.7 CPU-s locally under SwiftShader single-worker — REVISED ' +
      'DOWN from 43.5 s (#1757): the first version timed out on CI because its RIG ' +
      'drew four GL nodes per frame and its probe read the whole 1024x768 frame back ' +
      '(3.1 MB, a flush+sync on the subject\'s own context), so the instrument cost ' +
      'more than the subject and starved its shard co-tenants. Still a LOCAL number ' +
      'and not what the planner needs. Run `task e2e:timings:accept -- <run-id>` on ' +
      'the first green main run after this merges and DELETE this entry — the gate ' +
      'reddens on a stale entry as loudly as on a missing one.',
  },
  {
    spec: 'midi-binding-node-lifetime.spec.ts',
    why:
      'lands 2026-08-16 with the #1727 fix (a CC binding to an un-migrated module was ' +
      'inert once its card unmounted). No ci.yml run containing it has completed, so ' +
      'there are no blob reports to accept a cost from. Run ' +
      '`task e2e:timings:accept -- <run-id>` on the first green main run after this ' +
      'merges and DELETE this entry — the gate reddens on a stale entry as well as a ' +
      'missing one.',
  },
  {
    spec: 'featurecv-face.spec.ts',
    why:
      'lands 2026-08-16 with the featurecv faceplate (#1743). No ci.yml run containing ' +
      'it has completed, so there are no blob reports to accept a cost from. Measured ' +
      'LOCALLY at 2.7 CPU-s for both tests together (1.4 s + 1.3 s, warm server, 3x), ' +
      'i.e. well UNDER the median an unmeasured spec rides — so the median fallback ' +
      'over-books this file rather than under-booking a shard, which is the safe ' +
      'direction of the #1600 failure. Run `task e2e:timings:accept -- <run-id>` on the ' +
      'first green main run after this merges and DELETE this entry — the gate reddens ' +
      'on a stale entry as well as a missing one.',
  },
  {
    spec: 'illogic-face.spec.ts',
    why:
      'lands 2026-08-16 with the illogic faceplate (queue Q17). No ci.yml run containing ' +
      'it has completed, so there are no blob reports to accept a cost from. Measured ' +
      'LOCALLY at 3.9-4.0 CPU-s for all three tests together (1.3-1.4 s + 1.2 s + 1.4 s, ' +
      'warm server, 3x with zero spread), i.e. under the median an unmeasured spec rides ' +
      '— so the median fallback over-books this file rather than under-booking a shard, ' +
      'which is the safe direction of the #1600 failure. Run ' +
      '`task e2e:timings:accept -- <run-id>` on the first green main run after this ' +
      'merges and DELETE this entry — the gate reddens on a stale entry as well as a ' +
      'missing one.',
  },
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
