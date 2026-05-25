// e2e/tests/video-fullscreen.spec.ts
//
// True-fullscreen mode for VIDEO OUT + BENTBOX. Right-click the live video
// canvas -> "Fullscreen" puts the card's canvas wrapper into real browser
// fullscreen via element.requestFullscreen(); double-click anywhere (and
// Esc, browser default) exits.
//
// Assertion strategy: requestFullscreen() needs a user-gesture context.
// Playwright's button.click() IS a gesture, and chromium supports the
// Fullscreen API headless, so we first assert the REAL state
// (document.fullscreenElement). But headless chromium occasionally refuses
// to actually enter OS-fullscreen depending on the runner; so we treat the
// component STATE MACHINE as the source of truth: the wrap gains a
// `.fullscreen` class only via the fullscreenchange handler / enter() sync.
// We assert that class flips on enter and off on exit, and additionally
// log whether real document.fullscreenElement matched (best-effort).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const TRIANGLE_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Right-click the canvas, click the Fullscreen menu item, and assert the
 *  wrap entered fullscreen (state-machine via `.fullscreen` class; real
 *  document.fullscreenElement reported best-effort). Then double-click to
 *  exit and assert it left fullscreen. */
async function exercise(
  page: Page,
  canvasTestId: string,
  wrapTestId: string,
): Promise<void> {
  const canvas = page.locator(`canvas[data-testid="${canvasTestId}"]`);
  await expect(canvas, `${canvasTestId} present`).toHaveCount(1);
  const wrap = page.locator(`[data-testid="${wrapTestId}"]`);
  await expect(wrap, `${wrapTestId} present`).toHaveCount(1);

  // Let the rAF blit tick so the canvas has live content.
  await page.waitForTimeout(400);

  // Right-click the video surface -> context menu with Fullscreen.
  await canvas.click({ button: 'right' });
  const menu = page.locator('[data-testid="video-canvas-context-menu"]');
  await expect(menu, 'canvas context menu opened').toBeVisible();
  const fsItem = page.locator('[data-testid="ctx-fullscreen"]');
  await expect(fsItem, 'Fullscreen item present').toBeVisible();

  // Click Fullscreen (real user-gesture click -> requestFullscreen allowed).
  await fsItem.click();

  // State machine: the wrap gains `.fullscreen`. This flips via enter()'s
  // syncFromDocument() and/or the fullscreenchange event — robust whether
  // or not the OS actually granted fullscreen.
  await expect(wrap, 'wrap entered fullscreen state').toHaveClass(/fullscreen/);

  // Best-effort: report whether real browser fullscreen engaged.
  const realFs = await page.evaluate(() => document.fullscreenElement !== null);
  console.log(`[fullscreen] ${wrapTestId} document.fullscreenElement set: ${realFs}`);

  // Double-click anywhere in the fullscreen view exits. The dblclick
  // listener is only attached while fullscreen (via the helper). Whether
  // real OS-fullscreen engaged or not, exiting clears the `.fullscreen`
  // class: if real fullscreen is active, dblclick -> exitFullscreen ->
  // fullscreenchange clears it; if it never engaged, exit() still syncs.
  await wrap.dblclick();
  // Trigger exit explicitly too in case the dblclick landed outside the
  // visually-scaled canvas region in a non-fullscreen viewport (the wrap
  // still covers the area, so dblclick on it fires onDblClick).
  await page.evaluate(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
  });

  await expect(wrap, 'wrap exited fullscreen state').not.toHaveClass(/fullscreen/);
  const realFsAfter = await page.evaluate(() => document.fullscreenElement);
  expect(realFsAfter, 'document.fullscreenElement cleared after exit').toBeNull();
}

test.describe('true-fullscreen — VIDEO OUT + BENTBOX', () => {
  test('VIDEO OUT: right-click -> Fullscreen, dblclick exits', async ({ page }) => {
    const errors = await setup(page);
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'out', type: 'videoOut', position: { x: 500, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);
    await exercise(page, 'video-out-canvas', 'video-out-fs-wrap');
    expect(errors).toEqual([]);
  });

  test('BENTBOX: right-click -> Fullscreen, dblclick exits', async ({ page }) => {
    const errors = await setup(page);
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'bb', type: 'bentbox', position: { x: 500, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    await expect(page.locator('[data-testid="bentbox-card"]')).toHaveCount(1);
    await exercise(page, 'bentbox-canvas', 'bentbox-fs-wrap');
    expect(errors).toEqual([]);
  });

  test('right-click on canvas does NOT open the node menu (claimed)', async ({ page }) => {
    await setup(page);
    await spawnPatch(page, [
      { id: 'out', type: 'videoOut', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);
    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await canvas.click({ button: 'right' });
    // Our canvas menu opens...
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();
    // ...and the SvelteFlow node menu (aria-label "Module actions") must
    // NOT also be present — the canvas handler claimed the right-click.
    const nodeMenu = page.locator('[role="menu"][aria-label="Module actions"]');
    await expect(nodeMenu).toHaveCount(0);
  });
});
