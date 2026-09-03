// scripts/ci-shard-count.mjs
//
// DERIVE a ci.yml job's shard-matrix width, for the timings-accept guards.
//
// ── THE MATRIX COUPLING THIS ENCODES ────────────────────────────────────────
// Both cost artifacts are refreshed by merging PER-SHARD artifacts of one
// ci.yml run:
//
//   e2e-timings-accept.mjs         merges  blob-report-<n>        (job `e2e`)
//   vrt-strict-timings-accept.mjs  merges  vrt-strict-timings-<n> (job
//                                                         `vrt-strict-shard`)
//
// A run whose shards did not ALL complete (cancelled umbrella, killed shard,
// accept fired while shards still PEND) publishes FEWER artifacts — and both
// scripts used to refuse only the zero case, so a partial merge went through
// and silently TRUNCATED the artifact: every spec whose shard was missing
// dropped out and rode the median from then on. The guard is "exactly as many
// shard artifacts as the matrix is wide", and the width is DERIVED from
// ci.yml here rather than hand-typed 12s in two scripts, so widening a matrix
// (`shard: [1..12]` → 13) updates the guards by construction.
//
// Parsing is deliberately narrow: find the job's block, find its single
// `shard: [ … ]` matrix line, count entries. It THROWS on anything it cannot
// see (missing job, no matrix line, two matrix lines) — a guard that guesses
// is worse than none. scripts/timings-accept-guard.test.ts pins the behavior
// and the coupling.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Width of `jobId`'s `shard: [ … ]` matrix in ci.yml.
 *
 * @param {string} jobId   the workflow job key, e.g. 'e2e' or 'vrt-strict-shard'
 * @param {string} [source] ci.yml text (injectable for tests)
 * @returns {number}
 */
export function ciShardCount(
  jobId,
  source = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
) {
  const lines = source.split('\n');
  // Jobs sit at 2-space indent under `jobs:`. Comments and run-block content
  // are indented deeper or start with '#', so this cannot match inside either.
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(`ci.yml has no job \`${jobId}\` — the accept guard is coupled to that job's shard matrix`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[\w-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const matrixLines = lines
    .slice(start + 1, end)
    .filter((l) => /^\s+shard:\s*\[[^\]]*\]\s*$/.test(l));
  if (matrixLines.length !== 1) {
    throw new Error(
      `expected exactly one \`shard: [ … ]\` matrix line in ci.yml job \`${jobId}\`, found ${matrixLines.length}`,
    );
  }
  const entries = matrixLines[0]
    .replace(/^[^[]*\[/, '')
    .replace(/\].*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error(`ci.yml job \`${jobId}\` has an EMPTY shard matrix`);
  return entries.length;
}

/**
 * Refuse a partial run: `found` per-shard artifacts must equal the matrix
 * width. Returns the expected width so callers can log it.
 *
 * @param {number} found  how many per-shard artifacts the run published
 * @param {string} jobId  the ci.yml job whose matrix produces them
 * @param {string} what   human name of the artifact family (for the message)
 * @param {string} [source] ci.yml text (injectable for tests)
 * @returns {number}
 */
export function assertFullShardSet(found, jobId, what, source) {
  const expected = ciShardCount(jobId, source);
  if (found !== expected) {
    throw new Error(
      `found ${found} ${what} but ci.yml's \`${jobId}\` matrix is ${expected} wide — ` +
        `a partial run (cancelled/failed/still-pending shards) would silently TRUNCATE the cost artifact: ` +
        `every spec on a missing shard drops out and rides the median. ` +
        `Accept only a run whose \`${jobId}\` shards ALL completed.`,
    );
  }
  return expected;
}
