// e2e/tests/warrenspectrum.spec.ts
//
// E2E smoke for WARRENSPECTRUM's cross-domain video output:
// patch ANALOGVCO → WARRENSPECTRUM.in_l, then WARRENSPECTRUM.viz_out
// → OUTPUT.in (audio→video texture bridge). Assert the OUTPUT canvas
// renders a non-uniform image (variance + multiple bright rows —
// guards against the flat-line / all-black failure modes).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('WARRENSPECTRUM viz_out -> OUTPUT', () => {
  test('audio drives the visualizer and OUTPUT canvas renders non-uniform pixels', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'a-vco', type: 'analogVco',     position: { x: 60,  y: 60 },  domain: 'audio' },
        { id: 'a-ws',  type: 'warrenspectrum', position: { x: 320, y: 60 }, domain: 'audio',
          params: { level1: 1, level2: 1, level3: 1, level4: 1, level5: 1, level6: 1, level7: 1, level8: 1, master: 1, viznoise: 0.5 } },
        { id: 'v-out', type: 'videoOut',     position: { x: 760, y: 60 },  domain: 'video' },
      ],
      [
        {
          id: 'e-vco-in',
          from: { nodeId: 'a-vco', portId: 'saw' },
          to:   { nodeId: 'a-ws',  portId: 'in_l' },
          sourceType: 'audio', targetType: 'audio',
        },
        {
          id: 'e-ws-viz',
          from: { nodeId: 'a-ws',  portId: 'viz_out' },
          to:   { nodeId: 'v-out', portId: 'in' },
          sourceType: 'mono-video', targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-warrenspectrum'), 'WARRENSPECTRUM visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    // Let the rAF tick run + viz refresh several frames.
    await page.waitForTimeout(1200);

    const sample = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const w = c.width, h = c.height;
      let s = 0, sq = 0, n = 0;
      const brightRows = new Set<number>();
      const brightCols = new Set<number>();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
          s += v; sq += v * v; n++;
          if (v > 80) {
            brightRows.add(y);
            brightCols.add(x);
          }
        }
      }
      const mean = s / n;
      return {
        mean,
        variance: sq / n - mean * mean,
        brightRows: brightRows.size,
        brightCols: brightCols.size,
      };
    });
    expect(sample).not.toBeNull();
    if (!sample) return;

    // Non-trivial variance — there's color/luminance variation, not a
    // flat black or flat color frame.
    expect(sample.variance, `OUTPUT variance ${sample.variance}`).toBeGreaterThan(50);
    // Distinct rows + columns lit — the EQ bars and waveform draw both
    // span a meaningful subset of the canvas.
    expect(sample.brightRows, `OUTPUT bright rows ${sample.brightRows}`).toBeGreaterThanOrEqual(8);
    expect(sample.brightCols, `OUTPUT bright cols ${sample.brightCols}`).toBeGreaterThanOrEqual(20);

    expect(errors).toEqual([]);
  });
});
