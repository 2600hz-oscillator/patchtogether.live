// e2e/tests/vfpga-runner.spec.ts
//
// vfpga-runner host module — preset hot-swap. The deterministic render-smoke
// (the default smpte-bars VFPGA reaches a non-black, structured OUTPUT) now
// lives in vfpga-runner-render-smoke.spec.ts (frozen clock + paused rAF, frame-
// stable — strictly stronger than the old wall-clock sample-once, which was
// deleted here in the GPU-attest rebuild Phase 3). This file keeps the UNIQUE
// non-render path: the load-preset menu lists smpte-bars and re-applying it
// hot-swaps without crash/blank, with a renderer-tolerant OUTPUT floor.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** OUTPUT canvas pixel stats — the OUTPUT card blits its sampled FBO texture
 *  into the engine canvas then drawImage()s it, so this reads what vfpga-runner
 *  produced through the downstream chain. */
async function outputStats(page: Page): Promise<{ nonZeroFrac: number; variance: number } | null> {
  const canvas = page.locator('[data-testid="video-out-canvas"]');
  await expect(canvas, 'video-out canvas mounted').toHaveCount(1);
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
    }
    const mean = sum / n;
    return { nonZeroFrac: nonZero / n, variance: sumSq / n - mean * mean };
  });
}

test.describe('vfpga-runner host module', () => {
  test('the load-preset menu lists smpte-bars and re-applies it (hot-swap stays valid)', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'vf', type: 'vfpgaRunner', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 600, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'vf', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    const select = page.locator('[data-testid="vfpga-preset"]');
    await expect(select).toHaveCount(1);
    // The menu offers smpte-bars as a loadable preset.
    await expect(select.locator('option', { hasText: 'SMPTE bars' })).toHaveCount(1);

    // Re-apply it (hot-swap to the same effect) — the loaded readout stays put
    // and the OUTPUT is still the bars (no crash, no blank).
    await select.selectOption('smpte-bars');
    await expect(page.locator('[data-testid="vfpga-loaded"]')).toHaveText('SMPTE bars');

    let stats = await outputStats(page);
    for (let i = 0; i < 40 && (!stats || stats.nonZeroFrac <= 0.05); i++) {
      await page.waitForTimeout(150);
      stats = await outputStats(page);
    }
    expect(stats!.nonZeroFrac, 'bars still render after re-applying the preset').toBeGreaterThan(0.3);
  });
});
