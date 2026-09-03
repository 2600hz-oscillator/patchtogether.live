// scripts/vrt-strict-timings-accept.mjs
//
// Refresh `e2e/vrt-strict-timings.generated.json` from a REAL CI run (#1595).
//
// WHY THIS EXISTS AS A SCRIPT RATHER THAN A COMMENT. `e2e/e2e-timings.generated
// .json` says "Regenerate with `task e2e:timings:accept`" and that target does
// not exist — so the one cost artifact the e2e split is planned against has no
// working refresh path, and it now predates several specs (they are scheduled
// at the median instead, which is where the residual 1.36x shard spread comes
// from). Shipping a second artifact with a second imaginary accept command
// would repeat the defect, so this is the real one.
//
// Each `vrt-strict-shard` job uploads the per-test durations it harvested from
// its own reporter output (`vrt-strict-timings-<n>`). This merges them.
//
// Usage:  flox activate -- task vrt:strict:timings:accept -- <ci-run-id>
//
// Then REVIEW THE DIFF. A test whose cost moved a lot is a finding, not
// bookkeeping — the split is only as good as the numbers under it.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFullShardSet } from './ci-shard-count.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'e2e/vrt-strict-timings.generated.json');

const runId = process.argv[2];
if (!runId || !/^\d+$/.test(runId)) {
  console.error('usage: node scripts/vrt-strict-timings-accept.mjs <ci-run-id>');
  console.error('  the run must be a ci.yml run whose vrt-strict-shard jobs completed');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'vrt-timings-'));
try {
  execFileSync('gh', ['run', 'download', runId, '--pattern', 'vrt-strict-timings-*', '--dir', dir], {
    stdio: 'inherit',
  });

  const merged = {};
  let shards = 0;
  for (const sub of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, sub))) {
      if (!f.endsWith('.json')) continue;
      const one = JSON.parse(readFileSync(join(dir, sub, f), 'utf8'));
      // A key appearing in two shards means the partition leaked — refuse
      // rather than silently take the last writer.
      for (const k of Object.keys(one)) {
        if (k in merged) throw new Error(`"${k}" appears in more than one shard's timings — the partition leaked`);
      }
      Object.assign(merged, one);
      shards++;
    }
  }
  if (shards === 0) throw new Error(`run ${runId} published no vrt-strict-timings-* artifacts`);
  // ⚠ REFUSE A PARTIAL RUN, not just an empty one. Each `vrt-strict-shard`
  // matrix job uploads exactly one vrt-strict-timings-<n> JSON; accepting
  // while shards were cancelled/failed/still PENDING merges fewer, and every
  // scene on a missing shard is TRUNCATED out of the artifact to be scheduled
  // at the median from then on (the face-PR truncation failure). Expected
  // width is DERIVED from ci.yml's `vrt-strict-shard` matrix — see
  // ci-shard-count.mjs.
  assertFullShardSet(shards, 'vrt-strict-shard', `vrt-strict-timings-* shard JSON(s) in run ${runId}`);

  const prev = JSON.parse(readFileSync(OUT, 'utf8')).tests;
  const keys = Object.keys(merged).sort();
  const total = keys.reduce((a, k) => a + merged[k], 0);
  const added = keys.filter((k) => !(k in prev));
  const removed = Object.keys(prev).filter((k) => !(k in merged));
  const moved = keys.filter((k) => k in prev && Math.abs(merged[k] - prev[k]) / Math.max(prev[k], 0.001) > 0.25);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        _comment: JSON.parse(readFileSync(OUT, 'utf8'))._comment,
        _source: `ci.yml run ${runId} (${shards} vrt-strict shards, ubuntu-latest): ${keys.length} tests, ${total.toFixed(1)} CPU-s`,
        _first_test_warmup_note: JSON.parse(readFileSync(OUT, 'utf8'))._first_test_warmup_note,
        tests: Object.fromEntries(keys.map((k) => [k, merged[k]])),
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`wrote ${OUT}`);
  console.log(`  tests ${keys.length}  total ${total.toFixed(1)}s  from ${shards} shard artifact(s)`);
  console.log(`  +${added.length} new, -${removed.length} gone, ${moved.length} moved >25%`);
  for (const k of [...added, ...removed]) console.log(`    ${added.includes(k) ? '+' : '-'} ${k}`);
  for (const k of moved) console.log(`    ~ ${k}: ${prev[k]}s -> ${merged[k]}s`);
  console.log('REVIEW THE DIFF — a cost that moved a lot is a finding, not bookkeeping.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
