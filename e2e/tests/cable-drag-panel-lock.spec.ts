// e2e/tests/cable-drag-panel-lock.spec.ts
//
// PatchPanel open/close contract after the no-drag redesign.
//
// The drag-induced panel lock is GONE — cable dragging is retired, so there
// is no mid-drag gesture that locks a panel open. What remains: pure
// click-to-open + negative-space-click-close on the (body-portaled) menu
// chrome, plus the io-spec handle-in-DOM parity.

import { test, expect, creditSetupBudget } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

test.describe('PatchPanel: click-open / outside-click-close', () => {
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 4 recovered-on-retry observation(s) across 2 SHA(s) / 2 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the post-no-drag-redesign PatchPanel open/close contract — a hover that opens the menu, or an outside click that fails to close it, makes every patch gesture in the app unusable.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('click opens the menu; hover alone does not; outside-click closes', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 4 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
    // ARRANGE. Charged to SETUP, not to this test's assertion budget (#1648):
    // on run 31821939046 `spawnPatch`'s `await __ensureEngine()` alone took
    // 24.61 s of the 30 s budget, and the test died on the next step — a
    // `mouse.move`, which is one CDP call and was simply the first thing to ask
    // for time that no longer existed. The four gestures below need seconds,
    // not tens of seconds; what varies by 250x on a loaded shard is the boot.
    const setupAt = Date.now();
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);
    creditSetupBudget(setupAt, 'spawnPatch (engine boot)');

    const trigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`,
    );

    // Hover ALONE no longer opens.
    await trigger.hover();
    await page.waitForTimeout(150);
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // Click opens the portaled chrome.
    await trigger.click();
    await expect(chrome(page, 'adsr')).toHaveAttribute('aria-hidden', 'false');

    // Cursor leaving the panel area does NOT close it (no hover-close timer).
    await page.mouse.move(20, 20);
    await page.waitForTimeout(300);
    await expect(chrome(page, 'adsr')).toHaveAttribute('aria-hidden', 'false');

    // Outside (negative-space) click dismisses.
    await page.mouse.click(20, 20);
    await expect(chrome(page, 'adsr')).toHaveCount(0);
  });

  test('handles for every declared port stay in the card DOM with the panel closed (io-spec parity)', async ({
    page,
  }: {
    page: Page;
  }) => {
    const setupAt = Date.now();
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);
    creditSetupBudget(setupAt, 'nav + spawnPatch (engine boot)'); // #1648
    await expect(chrome(page, 'adsr')).toHaveCount(0);
    const handleIds = await page
      .locator('.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-handleid')));
    expect(handleIds).toContain('gate');
    expect(handleIds).toContain('env');
  });
});
