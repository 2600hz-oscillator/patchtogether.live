// e2e/tests/camera-input.spec.ts
//
// CAMERA module — end-to-end demo verification.
//
// Spawns CAMERA → OUTPUT in the patch graph, clicks "Request access" to
// kick off getUserMedia (Chromium answers with the synthetic fake video
// device under --use-fake-device-for-media-stream), and asserts:
//   1. the device dropdown picks up at least the fake device
//   2. the status row reaches "streaming"
//   3. the OUTPUT canvas has non-trivial pixel variance (frames are
//      reaching the engine, getting uploaded as a texture, and rendered
//      through the pass-through shader)
//
// Runs under the `chromium-camera` Playwright project — see
// playwright.config.ts. The fake-camera flag is project-scoped so
// other tests don't accidentally see a synthetic webcam.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('CAMERA → OUTPUT (fake webcam)', () => {
  test('renders the fake device into OUTPUT canvas', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-cam-out',
          from: { nodeId: 'v-cam', portId: 'out' },
          to: { nodeId: 'v-out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-cameraInput'), 'CAMERA visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    // The device dropdown should populate from enumerateDevices on mount.
    // With the fake-device flag, Chromium emits at least one virtual
    // 'videoinput' entry. Wait for it to land before clicking Request.
    const select = page.locator('[data-testid="camera-device-select"]');
    await expect(select).toBeVisible();
    // Give the async refreshDevices() a beat to populate options.
    await page.waitForFunction(() => {
      const el = document.querySelector(
        '[data-testid="camera-device-select"]',
      ) as HTMLSelectElement | null;
      return el ? el.options.length > 0 : false;
    }, undefined, { timeout: 5_000 });

    // Under Chromium's --use-fake-ui-for-media-stream + camera permission
    // pre-granted (project-level), the card's onMount auto-acquire fires
    // because labels are visible immediately and node.params.enabled is 1
    // by default. So the state machine may already be 'streaming' before
    // we get here, OR still 'idle'. Handle both: click Request Access if
    // visible, then wait for streaming. (If it's not visible, we're
    // already in streaming/paused/etc.)
    const requestBtn = page.locator('[data-testid="camera-request-access"]');
    // Only click when the button is actually ENABLED. On a fast machine the
    // onMount auto-acquire has often already fired by the time we get here, so
    // the button is rendered DISABLED and about to detach (it swaps to
    // Pause/Resume) — a force-click then races the detach and hangs the full
    // 30s ("element was detached from the DOM, retrying"). A disabled button
    // means streaming is already on its way, so skip the click and fall through
    // to the streaming wait. The .catch() covers the residual detach-mid-click
    // race when the button WAS enabled at check time.
    if (
      (await requestBtn.count()) > 0 &&
      (await requestBtn.isVisible().catch(() => false)) &&
      (await requestBtn.isEnabled().catch(() => false))
    ) {
      await requestBtn.click({ noWaitAfter: true }).catch(() => {
        /* auto-acquire detached the button — streaming is already starting */
      });
    }

    // Wait for the state machine to reach 'streaming'.
    const status = page.locator('[data-testid="camera-status"]');
    await expect(status).toHaveAttribute('data-state', 'streaming', {
      timeout: 10_000,
    });

    // Allow a few rAF ticks for the engine to upload the texture and
    // render through OUTPUT to the visible canvas.
    await page.waitForTimeout(800);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas, 'video-out canvas in DOM').toHaveCount(1);

    const stats = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const data = img.data;
      let n = 0;
      let sum = 0;
      let sumSq = 0;
      let nonZero = 0;
      let greenAccum = 0;
      let redAccum = 0;
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const v = (r + g + b) / 3;
        sum += v;
        sumSq += v * v;
        if (v > 8) nonZero++;
        greenAccum += g;
        redAccum += r;
        n++;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      return {
        mean,
        variance,
        nonZero,
        samples: n,
        greenMean: greenAccum / n,
        redMean: redAccum / n,
      };
    });

    expect(stats, 'pixel-stats sample').not.toBeNull();
    if (!stats) return;

    // Variance > 50: not a flat colour. A successful camera feed should
    // give us alternating colours from the fake device's spinning ball
    // pattern.
    expect(stats.variance, `variance ${stats.variance} > 50`).toBeGreaterThan(50);
    // Non-zero pixels > 5%: the canvas isn't blank.
    expect(stats.nonZero / stats.samples, 'fraction of bright pixels > 5%').toBeGreaterThan(0.05);

    // Local-only hint must be visible while streaming. The CAMERA stream
    // is not multiplayer-streamed (deferred to a future phase — see
    // .myrobots/plans/module-camera-input.md); the in-card text keeps
    // user expectations honest.
    const localOnlyHint = page.locator('[data-testid="camera-local-only-hint"]');
    await expect(localOnlyHint, 'local-only hint visible while streaming').toBeVisible();
    await expect(localOnlyHint).toContainText(/local only/i);
    await expect(localOnlyHint).toContainText(/won't see/i);

    await page.screenshot({ path: 'test-results/camera-input-demo.png', fullPage: false });

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('shows "no cameras" if enumerateDevices returns empty', async ({ page }) => {
    // Override navigator.mediaDevices.enumerateDevices BEFORE any module
    // mounts so the CAMERA card sees an empty device list. Verifies the
    // 'no-cameras-found' state is reachable from the UI without us
    // having to disable the fake-camera flag at the browser level.
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      const orig = md.enumerateDevices.bind(md);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (md as any).enumerateDevices = async () => {
        const all = await orig();
        // Strip videoinput entries to simulate no camera.
        return all.filter((d) => d.kind !== 'videoinput');
      };
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
    ]);

    const status = page.locator('[data-testid="camera-status"]');
    await expect(status).toHaveAttribute('data-state', 'no-cameras-found', {
      timeout: 5_000,
    });
  });
});
