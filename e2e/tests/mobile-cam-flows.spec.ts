// e2e/tests/mobile-cam-flows.spec.ts
//
// GLITCH CAM (/m/cam) — the interactions the base cam spec doesn't cover:
// the MIRROR toggles write bentbox params + reflect state, a second glitch
// control (GAIN) changes the picture, the ⚙ tray mounts the REAL hidden
// RecorderboxCard, and the overlay auto-hide/tap-wake cycle works. Frames
// come from the deterministic __camerainputTestFrame seam (no getUserMedia);
// pixel asserts are renderer-tolerant (SwiftShader-safe).

import { test, expect } from '@playwright/test';
import { MOBILE_USE, canvasLumaStats, dragSliderBy, nodeParam } from './_mobile-helpers';

test.use(MOBILE_USE);

async function openLive(page: import('@playwright/test').Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const resp = await page.goto('/m/cam');
  expect(resp?.status()).toBe(200);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('m-cam-open').tap();
  await expect(page.getByTestId('m-cam-root')).toHaveAttribute('data-state', 'live', { timeout: 30_000 });
  // A real frame reaches the blit.
  await expect
    .poll(async () => (await canvasLumaStats(page, '[data-testid="m-cam-canvas"]')).litFraction, { timeout: 30_000 })
    .toBeGreaterThan(0.05);
  return errors;
}

/** Wake the (auto-hiding) overlay so its controls are tappable. */
async function wake(page: import('@playwright/test').Page) {
  await page.getByTestId('m-cam-root').tap({ position: { x: 195, y: 200 } });
  await expect(page.getByTestId('m-cam-overlay')).not.toHaveClass(/hidden/);
}

test.describe('glitch cam — controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (globalThis as { __camerainputTestFrame?: boolean }).__camerainputTestFrame = true;
    });
  });

  test('MIRROR X/Y toggle the bentbox params and reflect state', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await openLive(page);
    await wake(page);

    expect((await nodeParam(page, 'bentbox', 'mirrorX')) ?? 0).toBeLessThan(0.5);
    await page.getByTestId('m-cam-mirror-x').tap();
    await expect(page.getByTestId('m-cam-mirror-x')).toHaveClass(/on/);
    await expect.poll(() => nodeParam(page, 'bentbox', 'mirrorX')).toBe(1);

    await page.getByTestId('m-cam-mirror-y').tap();
    await expect(page.getByTestId('m-cam-mirror-y')).toHaveClass(/on/);
    await expect.poll(() => nodeParam(page, 'bentbox', 'mirrorY')).toBe(1);

    // Toggle X back off.
    await page.getByTestId('m-cam-mirror-x').tap();
    await expect.poll(() => nodeParam(page, 'bentbox', 'mirrorX')).toBe(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the glitch sliders write their bentbox params', async ({ page }) => {
    test.setTimeout(90_000);
    await openLive(page);
    await wake(page);
    // Every slider drag must reach the store (relative, drag-committed). Drag
    // each toward one end and assert the param moved in that direction —
    // deterministic (no per-frame-random pixel dependency; the base cam spec
    // covers pixels-change via SOLARIZE).
    const gainBefore = (await nodeParam(page, 'bentbox', 'master_gain')) ?? 1;
    await page.locator('[data-testid="m-cam-slider-master_gain"]').scrollIntoViewIfNeeded();
    await dragSliderBy(page, '[data-testid="m-cam-slider-master_gain"] .hs-track', -0.8);
    await expect.poll(() => nodeParam(page, 'bentbox', 'master_gain')).toBeLessThan(gainBefore - 0.1);

    const noiseBefore = (await nodeParam(page, 'bentbox', 'noise')) ?? 0;
    await page.locator('[data-testid="m-cam-slider-noise"]').scrollIntoViewIfNeeded();
    await dragSliderBy(page, '[data-testid="m-cam-slider-noise"] .hs-track', 0.8);
    await expect.poll(() => nodeParam(page, 'bentbox', 'noise')).toBeGreaterThan(noiseBefore + 0.05);
  });

  test('the ⚙ tray mounts the real RecorderboxCard', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await openLive(page);
    await wake(page);
    await page.getByTestId('m-cam-gear').tap();
    await expect(page.getByTestId('m-cam-tray')).toHaveClass(/open/);
    // The hidden-but-mounted RecorderboxCard runs the real record pipeline.
    await expect(
      page.locator('[data-testid="cardstage"][data-node-type="recorderbox"]'),
    ).toBeVisible({ timeout: 15_000 });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('glitch cam — overlay', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (globalThis as { __camerainputTestFrame?: boolean }).__camerainputTestFrame = true;
    });
  });

  test('overlay auto-hides then a tap wakes it', async ({ page }) => {
    test.setTimeout(90_000);
    await openLive(page);
    await wake(page); // resets the 3s auto-hide timer with uiState=live
    await expect(page.getByTestId('m-cam-overlay')).toHaveClass(/hidden/, { timeout: 6_000 });
    await page.getByTestId('m-cam-root').tap({ position: { x: 195, y: 400 } });
    await expect(page.getByTestId('m-cam-overlay')).not.toHaveClass(/hidden/);
    // The exit affordance is present in the overlay.
    await expect(page.getByTestId('m-cam-exit')).toBeVisible();
  });
});
