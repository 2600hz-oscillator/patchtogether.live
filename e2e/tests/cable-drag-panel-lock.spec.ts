// e2e/tests/cable-drag-panel-lock.spec.ts
//
// PatchPanel persistence under the post-PR-204 click-driven UX.
//
// PR-204 removed hover-to-open on the patch trigger (the panel is now
// pinned via click + a 300 ms post-click grace window). The original
// "drag-induced lock" tests in this file opened the destination panel
// mid-drag by hovering its trigger — under the new UX hover does
// nothing, and the closed-state handles inside the panel are
// pointer-events: none so a mid-drag pointerdown can't engage
// `stayOpenForDrag` either. With no current gesture that exercises the
// drag-lock end-to-end, the two drag-lock acceptance tests were removed
// in PR-208; the drag-lock mechanism itself is preserved in
// PatchPanel.svelte for future re-introductions of automatic open
// paths.
//
// What remains here: the non-drag click-open + outside-click-close
// contract. (Also lives in patch-menu-ux.spec.ts; we keep one copy
// here so a regression on PatchPanel's pin / outside-click handling
// surfaces in this spec's package too.)

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('PatchPanel: drag-induced lock', () => {
  test('non-drag PatchPanel click-open / outside-click-close (PR-204)', async ({ page }) => {
    // No cable drag at all — pure click-open. Post-PR-204 the panel is
    // click-to-open and stays open until an outside click in negative
    // space; hover does nothing.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);

    const trigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`,
    );
    const panel = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`,
    );

    // Hover ALONE no longer opens.
    await trigger.hover();
    await page.waitForTimeout(150);
    await expect(panel).toHaveAttribute('aria-hidden', 'true');

    // Click pins the panel open (no drag involved).
    await trigger.click();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');

    // Cursor leaving the panel area does NOT close it.
    await page.mouse.move(20, 20);
    await page.waitForTimeout(400);
    await expect(panel).toHaveAttribute('aria-hidden', 'false');

    // Outside click dismisses the pin.
    await page.mouse.click(20, 20);
    await page.waitForTimeout(100);
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
  });
});
