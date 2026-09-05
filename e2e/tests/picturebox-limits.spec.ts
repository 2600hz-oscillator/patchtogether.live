// e2e/tests/picturebox-limits.spec.ts
//
// Verifies the per-workspace (8) PICTUREBOX cap lands in the spawn
// handler in single-user mode. Tested by clicking through the real
// palette UI rather than the dev-only __patch global so we exercise the
// production spawn path.
//
// The per-user (2) cap requires a real currentUserId in scope — that
// only happens on /r/[id] (multiplayer) under Clerk auth or via
// /r/[id]?invite=… anon. The decision-logic for that path is covered
// by the unit tests in
// packages/web/src/lib/multiplayer/picturebox-limits.test.ts and the
// spawn handler's call site is straight-line code (no branches the
// e2e would catch that the unit doesn't). Skipped here.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { openModulePalette } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

async function openPalette(page: Page): Promise<void> {
  // Right-click an empty pane spot (the production palette entry point —
  // the topbar button is gone). The helper scans for an empty spot, which
  // matters here: each spawned PICTUREBOX lands AT the click point, so a
  // fixed coordinate would hit a card on the next open.
  await openModulePalette(page);
}

async function pickPicturebox(page: Page): Promise<boolean> {
  await openPalette(page);
  // Search-mode flattens the nested menu so the palette-item-* testid is
  // queryable without drilling into Video modules → Sources.
  await page.keyboard.type('PICTUREBOX');
  const pbItem = page.locator('[data-testid="palette-item-picturebox"]');
  const present = (await pbItem.count()) > 0;
  if (present) {
    await pbItem.click();
  } else {
    // Greyed-out / hidden by maxInstances filter. Close the palette
    // so subsequent clicks don't open another one on top.
    await page.keyboard.press('Escape');
  }
  // Wait for the palette overlay to fully close before the next
  // openPalette call — otherwise the overlay div eats the click.
  await page.locator('.module-palette').waitFor({ state: 'detached' });
  return present;
}

async function countPictureboxes(page: Page): Promise<number> {
  return await page.locator('.svelte-flow__node:has([data-shell-type="picturebox"])').count();
}

test.describe('PICTUREBOX spawn limits', () => {
  test.setTimeout(60_000);

  test('per-workspace cap = 8: ninth pick is blocked and the palette greys it out', async ({ page }) => {
    // ⚠ THE RENDER LOOP IS PAUSED, AND THAT IS THE FIX — NOT A BIGGER BUDGET.
    //
    // This test blew its 60 s budget on CI inside `locator.click`, 61.5 s spent
    // in "waiting for element to be visible, enabled and stable". The element
    // is `palette-item-picturebox`: a STATIC <button> in a DOM overlay, which
    // cannot itself be moving. Playwright's stability check needs the same
    // bounding box across two CONSECUTIVE ANIMATION FRAMES, so a static button
    // that is "not stable" for a minute means it never got two consecutive
    // frames at all — the main thread is starved, not the button.
    //
    // What starves it is this test's own subject: by pick #8 the canvas carries
    // eight PICTUREBOX lane tiles, each with a live `VideoTileThumb` blitting,
    // on CI's 2-core runner with five shard-mates. Locally, under
    // `E2E_SWIFTSHADER=1`, the same eight cost 10.0 s and pass — the renderer
    // is not the variable, the core count is.
    //
    // ⚠ AND THE PICTURES ARE NOT THE SUBJECT. Every assertion here is DOM: the
    // palette offers the item, `countPictureboxes` counts `.svelte-flow__node`
    // wrappers, and the cap hides the entry. Nothing reads a pixel. So pausing
    // the video engine removes the load WITHOUT removing anything this test
    // claims — the budget stays at 60 s, untouched.
    //
    // The `rack` fixture is dropped deliberately: it navigates during SETUP,
    // and `addInitScript` has to land before the app boots. Same reason
    // `backdraft.spec.ts`'s feedback case owns its own navigation.
    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    // Spawn 8 PICTUREBOXes — all should succeed.
    for (let i = 0; i < 8; i++) {
      const ok = await pickPicturebox(page);
      expect(ok, `pick #${i + 1} should be available in palette`).toBe(true);
    }
    await expect.poll(() => countPictureboxes(page), { timeout: 5000 }).toBe(8);

    // The palette should now hide the picturebox option entirely
    // (maxInstances filter on the def). Open it and assert.
    await openPalette(page);
    await page.keyboard.type('PICTUREBOX');
    await expect(page.locator('[data-testid="palette-item-picturebox"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Verify the count stays at 8 — palette filtering is the user's
    // protection, but the spawn handler is the safety net.
    await expect.poll(() => countPictureboxes(page), { timeout: 1000 }).toBe(8);
  });
});
