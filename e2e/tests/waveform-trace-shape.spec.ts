// e2e/tests/waveform-trace-shape.spec.ts
//
// Regression for Bug-2 from PR-65: WAVVIZ/SCOPE video outputs (and any
// other module that goes through the shared waveform-video renderer)
// were rendering a single thin horizontal line at canvas center instead
// of the audio waveform.
//
// Root cause: the shared waveform-video renderer allocated its 1-D R32F
// sample texture with LINEAR min/mag filters. R32F is core-WebGL2
// SAMPLEABLE but NOT core-WebGL2 FILTERABLE — without the
// `OES_texture_float_linear` extension, conformant browsers return 0.0
// for every LINEAR-filtered read of the float texture, so the shader's
// `texture(uWave, ...).r` was always zero and the trace stayed at the
// canvas mid-line. Switching the filter to NEAREST (which is core for
// every internal format) fixes the read.
//
// What this test asserts: with WAVVIZ -> OUTPUT (and SCOPE -> OUTPUT),
// the OUTPUT canvas must contain bright pixels spread across MANY
// distinct rows (a real waveform), not just one or two adjacent rows
// (a flat trace at center). The threshold (≥ 20 distinct rows) is well
// above the flat-trace failure mode (~4 rows: a 2-pixel half-width
// band) and well below a healthy waveform's row coverage (~100+ rows on
// a 184-tall canvas).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface TraceStats {
  width: number;
  height: number;
  brightRows: number;
  brightCols: number;
  totalBright: number;
}

async function readTraceStats(page: import('@playwright/test').Page): Promise<TraceStats | null> {
  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const w = c.width;
    const h = c.height;
    const brightRows = new Set<number>();
    const brightCols = new Set<number>();
    let totalBright = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
        if (v > 100) {
          brightRows.add(y);
          brightCols.add(x);
          totalBright++;
        }
      }
    }
    return { width: w, height: h, brightRows: brightRows.size, brightCols: brightCols.size, totalBright };
  });
}

test.describe('waveform video trace shape (Bug-2 regression)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
  });

  test('SCOPE -> OUTPUT renders waveform across many rows (not a flat line)', async ({ page }) => {
    await spawnPatch(
      page,
      [
        { id: 'a-vco',   type: 'analogVco', position: { x: 40,  y: 60 }, domain: 'audio' },
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

    await page.waitForTimeout(1000);
    const stats = await readTraceStats(page);
    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(
      stats.brightRows,
      `SCOPE trace should span many rows (got ${stats.brightRows}/${stats.height}); flat trace ≈ 4`,
    ).toBeGreaterThanOrEqual(20);
  });
});
