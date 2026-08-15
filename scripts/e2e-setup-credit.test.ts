// scripts/e2e-setup-credit.test.ts
//
// PERMANENT NEGATIVE CONTROL for the e2e SETUP BUDGET CREDIT (#1648, #1569).
//
// The credit exists because Playwright's test timeout is ONE wall-clock budget
// covering fixture setup + arrange + assert, so a 24.6 s engine boot on a loaded
// CI shard silently ate a 15 s product tolerance (see `_setup-credit.ts` for the
// two traces). A mechanism that *hands time back* is exactly the shape that can
// go wrong in the reassuring direction — credit too much and a real hang stops
// failing; credit nothing and the flake comes back with the gate still green.
//
// So this drives the REAL `applySetupCredit` — the same function the fixtures
// and specs call, not a re-implementation — in BOTH directions:
//   * perturb the measured setup cost and confirm the budget MOVES with it;
//   * confirm it is bounded, so a pathological setup still fails;
//   * confirm it no-ops where there is no budget to protect.
//
// ⚠ The failure this guards against is invisible at runtime: a credit that
// silently did nothing and a credit that worked look identical from a green e2e
// run, because both only differ under load. That is why it is asserted here.

import { describe, it, expect } from 'vitest';
import {
  applySetupCredit,
  SETUP_CREDIT_CAP_MS,
  type CreditableTestInfo,
} from '../e2e/tests/_setup-credit';

/** A stand-in for Playwright's TestInfo with the same mutation semantics:
 *  `setTimeout` REPLACES the budget, and `timeout` reads back the new value. */
function fakeTestInfo(timeout: number): CreditableTestInfo & { annotations: { type: string; description?: string }[] } {
  const info = {
    timeout,
    setTimeout(ms: number) {
      info.timeout = ms;
    },
    annotations: [] as { type: string; description?: string }[],
  };
  return info;
}

describe('applySetupCredit — the assertion budget must be invariant to setup cost', () => {
  it('credits the measured setup time back, exactly', () => {
    const info = fakeTestInfo(30_000);
    const credited = applySetupCredit(info, 24_610, 'spawnPatch (engine boot)');
    expect(credited).toBe(24_610);
    // The real number from run 31821939046: a 30 s test that spent 24.61 s
    // booting must still have its full 30 s of ASSERTION budget left.
    expect(info.timeout).toBe(54_610);
  });

  it('POSITIVE CONTROL: the budget moves WITH the setup cost, one-for-one', () => {
    // Perturb the thing it claims to measure and confirm the number moves —
    // a credit wired to a constant, or to nothing, dies here.
    const seen = [0, 1_000, 5_000, 24_610].map((spent) => {
      const info = fakeTestInfo(30_000);
      applySetupCredit(info, spent, 'probe');
      return info.timeout - 30_000;
    });
    expect(seen).toEqual([0, 1_000, 5_000, 24_610]);
  });

  it('NEGATIVE CONTROL: an UNCREDITED test keeps the budget setup already ate', () => {
    // The pre-fix world, stated as an assertion so the regression is legible:
    // without a credit call the budget never moves, which is exactly how a
    // declared 15 s tolerance became 0.4 s on run 31833587260.
    const info = fakeTestInfo(30_000);
    expect(info.timeout).toBe(30_000);
    expect(info.annotations).toEqual([]);
  });

  it('is CAPPED — pathologically slow setup still fails rather than running unbounded', () => {
    const info = fakeTestInfo(30_000);
    const credited = applySetupCredit(info, SETUP_CREDIT_CAP_MS * 10, 'a wedged boot');
    expect(credited).toBe(SETUP_CREDIT_CAP_MS);
    expect(info.timeout).toBe(30_000 + SETUP_CREDIT_CAP_MS);
  });

  it('no-ops when there is no budget to protect (timeout === 0 means unlimited)', () => {
    const info = fakeTestInfo(0);
    expect(applySetupCredit(info, 24_610, 'probe')).toBe(0);
    expect(info.timeout).toBe(0);
    expect(info.annotations).toEqual([]);
  });

  it('never credits negative time (a clock that went backwards must not SHRINK the budget)', () => {
    const info = fakeTestInfo(30_000);
    expect(applySetupCredit(info, -5_000, 'probe')).toBe(0);
    expect(info.timeout).toBe(30_000);
  });

  it('ANNOTATES every credit, with the spent/credited/cap figures and the final budget', () => {
    // A credit that is invisible in the report is a credit that hides a
    // slow-setup regression. The annotation is the thing that keeps "setup got
    // 10x slower" a finding rather than an absorbed cost.
    const info = fakeTestInfo(30_000);
    applySetupCredit(info, 24_610, 'spawnPatch (engine boot)');
    expect(info.annotations).toHaveLength(1);
    const note = info.annotations[0];
    expect(note.type).toBe('setup-credit');
    expect(note.description).toContain('spawnPatch (engine boot)');
    expect(note.description).toContain('24610 ms');
    expect(note.description).toContain(String(SETUP_CREDIT_CAP_MS));
    expect(note.description).toContain('54610 ms');
  });
});
