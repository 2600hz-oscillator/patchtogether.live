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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {Record<string, number>} file -> seconds */
export function loadTimings(path = join(ROOT, 'e2e/e2e-timings.generated.json')) {
  return JSON.parse(readFileSync(path, 'utf8')).files;
}

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
export function planShards(files, timings, shards) {
  if (shards < 1) throw new Error(`shards must be >= 1, got ${shards}`);
  const known = Object.values(timings);
  const fallback = median(known);
  const unknown = files.filter((f) => timings[f] === undefined).sort();

  const cost = (f) => timings[f] ?? fallback;
  // Descending cost, then filename — a total order, so the result is stable.
  const ordered = [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));

  const groups = Array.from({ length: shards }, () => []);
  const loads = new Array(shards).fill(0);
  for (const f of ordered) {
    // Lightest shard; ties go to the lowest index for determinism.
    let pick = 0;
    for (let i = 1; i < shards; i++) if (loads[i] < loads[pick]) pick = i;
    groups[pick].push(f);
    loads[pick] += cost(f);
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

  if (args[0] === '--report') {
    const files = Object.keys(timings);
    const { loads } = planShards(files, timings, Number(args[1] ?? 10));
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
  const { groups, unknown } = planShards(files, timings, count);
  if (unknown.length) {
    console.error(`::warning::${unknown.length} spec(s) have no measured cost (using median): ${unknown.join(', ')}`);
  }
  // stdout is consumed by CI as the file list for this shard.
  console.log(groups[idx - 1].join('\n'));
}
