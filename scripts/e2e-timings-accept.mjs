// scripts/e2e-timings-accept.mjs
//
// Refresh `e2e/e2e-timings.generated.json` from a REAL CI run (#1600).
//
// The artifact's own header has promised "Regenerate with `task
// e2e:timings:accept`" since the day it was derived — and that target never
// existed. The one cost artifact the e2e split is planned against had no
// refresh path, so every spec added since derivation silently rode the MEDIAN:
// `layers-survive-card-collapse.spec.ts` cost 262.1 CPU-s and was scheduled at
// ~6 s — 40× under — which is how shard 8 failed a spec that was green on its
// own PR. This is the real accept loop, same shape as the vrt-strict one
// (scripts/vrt-strict-timings-accept.mjs).
//
// The e2e lane has no per-shard timing artifacts to merge — its shards upload
// PLAYWRIGHT BLOB REPORTS (for the merge-reports job). So this downloads a
// run's `blob-report-*` artifacts, lets `playwright merge-reports` unify them,
// and sums per-test duration into per-FILE CPU-seconds — the same unit the
// original derivation used (test execution time, summed; queue/setup excluded).
//
// ⚠ COSTS ONLY. The artifact deliberately no longer carries the contention
// map: classification is derived AT PLAN TIME by scripts/e2e-contention-scan
// .mjs, so it cannot go stale between accepts (#1600's second defect — the
// committed class map was a snapshot of a scan nobody could re-run, and it
// was missing 4 of the 5 specs its own war story names).
//
// Usage:  flox activate -- task e2e:timings:accept -- <ci-run-id>
//
// Then REVIEW THE DIFF. A cost that moved a lot is a finding, not bookkeeping —
// the split is only as good as the numbers under it.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'e2e/e2e-timings.generated.json');

const runId = process.argv[2];
if (!runId || !/^\d+$/.test(runId)) {
  console.error('usage: node scripts/e2e-timings-accept.mjs <ci-run-id>');
  console.error('  the run must be a ci.yml run whose e2e shard jobs completed (blob-report-* artifacts)');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'e2e-timings-'));
try {
  execFileSync('gh', ['run', 'download', runId, '--pattern', 'blob-report-*', '--dir', dir], {
    stdio: 'inherit',
  });

  // gh puts each artifact in its own subdir; merge-reports wants one dir of
  // blob zips. Collect them, refusing duplicates rather than last-writer-wins.
  const blobDir = join(dir, '_merged');
  mkdirSync(blobDir);
  let zips = 0;
  for (const sub of readdirSync(dir)) {
    if (sub === '_merged') continue;
    for (const f of readdirSync(join(dir, sub))) {
      if (!f.endsWith('.zip')) continue;
      const dest = join(blobDir, `${sub}-${f}`);
      copyFileSync(join(dir, sub, f), dest);
      zips++;
    }
  }
  if (zips === 0) throw new Error(`run ${runId} published no blob-report-* zips`);

  // Same playwright the workspace pins — versions must match the blobs'.
  // ⚠ JSON goes to a FILE (PLAYWRIGHT_JSON_OUTPUT_NAME), never stdout: npm/npx
  // banner lines interleave with a multi-MB stdout stream and the result is a
  // JSON document that fails to parse at some arbitrary offset.
  const jsonOut = join(dir, 'merged.json');
  execFileSync('npx', ['--workspace', 'e2e', 'playwright', 'merge-reports', '--reporter', 'json', blobDir], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut },
  });
  const report = JSON.parse(readFileSync(jsonOut, 'utf8'));

  /** @type {Record<string, number>} file -> seconds */
  const files = {};
  let tests = 0;
  // ⚠ Attribute every test to the TOP-LEVEL suite's file — the spec file the
  // runner was actually given — never to `spec.file`, which records where the
  // `test()` CALL lives. The per-module-per-port harness declares its tests
  // inside `_per-module-per-port-shared.ts`, and spec.file attribution charges
  // hundreds of CPU-s to that helper: a file the planner never schedules, so
  // the cost would simply vanish from the plan while the specs that pay it
  // ride cheap.
  const walk = (suites, topFile) => {
    for (const s of suites ?? []) {
      const top = topFile ?? s.file.split('/').pop();
      for (const spec of s.specs ?? []) {
        for (const t of spec.tests ?? []) {
          for (const r of t.results ?? []) {
            files[top] = (files[top] ?? 0) + r.duration / 1000;
          }
          tests++;
        }
      }
      walk(s.suites, top);
    }
  };
  walk(report.suites, undefined);
  const keys = Object.keys(files).sort();
  if (keys.length === 0) throw new Error('merge-reports produced no per-file durations — wrong artifact pattern?');

  const rounded = Object.fromEntries(keys.map((k) => [k, Math.round(files[k] * 10) / 10]));
  const total = keys.reduce((a, k) => a + rounded[k], 0);

  const prevDoc = JSON.parse(readFileSync(OUT, 'utf8'));
  const prev = prevDoc.files;
  const added = keys.filter((k) => !(k in prev));
  const removed = Object.keys(prev).filter((k) => !(k in rounded));
  const moved = keys.filter((k) => k in prev && Math.abs(rounded[k] - prev[k]) / Math.max(prev[k], 0.1) > 0.25);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        _comment:
          'Per-spec-file cost in SECONDS of test execution (CPU time, summed across a file\'s tests). ' +
          'Regenerate with `flox activate -- task e2e:timings:accept -- <ci-run-id>` (scripts/e2e-timings-accept.mjs) ' +
          'and REVIEW THE DIFF. Costs only — contention classes are derived at plan time by ' +
          'scripts/e2e-contention-scan.mjs and are deliberately NOT committed here (#1600).',
        _source: `blob-report artifacts of ci.yml run ${runId} (${tests} tests, ${keys.length} files, ${total.toFixed(0)} CPU-s)`,
        files: rounded,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`wrote ${OUT}`);
  console.log(`  files ${keys.length}  tests ${tests}  total ${total.toFixed(1)} CPU-s  from ${zips} blob zip(s)`);
  console.log(`  +${added.length} new, -${removed.length} gone, ${moved.length} moved >25%`);
  for (const k of added) console.log(`    + ${k}: ${rounded[k]}s`);
  for (const k of removed) console.log(`    - ${k} (was ${prev[k]}s)`);
  for (const k of moved) console.log(`    ~ ${k}: ${prev[k]}s -> ${rounded[k]}s`);
  console.log('REVIEW THE DIFF — a cost that moved a lot is a finding, not bookkeeping.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
