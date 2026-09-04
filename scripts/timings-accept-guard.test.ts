// scripts/timings-accept-guard.test.ts
//
// Guards the PARTIAL-RUN refusal in the two cost-artifact accept loops
// (scripts/e2e-timings-accept.mjs, scripts/vrt-strict-timings-accept.mjs).
//
// THE FAILURE MODE: both scripts merge PER-SHARD artifacts of one ci.yml run,
// and both used to refuse only the ZERO case. Accepting a run whose shards
// were cancelled/failed/still pending merged fewer artifacts and silently
// TRUNCATED the cost artifact — every spec on a missing shard dropped out and
// rode the median from then on (the face-PR "accepting while shards PEND
// truncates" failure). The guard is "exactly as many shard artifacts as the
// matrix is wide", with the width DERIVED from ci.yml rather than hand-typed,
// so widening a matrix updates both guards by construction.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import { ciShardCount, assertFullShardSet } from './ci-shard-count.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE = [
  'name: fixture',
  'jobs:',
  '  e2e:',
  '    strategy:',
  '      matrix:',
  '        # a commented-out matrix must be invisible to the parser:',
  '        # shard: [1, 2]',
  '        shard: [1, 2, 3]',
  '  between:',
  '    runs-on: ubuntu-latest',
  '  vrt-strict-shard:',
  '    strategy:',
  '      matrix:',
  '        shard: [1, 2, 3, 4, 5]',
  '',
].join('\n');

describe('ciShardCount — the matrix width is DERIVED, per job', () => {
  it('counts each job’s own matrix, not its neighbor’s', () => {
    expect(ciShardCount('e2e', FIXTURE)).toBe(3);
    expect(ciShardCount('vrt-strict-shard', FIXTURE)).toBe(5);
  });

  it('ignores a commented-out shard line (negative control on the parse)', () => {
    // The e2e fixture job carries `# shard: [1, 2]` above the real line; if
    // the parser saw comments it would find TWO matrix lines and throw.
    expect(ciShardCount('e2e', FIXTURE)).toBe(3);
  });

  it('THROWS rather than guesses: missing job, missing matrix, ambiguous matrix, empty matrix', () => {
    expect(() => ciShardCount('nope', FIXTURE)).toThrow(/no job `nope`/);
    expect(() => ciShardCount('between', FIXTURE)).toThrow(/found 0/);
    const twoLines = FIXTURE.replace('shard: [1, 2, 3]', 'shard: [1, 2, 3]\n        shard: [4, 5]');
    expect(() => ciShardCount('e2e', twoLines)).toThrow(/found 2/);
    const empty = FIXTURE.replace('shard: [1, 2, 3]', 'shard: []');
    expect(() => ciShardCount('e2e', empty)).toThrow(/EMPTY shard matrix/);
  });
});

describe('assertFullShardSet — a partial run is REFUSED loudly', () => {
  it('passes through exactly-full and returns the width', () => {
    expect(assertFullShardSet(3, 'e2e', 'blob-report-* artifact(s)', FIXTURE)).toBe(3);
  });

  it('refuses FEWER artifacts than the matrix, naming both counts', () => {
    expect(() => assertFullShardSet(2, 'e2e', 'blob-report-* artifact(s)', FIXTURE)).toThrow(
      /found 2 .* `e2e` matrix is 3 wide .* TRUNCATE/s,
    );
  });

  it('refuses MORE artifacts too — a duplicated shard set is not a fuller run', () => {
    expect(() => assertFullShardSet(6, 'vrt-strict-shard', 'shard JSON(s)', FIXTURE)).toThrow(
      /found 6 .* `vrt-strict-shard` matrix is 5 wide/s,
    );
  });
});

describe('the coupling to the REAL ci.yml holds', () => {
  // Anchored to today's widths on purpose (the same way e2e-shard-plan.test.ts
  // pins SHARDS = 12): the accept scripts derive the width at runtime, so a
  // widened matrix updates the guards by construction — and reddens HERE, so
  // the person widening it re-pins this line deliberately and knows the
  // accept guards moved with it.
  it('derives 12 for both sharded lanes from .github/workflows/ci.yml', () => {
    expect(ciShardCount('e2e')).toBe(12);
    expect(ciShardCount('vrt-strict-shard')).toBe(12);
  });

  it('both accept scripts actually CALL the guard (the wiring cannot silently revert)', () => {
    for (const [script, job] of [
      ['e2e-timings-accept.mjs', 'e2e'],
      ['vrt-strict-timings-accept.mjs', 'vrt-strict-shard'],
    ] as const) {
      const src = readFileSync(join(ROOT, 'scripts', script), 'utf8');
      expect(src, `${script} must import the shared guard`).toContain("from './ci-shard-count.mjs'");
      expect(src, `${script} must guard on its own matrix`).toContain(`assertFullShardSet(`);
      expect(src, `${script} must name job \`${job}\``).toContain(`'${job}'`);
    }
  });
});
