// e2e/tests/present-second-display.spec.ts
//
// "Present an OUTPUT on a second display" — a SEPARATE popup window placed on
// display 2, into which the OPENER blits the OUTPUT card's live canvas every
// frame (a direct same-origin canvas → canvas drawImage; no MediaStream, no
// <video>, no autoplay/fullscreen gesture). The main patcher stays interactive
// on display 1 (unlike true fullscreen, which relocates the whole tab).
//
// Real multi-monitor + the Window Management API can't run in headless CI, so
// we inject a fake window.getScreenDetails (2 screens) for placement. But the
// blit PIPELINE itself is fully exercisable: we let the REAL window.open open
// the REAL /present popup (captured via Playwright's popup event), wait for the
// OUTPUT card to render its source canvas, and assert the popup's
// `present-canvas` receives a NON-BLACK frame — which is exactly the failure
// the captureStream→<video> pipeline produced on real hardware (a black popup).
//
// We assert three contracts deterministically:
//   1. SINGLE-SCREEN / unsupported (the CI default): the canvas right-click
//      menu shows NO "Present on …" entry — the feature capability-gates off
//      and nothing throws.
//   2. MULTI-SCREEN (injected): a "Present on <secondary>" entry shows, clicking
//      it opens a REAL /present popup, and that popup's canvas gets non-black
//      pixels (the blit pipeline works end-to-end). "Stop presenting" then
//      closes the popup.
//   3. The /present route loads chrome-less + safe with no opener.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const TRIANGLE_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

/** Inject a fake Window Management API returning `screens` so the present menu
 *  capability-gates on + getScreenRect() resolves popup placement. We do NOT
 *  stub window.open here — the real popup must open so we can read its canvas. */
async function injectScreens(
  page: Page,
  screens: Array<{ label: string; isPrimary: boolean }>,
): Promise<void> {
  await page.addInitScript((screensArg) => {
    const fakeScreens = screensArg.map((s, i) => ({
      label: s.label,
      isPrimary: s.isPrimary,
      // Working-area geometry so getScreenRect() resolves popup placement.
      // Keep the secondary placement inside the test viewport so the popup is
      // actually creatable + visible to Playwright (left=0 second screen).
      availLeft: 0,
      availTop: 0,
      availWidth: 1920,
      availHeight: 1080,
    }));
    const details: EventTarget & { screens: unknown[]; currentScreen: unknown } =
      Object.assign(new EventTarget(), {
        screens: fakeScreens,
        currentScreen: fakeScreens[0],
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).getScreenDetails = () => Promise.resolve(details);
  }, screens);
}

async function setup(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
      { id: 'out', type: 'videoOut', position: { x: 500, y: 40 }, domain: 'video' },
    ],
    [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
  );
  await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);
  // Let the OUTPUT card's rAF render the source frame into its canvas.
  await page.waitForTimeout(500);
}

/** Read whether a canvas locator has ANY non-black pixel. We sample the canvas
 *  pixels in-page (it's same-origin, so getImageData is allowed). */
async function canvasHasNonBlackPixel(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(
      '[data-testid="present-canvas"]',
    );
    if (!c || c.width < 2 || c.height < 2) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    // Any pixel whose RGB is meaningfully above black => the blit landed.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 16 || data[i + 1] > 16 || data[i + 2] > 16) return true;
    }
    return false;
  });
}

test.describe('present on a second display — VIDEO OUT', () => {
  test('single screen / unsupported -> NO "Present on …" entry (safe no-op, CI path)', async ({ page }) => {
    // Only one fake display -> capability-gated off (same as a real
    // single-monitor or a browser without getScreenDetails).
    await injectScreens(page, [{ label: 'Only Display', isPrimary: true }]);
    await setup(page);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();

    // No present entries at all on a single screen; nothing thrown.
    await expect(page.locator('[data-testid^="ctx-present-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ctx-stop-present"]')).toHaveCount(0);
  });

  test('two screens -> "Present on <secondary>" opens a REAL /present popup that gets a NON-BLACK frame', async ({ page, context }) => {
    await injectScreens(page, [
      { label: 'Built-in Retina', isPrimary: true },
      { label: 'DELL U2720Q', isPrimary: false },
    ]);
    await setup(page);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();

    // "Present on …" appears only for the NON-current (secondary) display.
    const presentSec = page.locator('[data-testid="ctx-present-display-1"]');
    await expect(presentSec).toBeVisible();
    await expect(presentSec).toHaveText(/Present on DELL U2720Q/);
    // Never offer presenting on THIS (primary) display.
    await expect(page.locator('[data-testid="ctx-present-primary"]')).toHaveCount(0);

    // Click it -> the REAL window.open fires a popup; capture the popup Page.
    const popupPromise = context.waitForEvent('page');
    await presentSec.click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');

    // The popup is the chrome-less /present sink with a present-canvas.
    expect(popup.url()).toContain('/present');
    await expect(popup.locator('[data-testid="present-canvas"]')).toBeAttached();

    // THE BUG FIX ASSERTION: the opener blits the OUTPUT canvas into the popup's
    // canvas every frame, so it must show NON-BLACK pixels (the captureStream→
    // <video> pipeline produced an all-black popup here). Poll: the first blit
    // lands a frame or two after the popup's `present:ready` handshake.
    await expect
      .poll(() => canvasHasNonBlackPixel(popup), { timeout: 8000 })
      .toBe(true);

    // Re-open the menu on the opener -> "Stop presenting" now shows + closes it.
    await canvas.click({ button: 'right' });
    const stop = page.locator('[data-testid="ctx-stop-present"]');
    await expect(stop).toBeVisible();

    const popupClosed = popup.waitForEvent('close');
    await stop.click();
    await popupClosed;
    expect(popup.isClosed()).toBe(true);

    // "Stop presenting" is gone again after stopping.
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="ctx-stop-present"]')).toHaveCount(0);
  });
});

test.describe('present sink route', () => {
  test('/present renders a black chrome-less canvas sink', async ({ page }) => {
    // The sink with no opener just shows its black canvas (it never gets drawn
    // into), proving the route loads chrome-less + safe.
    await page.goto('/present');
    await expect(page.locator('[data-testid="present-root"]')).toBeVisible();
    await expect(page.locator('[data-testid="present-canvas"]')).toBeAttached();
  });
});
