// scripts/vrt-shard-plan.test.ts
//
// Guards the cost-based `vrt-strict` shard planner (#1595).
//
// THE PROPERTY THAT MATTERS, and why it is stricter here than for e2e: once the
// shards select tests by `--grep`, Playwright is no longer the thing
// guaranteeing the lane runs — we are, on the gate that BLOCKS EVERY MERGE. A
// partition that dropped a scene would look exactly like the speedup this
// change is trying to buy: faster shards, green run, missing coverage.
//
// So this file asserts the three things a shard job cannot check for itself:
//   1. the plan is a partition of the discovered roster (no drop, no duplicate);
//   2. each shard's regex selects EXACTLY its own group — the anchoring is
//      load-bearing (` polarizer …` vs `depolarizer …` differ by one space);
//   3. a test with no measured cost is still scheduled and is REPORTED.
//
// The third check a shard job DOES do for itself, and it is the only one
// anchored to the run rather than to the plan: CI diffs the tests it actually
// executed (parsed back out of the `list` reporter) against its plan. See the
// `Run VRT (strict subset)` step in ci.yml.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import {
  escapeRe,
  grepFor,
  grepTarget,
  keyOf,
  loadTimings,
  median,
  planVrtShards,
  selects,
  testsFromListJson,
} from './vrt-shard-plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The shard count ci.yml's `vrt-strict-shard` matrix uses. Read from the
 *  workflow rather than re-typed, so the two cannot disagree — the failure mode
 *  of a hand-copied count is that this file certifies a split CI does not run. */
const CI_YML_SRC = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

const SHARDS = (() => {
  const m = /vrt-strict-shard:[\s\S]*?shard:\s*\[([0-9,\s]+)\]/.exec(CI_YML_SRC);
  if (!m) throw new Error('could not read the vrt-strict-shard matrix out of ci.yml');
  return m[1].split(',').filter((s) => s.trim()).length;
})();

