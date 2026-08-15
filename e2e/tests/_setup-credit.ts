// e2e/tests/_setup-credit.ts
//
// SETUP BUDGET CREDIT (#1648) — the pure half, so it can be unit-tested with a
// permanent negative control (`scripts/e2e-setup-credit.test.ts`) instead of
// being trusted. No `@playwright/test` import: everything here is a function of
// a plain `{ timeout, setTimeout, annotations }` shape.
//
// ── the mechanism ──────────────────────────────────────────────────────────
//
// Playwright's test timeout is ONE wall-clock budget covering fixture setup +
// arrange + assert. On a loaded 10-shard CI runner the setup half is
// effectively unbounded, so the ASSERT half's declared budget is not the budget
// the test actually gets. This is the repo's own rule — *a wall-clock budget is
// a different assertion on every machine* — one level up, applied to the test
// timeout itself.
//
// ── measured, from the two runs that produced the last flaky singles of #1569 ─
// (step timings read out of those runs' own traces, not inferred)
//
//   cable-drag-panel-lock, run 31821939046 — reported as "`mouse.move` hit the
//   30 s budget". `mouse.move` is one CDP call; it was merely the first step
//   after the budget was already gone:
//       t=5.56  dur=24.61  evaluate  await __ensureEngine()
//   ENGINE BOOT alone took 24.61 s — 82 % of the budget — inside spawnPatch,
//   before the test's first assertion. The retry passed in 6.5 s total.
//
//   clipplayer-card-erase, run 31833587260 — reported as "the silence poll
//   (15 s) exhausted its budget". It did NOT; it never got one:
//       t=12.68 .. 26.61   eight cell clicks, 13.9 s total (1.0-2.4 s each)
//       t=28.24 dur=1.37   click clipplayer-clear
//       t=29.61            expect.poll(timeout: 15_000) STARTS
//       t=30.00            TEST TIMEOUT
//   The spec declares a 15 s tolerance for the product to go silent and could
//   structurally never spend more than 0.4 s of it.
//
// ⚠ THIS IS NOT "WIDEN THE BOUND". The product tolerance and the module boot
// time are unrelated quantities currently SUMMED into one number. Crediting
// gives no assertion more room than it already declares — it makes the declared
// room actually available, and makes the assert-phase budget INVARIANT to setup
// cost, which is the property the current design lacks.
//
// ── why it cannot mask a regression ────────────────────────────────────────
//
//   * the credit is applied AFTER the setup step completes, so a genuine HANG
//     still fails on the original timeout — there is nothing to credit from
//     inside a wedge;
//   * the credit is CAPPED, so pathologically slow setup still fails;
//   * every credit is ANNOTATED on the test, so a slow-setup regression stays
//     visible in the report instead of being silently absorbed.

/** Ceiling on how much setup time a single call may credit back. A policy
 *  threshold on a measured quantity, not a count of anything: past this, slow
 *  setup is a defect to SEE, not a cost to absorb. */
export const SETUP_CREDIT_CAP_MS = 90_000;

/** The slice of Playwright's `TestInfo` this needs. Narrow on purpose — it is
 *  what lets the negative control drive the real function. */
export interface CreditableTestInfo {
  timeout: number;
  setTimeout: (ms: number) => void;
  annotations: { type: string; description?: string }[];
}

/**
 * Credit `spentMs` of measured SETUP time back to `testInfo`'s timeout, capped,
 * and annotate what happened. Returns the credit actually applied.
 *
 * Split from the clock so the negative control can drive it with exact numbers
 * — `creditSetupBudget` in `_fixtures.ts` is the thin `Date.now()` wrapper.
 */
export function applySetupCredit(
  testInfo: CreditableTestInfo,
  spentMs: number,
  label: string,
): number {
  // timeout === 0 means "no timeout" — there is no budget to protect, and
  // crediting would be meaningless rather than merely useless.
  if (testInfo.timeout === 0) return 0;
  const spent = Math.max(0, Math.round(spentMs));
  const credit = Math.min(spent, SETUP_CREDIT_CAP_MS);
  testInfo.setTimeout(testInfo.timeout + credit);
  testInfo.annotations.push({
    type: 'setup-credit',
    description:
      `${label}: setup spent ${spent} ms, credited ${credit} ms ` +
      `(cap ${SETUP_CREDIT_CAP_MS} ms) — test budget now ${testInfo.timeout} ms`,
  });
  return credit;
}
