// e2e/tests/seed-none-fixture.spec.ts
//
// THE EMPTY-RACK FIXTURE IS ITSELF A CONTRACT, so it gets a test.
//
// `?seed=none` is what ~200 specs stand on after the second shell was deleted:
// they assert "I spawned two nodes, the graph has two nodes", and that is only
// meaningful if the rack really does start empty. A fixture that silently
// seeded ONE node would not fail loudly — it would shift every one of those
// counts by one and be debugged over and over, in each spec, as that spec's
// own problem.
//
// It also pins the two halves against each other: `seed=none` must suppress the
// seeders, and the DEFAULT must still seed. A suppressor that suppressed
// nothing, and a suppressor that suppressed everything everywhere, both look
// like "the tests pass" from one side only.

import { test, expect } from './_fixtures';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { canvasPane } from './_helpers';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot wait with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget it was running inside. 1 site, 1.00x.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

/** Every node id on the graph. */
async function nodeIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch?.nodes ?? {});
  });
}

async function edgeIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __patch?: { edges: Record<string, unknown> } };
    return Object.keys(w.__patch?.edges ?? {});
  });
}

test('?seed=none: the rack is GENUINELY empty — no pins, no video zone, no auto-clock', async ({
  page,
}) => {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await canvasPane(page).waitFor({ state: 'visible' });

  // Hold for a while in FRAMES: the seeders are async $effects, so "empty right
  // now" and "empty once the effects have had their chance" are different
  // claims and only the second one is the fixture's promise.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let n = 0;
        const tick = () => (++n >= 60 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
  );

  expect(await nodeIds(page), 'a ?seed=none rack has NO nodes at all').toEqual([]);
  expect(await edgeIds(page), 'a ?seed=none rack has NO edges').toEqual([]);
});

test('NEGATIVE CONTROL: WITHOUT ?seed=none the same rack DOES seed', async ({ page }) => {
  // Without this leg the test above passes just as happily against a
  // `seedShellDefaults` that is stuck false for everyone — i.e. against a
  // product with no pinned singletons at all.
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await expect
    .poll(async () => (await nodeIds(page)).filter((id) => id.startsWith('pinned-')).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  const ids = await nodeIds(page);
  expect(
    ids.some((id) => id.startsWith('workflow-')),
    `the video-zone defaults seed too; got ${ids.join(', ')}`,
  ).toBe(true);
});

test('?seed=none suppresses SEEDING ONLY — the shell chrome is untouched', async ({ page }) => {
  // The fixture must not become a second UI mode by the back door: it exists to
  // remove starter CONTENT, not to change what the app looks like.
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await expect(page.getByTestId('workflow-file-trigger')).toBeVisible();
  await expect(page.getByTestId('workflow-leftbar')).toBeVisible();
});