describe('the shard COUNT ci.yml passes to the planner is DERIVED, not re-typed', () => {
  // ⚠ THIS FILE READ THE MATRIX AND STILL CERTIFIED A SPLIT CI DID NOT RUN.
  //
  // The count reaches the planner TWICE: once as the matrix (which SHARDS above
  // reads) and once as argv[2] of the `vrt-shard-plan.mjs` invocation. Only the
  // first was checked. On 2026-08-20 (#2039) the matrix went 4 → 6 and the
  // invocation kept the literal `4`, so shards 5 and 6 ran
  // `vrt-shard-plan.mjs 5 4` / `6 4` — out of range — and died on the planner's
  // usage error. Every assertion in this file was green throughout, because it
  // planned against the matrix it read while CI planned against a literal it
  // could not see. That is the two-sided-contract blind spot in CLAUDE.md,
  // living inside the gate written to prevent exactly this.
  //
  // Coverage was never at risk (shards 1-4 still formed a complete partition
  // and the union assertion held), but two required jobs went red for a reason
  // unrelated to any baseline.
  const INVOCATION = /node scripts\/vrt-shard-plan\.mjs\s/;

  /** ci.yml with comment lines removed. `#` is a comment in BOTH the YAML and
   *  the run-block shell, and prose ABOUT the invocation (this file's own
   *  `--report <N>` hint, for one) must never be mistaken for the invocation —
   *  the same reason `ci-playwright-timeout.test.ts` strips them before
   *  scanning for `--global-timeout`. Caught immediately: the first draft of
   *  this gate matched a comment and reported the live, correct line as wrong. */
  const CI_CODE = CI_YML_SRC.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('passes ${{ strategy.job-total }}, never a number', () => {
    const m = INVOCATION.exec(CI_CODE);
    expect(m, 'ci.yml no longer invokes scripts/vrt-shard-plan.mjs — this gate is looking at nothing').not.toBeNull();
    // The count must be the derived expression. A literal here is the defect:
    // it has to track the matrix by discipline, and it silently stopped.
    const rest = CI_CODE.slice(m!.index, m!.index + 200);
    expect(
      rest,
      'the shard COUNT argument to vrt-shard-plan.mjs must be ${{ strategy.job-total }} — ' +
        'a literal has to track the matrix by hand, and in #2039 it did not, taking shards 5 and 6 red',
    ).toMatch(/vrt-shard-plan\.mjs\s+\$\{\{\s*matrix\.shard\s*\}\}\s+\$\{\{\s*strategy\.job-total\s*\}\}/);
    expect(
      rest,
      'a bare numeric shard count is exactly the drift that broke #2039',
    ).not.toMatch(/vrt-shard-plan\.mjs\s+\$\{\{\s*matrix\.shard\s*\}\}\s+\d+/);
  });

  it('NEGATIVE CONTROL: the literal form this gate exists to reject is actually rejected', () => {
    // Prove the matcher can fail, in both directions — otherwise green says
    // nothing about whether it is looking.
    const BAD = 'flox activate -- node scripts/vrt-shard-plan.mjs ${{ matrix.shard }} 4 \\';
    const GOOD = 'flox activate -- node scripts/vrt-shard-plan.mjs ${{ matrix.shard }} ${{ strategy.job-total }} \\';
    const derived = /vrt-shard-plan\.mjs\s+\$\{\{\s*matrix\.shard\s*\}\}\s+\$\{\{\s*strategy\.job-total\s*\}\}/;
    const literal = /vrt-shard-plan\.mjs\s+\$\{\{\s*matrix\.shard\s*\}\}\s+\d+/;
    expect(derived.test(BAD), 'the pre-#2039 line must NOT read as derived').toBe(false);
    expect(literal.test(BAD), 'the pre-#2039 line must be caught as a literal').toBe(true);
    expect(derived.test(GOOD)).toBe(true);
    expect(literal.test(GOOD)).toBe(false);
  });

  it('every shard index the matrix declares is in range for that count', () => {
    // The property the drift violated, stated directly against the matrix.
    const m = /vrt-strict-shard:[\s\S]*?shard:\s*\[([0-9,\s]+)\]/.exec(CI_YML_SRC)!;
    const idxs = m[1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    expect(idxs.length, 'the matrix list is empty — the parse broke').toBeGreaterThan(0);
    const outOfRange = idxs.filter((i) => i < 1 || i > SHARDS);
    expect(outOfRange, `shard indices outside 1..${SHARDS}; planVrtShards throws its usage error on these`).toEqual([]);
    expect([...idxs].sort((a, b) => a - b), 'the matrix must be 1..N with no gaps').toEqual(
      Array.from({ length: SHARDS }, (_, i) => i + 1),
    );
  });
});

type T = { file: string; title: string; titlePath: string[] };

/** The roster, reconstructed from the committed timings artifact. The real
 *  roster comes from `playwright test --list` in CI; this stands in for it in a
 *  pure-unit lane, and the CI-side executed-vs-planned diff is what ties the
 *  two together. */
const timings: Record<string, number> = loadTimings();
const roster: T[] = Object.keys(timings)
  .map((k) => {
    const [file, title] = k.split(' :: ');
    return { file, title, titlePath: [file, 'VRT: describe', title] };
  })
  .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));

describe('the vrt-strict partition covers the lane exactly', () => {
  it('has real measured costs to plan with (not vacuous)', () => {
    // Anchored to NAMES the artifact must contain, never to a count: one from
    // each spec file, so a half-empty artifact cannot pass.
    expect(Object.keys(timings)).toContain('vrt.spec.ts :: adsr card matches baseline');
    expect(Object.keys(timings)).toContain(
      'workflow-shell-faces.spec.ts :: face-adsr-dock: the dock full-view faceplate matches baseline',
    );
    expect(Object.values(timings).every((v) => typeof v === 'number' && v > 0)).toBe(true);
  });

  it('every test lands in exactly one shard — none dropped, none duplicated', () => {
    const { groups } = planVrtShards(roster, timings, SHARDS);
    const flat = (groups as T[][]).flat().map(keyOf);
    expect(flat.length, 'a dropped scene would look exactly like a speedup').toBe(roster.length);
    expect(new Set(flat).size, 'a duplicated scene wastes a shard and skews the balance').toBe(roster.length);
    expect([...flat].sort()).toEqual(roster.map(keyOf).sort());
  });

  it('no shard is empty at the configured count', () => {
    const { groups } = planVrtShards(roster, timings, SHARDS);
    for (const g of groups as T[][]) expect(g.length).toBeGreaterThan(0);
  });

  it('is deterministic — each shard job computes this independently', () => {
    const a = planVrtShards(roster, timings, SHARDS).groups;
    const b = planVrtShards([...roster].reverse(), timings, SHARDS).groups;
    expect(b).toEqual(a);
  });

  it('a test with NO measured cost is still scheduled, and is reported', () => {
    const withNew: T[] = [
      ...roster,
      { file: 'vrt.spec.ts', title: 'zzbrandnew card matches baseline', titlePath: ['vrt.spec.ts', 'D', 'zzbrandnew card matches baseline'] },
    ];
    const { groups, unknown } = planVrtShards(withNew, timings, SHARDS);
    expect(unknown).toContain('vrt.spec.ts :: zzbrandnew card matches baseline');
    expect((groups as T[][]).flat().map(keyOf)).toContain('vrt.spec.ts :: zzbrandnew card matches baseline');
    expect((groups as T[][]).flat().length).toBe(withNew.length);
  });

  it('balances measured cost — the whole point of not using --shard=N/M', () => {
    const { loads } = planVrtShards(roster, timings, SHARDS);
    const spread = Math.max(...(loads as number[])) / Math.min(...(loads as number[]));
    // Policy threshold on a DERIVED measurement, not a population count: it does
    // not move when the roster grows. File-granular sharding (what Playwright's
    // own --shard can do here, with only two spec files) is 2.61x.
    expect(spread, `cost spread across ${SHARDS} shards`).toBeLessThan(1.1);
  });
});

