// scripts/vrt-shard-coverage.mjs
//
// THE ONE CHECK ANCHORED TO THE RUN RATHER THAN TO THE PLAN (#1595).
//
// `scripts/vrt-shard-plan.mjs` proves the PLAN is a partition and that each
// shard's `--grep` selects exactly its group — but both of those are properties
// of a model of Playwright's matching, computed by the same file that produced
// the plan. If Playwright interprets the regex differently than the model does,
// every assertion in that file still passes and the shard quietly runs fewer
// scenes. On a REQUIRED lane that is indistinguishable from the speedup the
// whole change is chasing.
//
// So: parse the tests the shard ACTUALLY EXECUTED back out of the `list`
// reporter's own output, and diff that against the plan. Exact set equality,
// both directions — an extra is as much a bug as a missing one (it means two
// shards ran it and some third scene may be orphaned).
//
// ⚠ A SKIPPED TEST IS NOT AN EXECUTED TEST. Only `✓` (passed) and `✘`/`✗`
// (failed) count as run; a `-` line is reported as MISSING, which is the point
// — a scene that silently stopped running is exactly what this guards.
//
// Usage:
//   node scripts/vrt-shard-coverage.mjs <planned.txt> <run.log> [--timings <out.json>]
//
//   planned.txt  one `<spec file> :: <test title>` per line (vrt-shard-plan --out)
//   run.log      stdout of the Playwright run, `list` reporter included
//   --timings    also write {key: seconds} harvested from the log, so the cost
//                artifact can be refreshed from a real run instead of guessed

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

// `  ✓  12 [chromium-vrt] › vrt/vrt.spec.ts:64:5 › <describe> › <title> (5.1s)`
// The duration is absent on skipped lines, so it is optional.
// ⚠ The unit group MUST include bare `m`: Playwright prints `(1.5m)` for tests
// ≥60 s, and a unit the regex can't match makes the LAZY title group swallow
// the suffix — the title then mismatches its plan entry and the audit reports
// the SAME scene as both MISSING and EXTRA. Measured on #1950's shard 4
// (job 96276129946): face-b3ntb0x-dock at (1.5m) was the strict lane's first
// ≥60 s scene, 49/49 tests passed, and this audit alone took the shard red.
const LINE =
  /^\s*(✓|✘|✗|-|°)\s+\d+\s+\[[^\]]+\]\s+›\s+(\S+?):\d+:\d+\s+›\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)(ms|s|m)\))?\s*$/;

/** @returns {{ran: Map<string, number>, skipped: string[]}} */
export function parseRunLog(text) {
  const ran = new Map();
  const skipped = [];
  for (const raw of text.split('\n')) {
    // Strip the ISO timestamp GitHub prefixes onto every log line.
    const line = raw.replace(/\r$/, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s/, '');
    const m = LINE.exec(line);
    if (!m) continue;
    const [, mark, file, path, n, unit] = m;
    const title = path.split(' › ').pop().trim();
    const key = `${basename(file)} :: ${title}`;
    if (mark === '-' || mark === '°') {
      skipped.push(key);
      continue;
    }
    ran.set(
      key,
      n === undefined ? 0 : unit === 'ms' ? Number(n) / 1000 : unit === 'm' ? Number(n) * 60 : Number(n),
    );
  }
  return { ran, skipped };
}

/** @returns {{ok: boolean, missing: string[], extra: string[], skipped: string[]}} */
export function compare(planned, ran, skipped) {
  const want = new Set(planned);
  const got = new Set(ran.keys());
  return {
    ok: want.size === got.size && [...want].every((k) => got.has(k)) && skipped.length === 0,
    missing: [...want].filter((k) => !got.has(k)).sort(),
    extra: [...got].filter((k) => !want.has(k)).sort(),
    skipped: [...skipped].sort(),
  };
}

const isMain =
  typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('vrt-shard-coverage.mjs');

if (isMain) {
  const [plannedPath, logPath, ...rest] = process.argv.slice(2);
  if (!plannedPath || !logPath) {
    throw new Error('usage: vrt-shard-coverage.mjs <planned.txt> <run.log> [--timings <out.json>]');
  }
  const planned = readFileSync(plannedPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const { ran, skipped } = parseRunLog(readFileSync(logPath, 'utf8'));

  const ti = rest.indexOf('--timings');
  if (ti !== -1 && rest[ti + 1]) {
    writeFileSync(rest[ti + 1], JSON.stringify(Object.fromEntries([...ran].sort()), null, 2) + '\n');
  }

  const r = compare(planned, ran, skipped);
  console.log(`vrt-strict shard coverage: planned ${planned.length}, executed ${ran.size}, skipped ${skipped.length}`);
  if (r.ok) process.exit(0);

  // Loud, and it names the scenes — "which one stopped running" is the whole
  // question this check exists to answer.
  console.error('::error::vrt-strict shard did NOT run exactly its planned scene set.');
  if (r.missing.length) console.error(`  MISSING (planned, never executed) ${r.missing.length}:\n    ${r.missing.join('\n    ')}`);
  if (r.extra.length) console.error(`  EXTRA (executed, not planned) ${r.extra.length}:\n    ${r.extra.join('\n    ')}`);
  if (r.skipped.length) console.error(`  SKIPPED (a skip is not a pass) ${r.skipped.length}:\n    ${r.skipped.join('\n    ')}`);
  process.exit(1);
}
