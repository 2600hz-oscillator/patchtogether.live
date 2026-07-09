// e2e/tests/_fixtures.ts
//
// Shared Playwright fixtures for the three copy-pasted blocks that used to be
// hand-rolled at the top of most specs (LoC campaign row 3). Deliberately a
// SEPARATE file from `_helpers.ts` (which is in the collab-attest basis) so
// fixture-only changes don't move the collab hash.
//
//   * `errorWatch` — collects page errors + console.error lines for the life
//     of the test and asserts the list is EMPTY at teardown (after the test
//     body finishes). Destructure it in the test signature to arm it:
//
//       test('renders', async ({ page, errorWatch }) => { ... });
//
//     The assert also runs when the body threw first — Playwright reports the
//     original failure and appends the teardown one, so a page error that
//     CAUSED the failure is still visible in the report. Tests that need to
//     assert mid-body (e.g. before an intentionally-noisy phase) can call
//     `errorWatch.assertClean()` themselves; the teardown assert then
//     re-checks the final state.
//
//     NOT auto-armed: specs that expect/filter specific console errors keep
//     hand-rolled collectors, and converting a previously-unwatched spec is a
//     behavior change that needs its own triage (see the LoC report, row 3).
//
//   * `rack` — the standard `goto('/rack')` + `networkidle` navigation that
//     opened ~90% of specs. Destructure `rack` and the page is already on the
//     rack when the body runs (fixtures resolve before the test body):
//
//       test('spawns', async ({ page, rack, errorWatch }) => { ... });
//
//     Note: `errorWatch` subscribes when set up, and Playwright sets up
//     fixtures in dependency order — both orderings of the destructure work
//     because `rack` depends on nothing and `errorWatch` binds listeners on
//     the page object itself (pre-navigation errors are still caught: the
//     listeners attach before the test body regardless).
//
// The third extracted family, `setNodeParams` (Yjs param mutation), already
// lives in `_module-coverage-helpers.ts` — import it from there.

import { test as base, expect } from '@playwright/test';

export interface ErrorWatch {
  /** Live list of collected page/console errors (push-ordered). */
  errors: string[];
  /** Assert no errors have been collected so far. */
  assertClean(): void;
}

export const test = base.extend<{ errorWatch: ErrorWatch; rack: void }>({
  errorWatch: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const watch: ErrorWatch = {
      errors,
      assertClean: () =>
        expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]),
    };
    await use(watch);
    watch.assertClean();
  },

  rack: async ({ page }, use) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await use();
  },
});

export { expect };
