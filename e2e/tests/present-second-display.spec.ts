// e2e/tests/present-second-display.spec.ts
//
// "Present an OUTPUT on a second display" — a SEPARATE popup window placed +
// fullscreened on display 2, fed the OUTPUT card's live canvas via
// captureStream, while the main patcher stays interactive on display 1
// (unlike true fullscreen, which relocates the whole tab).
//
// Real multi-monitor + window.open + the Window Management API can't run in
// headless CI, so we assert two contracts deterministically:
//   1. SINGLE-SCREEN / unsupported (the CI default): the canvas right-click
//      menu shows NO "Present on …" entry — the feature capability-gates off
//      and nothing throws (the safe no-op path that CI actually exercises).
//   2. MULTI-SCREEN (injected): with a fake window.getScreenDetails returning
//      2 screens (the SAME init-script pattern the multimonitor fullscreen
//      spec uses) + a stubbed window.open + canvas.captureStream, the menu
//      shows a "Present on <secondary>" entry, clicking it calls window.open
//      with a /present popup, and a "Stop presenting" entry then appears and
//      closes the popup. We gate the multi-screen assertions on the injected
//      capability so they're deterministic.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const TRIANGLE_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

/** Inject a fake Window Management API returning `screens`, plus a stubbed
 *  window.open recording its args and a fake canvas.captureStream — so we can
 *  drive the present flow without a real second monitor / popup. */
async function injectPresentEnv(
  page: Page,
  screens: Array<{ label: string; isPrimary: boolean }>,
): Promise<void> {
  await page.addInitScript((screensArg) => {
    const fakeScreens = screensArg.map((s, i) => ({
      label: s.label,
      isPrimary: s.isPrimary,
      // Working-area geometry so getScreenRect() resolves popup placement.
      availLeft: i === 0 ? 0 : 1920,
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

    // Record window.open calls + return a controllable fake popup so the
    // present controller's handshake + teardown can run headlessly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__openCalls = [];
    const fakePopup = {
      closed: false,
      close() {
        this.closed = true;
      },
      postMessage() {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      __presentStream: undefined as any,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__fakePopup = fakePopup;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).open = (url: string, target: string, features: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__openCalls.push({ url, target, features });
      return fakePopup;
    };

    // Fake captureStream on the canvas prototype so the OUTPUT card's canvas
    // yields a stoppable stream (headless 2D canvases may lack it).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__stoppedTracks = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).captureStream = function () {
      return {
        getTracks: () => [
          {
            stop() {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as any).__stoppedTracks++;
            },
          },
        ],
      };
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

test.describe('present on a second display — VIDEO OUT', () => {
  test('single screen / unsupported -> NO "Present on …" entry (safe no-op, CI path)', async ({ page }) => {
    // Only one fake display -> capability-gated off (same as a real
    // single-monitor or a browser without getScreenDetails).
    await injectPresentEnv(page, [{ label: 'Only Display', isPrimary: true }]);
    await setup(page);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();

    // No present entries at all on a single screen; nothing thrown.
    await expect(page.locator('[data-testid^="ctx-present-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ctx-stop-present"]')).toHaveCount(0);
  });

  test('two screens -> "Present on <secondary>" opens a /present popup; "Stop presenting" closes it', async ({ page }) => {
    await injectPresentEnv(page, [
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

    // Click it -> window.open('/present', ...) with a popup feature string.
    await presentSec.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const calls = (window as any).__openCalls as Array<{ url: string; features: string }>;
          return calls.length > 0 ? calls[calls.length - 1] : null;
        }),
      )
      .toMatchObject({ url: '/present', features: expect.stringContaining('popup') });
    // Features carry the secondary screen's placement (left=1920).
    const lastOpen = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls = (window as any).__openCalls as Array<{ features: string }>;
      return calls[calls.length - 1].features;
    });
    expect(lastOpen).toContain('left=1920');

    // Re-open the menu -> "Stop presenting" now shows.
    await canvas.click({ button: 'right' });
    const stop = page.locator('[data-testid="ctx-stop-present"]');
    await expect(stop).toBeVisible();
    await stop.click();

    // Stopping closes the fake popup AND releases the captured track.
    await expect
      .poll(() =>
        page.evaluate(() => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          closed: (window as any).__fakePopup.closed as boolean,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stopped: (window as any).__stoppedTracks as number,
        })),
      )
      .toMatchObject({ closed: true, stopped: 1 });

    // "Stop presenting" is gone again after stopping.
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="ctx-stop-present"]')).toHaveCount(0);
  });
});

test.describe('present sink route', () => {
  test('/present renders a black sink that posts ready to its opener', async ({ page }) => {
    // The sink with no opener just shows the "waiting for stream" affordance
    // (it never gets a stream), proving the route loads chrome-less + safe.
    await page.goto('/present');
    await expect(page.locator('[data-testid="present-root"]')).toBeVisible();
    await expect(page.locator('[data-testid="present-video"]')).toBeAttached();
    await expect(page.locator('[data-testid="present-waiting"]')).toBeVisible();
  });
});
