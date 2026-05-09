// e2e/tests/scope-video-out.spec.ts
//
// E2E for SCOPE's new mono-video output port. Spawn ANALOG-VCO ->
// SCOPE.ch1, SCOPE.out -> OUTPUT, hit play, assert OUTPUT canvas
// shows non-zero pixel variance reflecting the audio waveform.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('SCOPE.out (mono-video) -> OUTPUT', () => {
  test('SCOPE patched into OUTPUT renders a waveform trace', async ({ page }) => {
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
        { id: 'a-vco',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
        { id: 'a-scope', type: 'scope',     position: { x: 280, y: 60 }, domain: 'audio' },
        { id: 'v-out',   type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-vco-scope',
          from: { nodeId: 'a-vco', portId: 'saw' },
          to:   { nodeId: 'a-scope', portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
        {
          id: 'e-scope-out',
          from: { nodeId: 'a-scope', portId: 'out' },
          to:   { nodeId: 'v-out', portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-scope'), 'SCOPE visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    // SCOPE card must render the new `out` handle (io-spec consistency
    // covers this elsewhere; cheap sanity here too).
    const scopeCard = page.locator('.svelte-flow__node-scope');
    const outHandle = scopeCard.locator('[data-handleid="out"]');
    await expect(outHandle, 'scope.out handle present').toHaveCount(1);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(900);

    const stats = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const w = c.width, h = c.height;
      let n = 0, sum = 0, sumSq = 0, nonZero = 0;
      // Trace shape: a flat line at canvas center occupies just a few
      // adjacent rows. A real waveform spans many distinct rows. Counting
      // bright rows catches the Bug-2 regression (LINEAR-filtered R32F
      // texture returning all-zeros under WebGL2 without
      // OES_texture_float_linear, which silently produced a flat trace
      // that still passed a bare variance>5 assertion).
      const brightRows = new Set<number>();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
          sum += v; sumSq += v * v;
          if (v > 8) nonZero++;
          if (v > 100) brightRows.add(y);
          n++;
        }
      }
      const mean = sum / n;
      return { mean, variance: sumSq / n - mean * mean, nonZero, n, brightRows: brightRows.size };
    });

    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.variance, `variance ${stats.variance} > 5`).toBeGreaterThan(5);
    expect(stats.nonZero / stats.n, 'fraction bright > 1%').toBeGreaterThan(0.01);
    expect(
      stats.brightRows,
      `trace must span many rows, not just a flat line at center (got ${stats.brightRows})`,
    ).toBeGreaterThanOrEqual(20);

    expect(errors).toEqual([]);
  });
});
