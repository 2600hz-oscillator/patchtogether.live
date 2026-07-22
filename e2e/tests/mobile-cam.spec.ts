// e2e/tests/mobile-cam.spec.ts
//
// GLITCH CAM (/m/cam) — deterministic render + capability-gated record.
//
//   - Camera frames come from the __camerainputTestFrame init-script seam
//     (camera-input.ts): the module uploads a fixed synthetic checker with
//     NO getUserMedia — the full GL path (upload → camera shader → bentbox
//     chain → blit) runs deterministically on CI's SwiftShader.
//   - Pixel asserts are RENDERER-TOLERANT (lit-fraction/mean-luma over a
//     coarse grid, never exact pixels).
//   - ALL record asserts are gated on the page's own encoder probe
//     (probeEncoders → data-can-record) — CI has no OS H.264 encoder
//     (recorderbox #687 precedent), so 'false' asserts the DISABLED state.

import { test, expect } from '@playwright/test';
import { MOBILE_USE, canvasLumaStats, dragSliderBy } from './_mobile-helpers';

test.use(MOBILE_USE);

test.describe('glitch cam — deterministic frame + glitch strip', () => {
  test.beforeEach(async ({ page }) => {
    // The deterministic-frame seam MUST be set before the page scripts run.
    await page.addInitScript(() => {
      (globalThis as { __camerainputTestFrame?: boolean }).__camerainputTestFrame = true;
    });
  });

  test('opens live, renders non-black, SOLARIZE changes the picture, REC is capability-gated', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const resp = await page.goto('/m/cam');
    expect(resp?.status()).toBe(200);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('canvas-root')).toHaveCount(0);

    // ── One tap opens the camera (test-frame seam: no getUserMedia) ──
    await page.getByTestId('m-cam-open').tap();
    await expect(page.getByTestId('m-cam-root')).toHaveAttribute('data-state', 'live', {
      timeout: 30_000,
    });

    // ── The fullscreen canvas shows a real picture (renderer-tolerant) ──
    await expect
      .poll(async () => (await canvasLumaStats(page, '[data-testid="m-cam-canvas"]')).litFraction, {
        timeout: 30_000,
        message: 'display canvas is non-black (camera frame reached the blit)',
      })
      .toBeGreaterThan(0.05);
    const before = await canvasLumaStats(page, '[data-testid="m-cam-canvas"]');

    // ── SOLARIZE (wavefold 0→1) visibly changes the picture ──
    // Wake the overlay first (it auto-hides after 3s), then drag.
    await page.getByTestId('m-cam-root').tap({ position: { x: 195, y: 200 } });
    await expect(page.getByTestId('m-cam-glitch-strip')).toBeVisible();
    await dragSliderBy(page, '[data-testid="m-cam-slider-wavefold"] .hs-track', 1.0);
    await expect
      .poll(
        async () => {
          const after = await canvasLumaStats(page, '[data-testid="m-cam-canvas"]');
          return Math.abs(after.meanLuma - before.meanLuma);
        },
        { timeout: 15_000, message: 'SOLARIZE shifts the mean luma' },
      )
      .toBeGreaterThan(4);

    // ── REC — strictly capability-gated (no OS H.264 encoder on CI) ──
    const rec = page.getByTestId('m-cam-rec');
    await expect(rec).toHaveAttribute('data-can-record', /true|false/, { timeout: 30_000 });
    const canRecord = (await rec.getAttribute('data-can-record')) === 'true';
    if (!canRecord) {
      // Degraded state: disabled button + the "no encoder" caption, no crash.
      await expect(rec).toBeDisabled();
      await expect(page.getByTestId('m-cam-no-encoder')).toBeVisible();
    } else {
      // Real encoder available (local dev): a short record round-trip through
      // the hidden RecorderboxCard's own lifecycle.
      await page.getByTestId('m-cam-root').tap({ position: { x: 195, y: 200 } });
      await rec.tap();
      await expect(rec).toHaveAttribute('data-recording', 'true');
      await expect(page.getByTestId('m-cam-rec-elapsed')).toBeVisible();
      await page.waitForTimeout(1200);
      await page.getByTestId('m-cam-root').tap({ position: { x: 195, y: 200 } });
      await rec.tap();
      await expect(rec).toHaveAttribute('data-recording', 'false', { timeout: 20_000 });
    }

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });
});
