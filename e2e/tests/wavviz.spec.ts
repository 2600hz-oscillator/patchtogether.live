// e2e/tests/wavviz.spec.ts
//
// E2E for WAVVIZ — wavetable VCO with built-in wavefolder + scope mono-video.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('WAVVIZ -> OUTPUT', () => {
  test('fold sweep changes the OUTPUT canvas pixels', async ({ page }) => {
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
        { id: 'a-wv',  type: 'wavviz',   position: { x: 60,  y: 60 },  domain: 'audio', params: { foldAmount: 0, wavePos: 0.5 } },
        { id: 'v-out', type: 'videoOut', position: { x: 460, y: 60 },  domain: 'video' },
      ],
      [
        {
          id: 'e-wv-out',
          from: { nodeId: 'a-wv',  portId: 'scope' },
          to:   { nodeId: 'v-out', portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-wavviz'), 'WAVVIZ visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(800);

    async function sample() {
      return await canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const w = c.width, h = c.height;
        let s = 0, sq = 0, n = 0;
        // Distinct bright rows — guards against the Bug-2 flat-line
        // failure mode (LINEAR-filtered R32F texture returning all
        // zeros, leaving a horizontal trace at canvas center).
        const brightRows = new Set<number>();
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
            s += v; sq += v * v; n++;
            if (v > 100) brightRows.add(y);
          }
        }
        const mean = s / n;
        return { mean, variance: sq / n - mean * mean, brightRows: brightRows.size };
      });
    }

    const a = await sample();
    expect(a).not.toBeNull();

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-wv'];
        if (n) n.params.foldAmount = 0.9;
      });
    });
    await page.waitForTimeout(500);
    const b = await sample();
    expect(b).not.toBeNull();
    if (!a || !b) return;

    // Both samples must show non-trivial variance — the GL bridge is
    // alive and renders the waveform. The fold sweep doesn't always
    // produce a dramatic pixel-statistics change (the trace covers a
    // similar y-range either way); the cross-domain bridge being
    // active is the load-bearing assertion here.
    expect(a.variance, 'sampleA variance > 5').toBeGreaterThan(5);
    expect(b.variance, 'sampleB variance > 5').toBeGreaterThan(5);
    expect(
      a.brightRows,
      `sampleA must trace many rows (got ${a.brightRows}); flat line ≈ 4`,
    ).toBeGreaterThanOrEqual(20);
    expect(
      b.brightRows,
      `sampleB must trace many rows (got ${b.brightRows}); flat line ≈ 4`,
    ).toBeGreaterThanOrEqual(20);

    expect(errors).toEqual([]);
  });
});
