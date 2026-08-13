// scripts/e2e-shard-plan.test.ts
//
// Guards the cost-based e2e shard planner (#1538).
//
// THE PROPERTY THAT MATTERS: once CI assigns spec files explicitly, Playwright
// is no longer the thing guaranteeing the whole suite runs — we are. A planner
// that silently dropped a spec would look EXACTLY like a speedup: shards finish
// sooner, everything is green, and the lost coverage is invisible. So the
// union/no-duplicate assertions below are not hygiene, they are the safety
// argument for the whole change.

import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import { planShards, median, loadTimings } from './e2e-shard-plan.mjs';

const SHARDS = 10;

describe('the partition covers the suite exactly', () => {
  const timings: Record<string, number> = loadTimings();
  const files = Object.keys(timings);

  it('has real timings to plan with (not vacuous)', () => {
    // Anchored to a NAME the artifact must contain, never to a count.
    expect(files).toContain('per-module-per-port-inputs.spec.ts');
    expect(Object.values(timings).every((v) => typeof v === 'number' && v >= 0)).toBe(true);
  });

  it('every file lands in exactly one shard — none dropped, none duplicated', () => {
    const { groups } = planShards(files, timings, SHARDS);
    const flat = groups.flat();
    expect(flat.length, 'a dropped spec would look like a speedup').toBe(files.length);
    expect(new Set(flat).size, 'a duplicated spec wastes a shard and skews the balance').toBe(files.length);
    expect([...flat].sort()).toEqual([...files].sort());
  });

  it('is deterministic — CI computes this independently per shard job', () => {
    // Each shard job runs the planner itself; they must agree without talking.
    const a = planShards(files, timings, SHARDS).groups;
    const b = planShards([...files].reverse(), timings, SHARDS).groups;
    expect(b).toEqual(a);
  });

  it('a spec with NO measured cost is still scheduled, and is reported', () => {
    // A spec added since the last timings accept must not vanish from CI.
    const withNew = [...files, 'zz-brand-new.spec.ts'];
    const { groups, unknown } = planShards(withNew, timings, SHARDS);
    expect(unknown).toContain('zz-brand-new.spec.ts');
    expect(groups.flat()).toContain('zz-brand-new.spec.ts');
    expect(groups.flat().length).toBe(withNew.length);
  });

  it('balances cost far better than the count-based split it replaces', () => {
    const { loads } = planShards(files, timings, SHARDS);
    const spread = Math.max(...loads) / Math.min(...loads);
    // Measured baseline for the CURRENT (count-based) sharding is 2.31x.
    // This is a policy threshold on a DERIVED measurement, not a population
    // count: it does not change when the suite grows.
    expect(spread, `cost spread across ${SHARDS} shards`).toBeLessThan(1.15);
  });

  it('degenerate shard counts behave', () => {
    expect(planShards(files, timings, 1).groups[0].length).toBe(files.length);
    expect(() => planShards(files, timings, 0)).toThrow();
  });
});

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(1);
  });
});
