// e2e/tests/cable-drag-panel-lock.spec.ts
//
// PatchPanel open/close contract after the no-drag redesign.
//
// The drag-induced panel lock is GONE — cable dragging is retired, so there
// is no mid-drag gesture that locks a panel open. What remains: pure
// click-to-open + negative-space-click-close on the (body-portaled) menu
// chrome, plus the io-spec handle-in-DOM parity.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

test.describe('PatchPanel: click-open / outside-click-close', () => {
  test('click opens the menu; hover alone does not; outside-click closes', async ({
    page,
  }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);

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
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);
    await expect(chrome(page, 'adsr')).toHaveCount(0);
    const handleIds = await page
      .locator('.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-handleid')));
    expect(handleIds).toContain('gate');
    expect(handleIds).toContain('env');
  });
});