describe('the --grep selector picks exactly the planned tests', () => {
  it('each shard regex selects its own group and nothing else', () => {
    const { groups } = planVrtShards(roster, timings, SHARDS);
    for (const g of groups as T[][]) {
      expect(selects(grepFor(g), roster).map(keyOf).sort()).toEqual(g.map(keyOf).sort());
    }
  });

  it('the leading-space anchor is load-bearing — a suffix title must not be pulled in', () => {
    // NEGATIVE CONTROL for the anchoring, in both directions. Probed against
    // @playwright/test 1.59.1: an unanchored `polarizer …` also matches
    // `depolarizer …` (2 hits out of 115); the leading space cuts it to 1.
    const a: T = { file: 'vrt.spec.ts', title: 'polarizer card matches baseline', titlePath: ['vrt.spec.ts', 'D', 'polarizer card matches baseline'] };
    const b: T = { file: 'vrt.spec.ts', title: 'depolarizer card matches baseline', titlePath: ['vrt.spec.ts', 'D', 'depolarizer card matches baseline'] };
    expect(selects(grepFor([a]), [a, b]).map(keyOf)).toEqual([keyOf(a)]);
    // and the instrument can move: WITHOUT the anchor it over-selects.
    expect(selects(`${escapeRe(a.title)}$`, [a, b]).length).toBe(2);
  });

  it('models the string Playwright actually greps (project name first, space-joined)', () => {
    // Probed, not assumed — see the header of vrt-shard-plan.mjs.
    expect(grepTarget(roster[0])).toBe(`chromium-vrt ${roster[0].titlePath.join(' ')}`);
    expect(grepTarget(roster[0]).startsWith('chromium-vrt ')).toBe(true);
  });
});

describe('the planner refuses a plan it cannot select or cover', () => {
  it('throws on two tests sharing a leaf title across spec files', () => {
    const dup: T[] = [
      ...roster,
      { file: 'workflow-shell-faces.spec.ts', title: 'adsr card matches baseline', titlePath: ['workflow-shell-faces.spec.ts', 'D', 'adsr card matches baseline'] },
    ];
    expect(() => planVrtShards(dup, timings, SHARDS)).toThrow(/duplicate test title/);
  });

  it('throws rather than emit an empty shard', () => {
    expect(() => planVrtShards(roster.slice(0, 2), timings, SHARDS)).toThrow(/without an empty shard/);
    expect(() => planVrtShards(roster, timings, 0)).toThrow();
  });

  it('grepFor refuses an empty group', () => {
    expect(() => grepFor([])).toThrow(/empty group/);
  });
});

describe('the list-JSON parser', () => {
  it('flattens nested suites into file+title+titlePath', () => {
    const report = {
      suites: [
        {
          title: 'vrt.spec.ts',
          specs: [],
          suites: [{ title: 'D', specs: [{ file: 'vrt.spec.ts', title: 'x card matches baseline' }], suites: [] }],
        },
      ],
    };
    const out = testsFromListJson(report) as T[];
    expect(out).toEqual([
      { file: 'vrt.spec.ts', title: 'x card matches baseline', titlePath: ['vrt.spec.ts', 'D', 'x card matches baseline'] },
    ]);
  });

  it('median of an empty set does not divide by zero', () => {
    expect(median([])).toBe(1);
    expect(median([1, 3])).toBe(2);
  });
});
