// e2e/tests/video-fullscreen-multimonitor.spec.ts
//
// Multi-monitor fullscreen for video displays (Window Management API).
// On Chromium with window.getScreenDetails(), the canvas right-click menu
// offers a "Fullscreen on …" entry PER display so a video display can go
// fullscreen on a secondary monitor while the app keeps running on the
// primary. We can't actually move monitors in headless, so we:
//   - inject a FAKE window.getScreenDetails returning 2 fake screens before
//     the app loads (also stubs the permission so no prompt fires), and
//   - spy on Element.prototype.requestFullscreen to record the options it
//     receives (so we can assert a `{ screen }` arg was passed).
//
// We also cover the single-screen case (fake getScreenDetails -> 1 screen)
// to prove the menu still shows the classic single "Fullscreen" item.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const TRIANGLE_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

/** Inject a fake Window Management API + a requestFullscreen spy before load.
 *  `screens` is the list the fake getScreenDetails returns. The spy records
 *  every requestFullscreen call's options (including whether `screen` was a
 *  real ScreenDetailed object) on window.__fsCalls. */
async function injectScreens(
  page: Page,
  screens: Array<{ label: string; isPrimary: boolean }>,
): Promise<void> {
  await page.addInitScript((screensArg) => {
    // Build fake ScreenDetailed objects + a ScreenDetails EventTarget.
    const fakeScreens = screensArg.map((s) => ({
      label: s.label,
      isPrimary: s.isPrimary,
      // geometry fields the spec carries; harmless extras here.
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
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

    // Spy on requestFullscreen to record options. We mark whether a `screen`
    // option was passed and its label so the test can assert targeting.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__fsCalls = [];
    const orig = Element.prototype.requestFullscreen;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Element.prototype.requestFullscreen = function (opts?: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__fsCalls.push({
        hasScreen: !!(opts && opts.screen),
        screenLabel: opts && opts.screen ? opts.screen.label : null,
      });
      // Call through but swallow rejection — headless can't grant OS fullscreen
      // on a fake screen, and that's fine: we assert the CALL, not the result.
      try {
        return orig.call(this, opts).catch(() => {});
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch {
        return Promise.resolve();
      }
    };
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
  await page.waitForTimeout(300);
}

test.describe('multi-monitor fullscreen — VIDEO OUT', () => {
  test('two screens -> per-display "Fullscreen on …" items; secondary passes a screen arg', async ({ page }) => {
    await injectScreens(page, [
      { label: 'Built-in Retina', isPrimary: true },
      { label: 'DELL U2720Q', isPrimary: false },
    ]);
    await setup(page);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await canvas.click({ button: 'right' });
    const menu = page.locator('[data-testid="video-canvas-context-menu"]');
    await expect(menu).toBeVisible();

    // Per-display items: primary reads "THIS DISPLAY", secondary uses its label.
    const primaryItem = page.locator('[data-testid="ctx-fullscreen-primary"]');
    const secItem = page.locator('[data-testid="ctx-fullscreen-display-1"]');
    await expect(primaryItem).toBeVisible();
    await expect(primaryItem).toHaveText(/THIS DISPLAY/i);
    await expect(secItem).toBeVisible();
    await expect(secItem).toHaveText(/DELL U2720Q/);
    // The single classic item must NOT be present in multi-monitor mode.
    await expect(page.locator('[data-testid="ctx-fullscreen"]')).toHaveCount(0);

    // Click the secondary display -> requestFullscreen called with a screen.
    await secItem.click();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const calls = (window as any).__fsCalls as Array<{ hasScreen: boolean; screenLabel: string | null }>;
          return calls.length > 0 ? calls[calls.length - 1] : null;
        }),
      )
      .toMatchObject({ hasScreen: true, screenLabel: 'DELL U2720Q' });
  });

  test('clicking "THIS DISPLAY" requests plain fullscreen (no screen arg)', async ({ page }) => {
    await injectScreens(page, [
      { label: 'Built-in Retina', isPrimary: true },
      { label: 'DELL U2720Q', isPrimary: false },
    ]);
    await setup(page);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await canvas.click({ button: 'right' });
    await page.locator('[data-testid="ctx-fullscreen-primary"]').click();

    await expect
      .poll(async () =>
        page.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const calls = (window as any).__fsCalls as Array<{ hasScreen: boolean }>;
          return calls.length > 0 ? calls[calls.length - 1] : null;
        }),
      )
      .toMatchObject({ hasScreen: false });
  });

  test('single screen -> classic single "Fullscreen" item (unchanged)', async ({ page }) => {
    await injectScreens(page, [{ label: 'Only Display', isPrimary: true }]);
    await setup(page);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();

    // Exactly the classic single item; no per-display entries.
    await expect(page.locator('[data-testid="ctx-fullscreen"]')).toBeVisible();
    await expect(page.locator('[data-testid="ctx-fullscreen-primary"]')).toHaveCount(0);
  });
});
