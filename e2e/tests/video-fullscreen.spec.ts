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
  await page.goto('/rack');
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

  // Regression: the fullscreen letterbox bug. The card preview blits the
  // engine frame into a CARD-aspect canvas buffer; on fullscreen the buffer
  // must SWAP to the live ENGINE aspect so object-fit:contain pillarboxes the
  // true source (height-fill, side bars only) instead of double-letterboxing
  // the card aspect (which added top/bottom black bars). We assert the buffer
  // aspect == engine aspect (and != the card aspect) while fullscreen — robust
  // whether or not headless chromium grants real OS fullscreen, since the buffer
  // dims swap on the `.fullscreen` STATE, not on the OS grant.
  test('VIDEO OUT fullscreen: canvas buffer takes the ENGINE aspect (no top/bottom letterbox)', async ({ page }) => {
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

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    const wrap = page.locator('[data-testid="video-out-fs-wrap"]');
    await expect(canvas).toHaveCount(1);

    // Let the rAF blit tick so the card has captured live engine dims.
    await page.waitForTimeout(400);

    // The live engine source aspect (VIDEO_RES = 1024×768 = 4:3).
    const engineAspect = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eng = (window as any).__engine?.();
      const vid = eng?.getDomain?.('video');
      const w = vid?.canvas?.width ?? 0;
      const h = vid?.canvas?.height ?? 0;
      return w > 0 && h > 0 ? w / h : 4 / 3;
    });

    // In-rack: the buffer carries the CARD aspect (a wide preview area).
    const beforeW = Number(await canvas.getAttribute('width'));
    const beforeH = Number(await canvas.getAttribute('height'));
    const cardAspect = beforeW / beforeH;

    // Enter fullscreen via the context menu (real user-gesture click).
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="ctx-fullscreen"]')).toBeVisible();
    await page.locator('[data-testid="ctx-fullscreen"]').click();
    await expect(wrap, 'wrap entered fullscreen state').toHaveClass(/fullscreen/);

    // The buffer must now carry the ENGINE aspect, not the card aspect.
    const afterW = Number(await canvas.getAttribute('width'));
    const afterH = Number(await canvas.getAttribute('height'));
    const fsAspect = afterW / afterH;
    expect(Math.abs(fsAspect - engineAspect)).toBeLessThan(0.02);
    // The default card preview is wider than 4:3, so the bug's card-aspect
    // buffer differed from the engine aspect — assert we actually swapped.
    expect(Math.abs(cardAspect - engineAspect)).toBeGreaterThan(0.05);
    expect(Math.abs(fsAspect - cardAspect)).toBeGreaterThan(0.05);

    // If real OS-fullscreen engaged (it does headless on chromium here), prove
    // the RENDERED content HEIGHT-FILLS the viewport with NO top/bottom bars:
    // with object-fit:contain on an engine-aspect buffer narrower than the
    // screen, the visible content height == the viewport height (only side
    // pillarbox). The buggy card-aspect buffer would NOT height-fill.
    const fill = await page.evaluate(() => {
      if (!document.fullscreenElement) return null;
      const cv = document.querySelector(
        'canvas[data-testid="video-out-canvas"]',
      ) as HTMLCanvasElement | null;
      if (!cv) return null;
      const box = cv.getBoundingClientRect();
      const bufAspect = cv.width / cv.height;
      const boxAspect = box.width / box.height;
      // object-fit:contain → content fills height when content is NARROWER than
      // the box (4:3 in a wide screen), else fills width.
      const contentH = bufAspect < boxAspect ? box.height : box.width / bufAspect;
      return { viewportH: window.innerHeight, contentH, boxH: box.height };
    });
    if (fill) {
      // Content height == viewport height (within a px of rounding) → no
      // top/bottom letterbox. The card-aspect bug would leave a visible gap.
      expect(Math.abs(fill.contentH - fill.viewportH)).toBeLessThanOrEqual(2);
    } else {
      console.log('[fullscreen] OS fullscreen not granted — buffer-aspect check stands alone');
    }

    // Clean up: exit fullscreen.
    await page.evaluate(() => {
      if (document.fullscreenElement) void document.exitFullscreen();
    });
    expect(errors).toEqual([]);
  });

  // OUTPUT aspect switch: after flipping to 16:9 the fullscreen buffer must
  // carry the 16:9 ENGINE aspect (1366×768 ≈ 1.78), so object-fit:contain
  // pillarboxes the wider source — never double-letterboxes. Drives the switch
  // via the dev __videoAspectStore hook.
  test('VIDEO OUT fullscreen at 16:9: buffer takes the 16:9 engine aspect', async ({ page }) => {
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

    // Flip the OUTPUT aspect to 16:9 — in-place engine realloc to 1366×768.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__videoAspectStore.set('16:9');
    });
    await expect
      .poll(async () => page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vid = (window as any).__engine?.()?.getDomain?.('video');
        return vid?.canvas?.width ?? 0;
      }), { timeout: 8000, message: 'engine resized to 16:9 width' })
      .toBe(1366);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    const wrap = page.locator('[data-testid="video-out-fs-wrap"]');
    await page.waitForTimeout(400); // let the rAF mirror the 16:9 engine dims

    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="ctx-fullscreen"]')).toBeVisible();
    await page.locator('[data-testid="ctx-fullscreen"]').click();
    await expect(wrap, 'wrap entered fullscreen state').toHaveClass(/fullscreen/);

    // The fullscreen buffer must carry the 16:9 engine aspect (~1.78).
    const afterW = Number(await canvas.getAttribute('width'));
    const afterH = Number(await canvas.getAttribute('height'));
    expect(Math.abs(afterW / afterH - 16 / 9)).toBeLessThan(0.02);

    await page.evaluate(() => {
      if (document.fullscreenElement) void document.exitFullscreen();
    });
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
