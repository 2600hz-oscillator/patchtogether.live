// e2e/tests/wavecel-viz.spec.ts
//
// E2E for the WAVECEL on-card 3D visualizer reactivity:
//  1. Morph CV modulation moves the white highlight across frames.
//  2. Spread > 1 widens the highlight (more bright pixels).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function sampleCanvas(page: import('@playwright/test').Page) {
  const canvas = page.locator('canvas[data-testid="wavecel-viz"]');
  await expect(canvas).toHaveCount(1);
  return await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    let brightPixels = 0;
    let brightCentroidX = 0;
    let brightCentroidY = 0;
    let maxLuma = 0;
    let nonZeroPixels = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = img.data[i]!;
        const g = img.data[i + 1]!;
        const b = img.data[i + 2]!;
        const luma = (r + g + b) / 3;
        if (luma > maxLuma) maxLuma = luma;
        if (luma > 30) nonZeroPixels++;
        // White-ish: the highlighted frame's blend is biased toward
        // (255,255,255). Orange lines are (255,150,40) at depth-faded
        // alpha; their G channel maxes ~150 and B ~40. Threshold G>180 +
        // B>150 reliably distinguishes the white-highlighted active
        // frame from the orange wavetable lines, surviving AA falloff
        // around sub-pixel line widths.
        if (g > 180 && b > 150) {
          brightPixels++;
          brightCentroidX += x;
          brightCentroidY += y;
        }
      }
    }
    if (brightPixels > 0) {
      brightCentroidX /= brightPixels;
      brightCentroidY /= brightPixels;
    }
    return { brightPixels, brightCentroidX, brightCentroidY, maxLuma, nonZeroPixels, w: c.width, h: c.height };
  });
}

test.describe('WAVECEL on-card 3D visualizer', () => {
  test('morph CV modulation moves the white-highlight position', async ({ page }) => {
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
        { id: 'wc',  type: 'wavecel', position: { x: 80,  y: 60 }, domain: 'audio',
          params: { morph: 0.5, spread: 1, fold: 0, tune: 0, fine: 0 } },
        { id: 'lfo', type: 'lfo',     position: { x: 480, y: 60 }, domain: 'audio',
          params: { rate: 1.5, shape: 0 } },
      ],
      [
        { id: 'e-lfo-morph',
          from: { nodeId: 'lfo', portId: 'phase0' },
          to:   { nodeId: 'wc',  portId: 'morph_cv' },
          sourceType: 'cv', targetType: 'cv' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-wavecel')).toBeVisible();
    await page.waitForTimeout(800);

    type Sample = NonNullable<Awaited<ReturnType<typeof sampleCanvas>>>;
    const samples: Sample[] = [];
    for (let i = 0; i < 8; i++) {
      const s = await sampleCanvas(page);
      expect(s).not.toBeNull();
      if (s) samples.push(s);
      await page.waitForTimeout(450);
    }

    // The visualizer must show high-luminance highlight pixels in at
    // least some samples (some LFO phases push morph into clamp regions
    // where the active frame sits at the canvas edge and falls below the
    // brightness threshold — non-zero counts in *some* samples is the
    // load-bearing assertion).
    const samplesWithHighlight = samples.filter((s) => s.brightPixels > 0);
    expect(
      samplesWithHighlight.length,
      `at least 3/8 samples show active-frame highlight (got ${samplesWithHighlight.length})`,
    ).toBeGreaterThanOrEqual(3);

    // Centroid must move across samples — LFO at different phases walks
    // the morph-derived active frame through the 3D-perspective stack.
    const ys = samplesWithHighlight.map((s) => s.brightCentroidY);
    const yRange = Math.max(...ys) - Math.min(...ys);
    expect(
      yRange,
      `white-highlight centroid moves with LFO modulation (yRange=${yRange.toFixed(1)})`,
    ).toBeGreaterThan(8);

    expect(errors).toEqual([]);
  });

  test('spread > 1 expands the white-highlight pixel count', async ({ page }) => {
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
        { id: 'wc', type: 'wavecel', position: { x: 80, y: 60 }, domain: 'audio',
          params: { morph: 0.5, spread: 1, fold: 0, tune: 0, fine: 0 } },
      ],
    );

    await expect(page.locator('.svelte-flow__node-wavecel')).toBeVisible();
    await page.waitForTimeout(1000);

    // Re-assert morph (initial param-seed timing can land at the
    // worklet's defaultValue=0; bump morph through a transact to ensure
    // the on-card knob/render path settles on 0.5 before sampling).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['wc'];
        if (n) n.params.morph = 0.5;
      });
    });
    await page.waitForTimeout(500);

    const narrow = await sampleCanvas(page);
    expect(narrow).not.toBeNull();
    expect(narrow!.brightPixels, `spread=1 highlights at least one frame (got ${narrow!.brightPixels}, maxLuma=${narrow!.maxLuma.toFixed(1)})`).toBeGreaterThan(0);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['wc'];
        if (n) n.params.spread = 5;
      });
    });
    await page.waitForTimeout(700);

    const wide = await sampleCanvas(page);
    expect(wide).not.toBeNull();

    // Spread=5 must produce strictly more white-highlight pixels than
    // spread=1 — more frames are blended toward white.
    expect(
      wide!.brightPixels,
      `spread=5 highlights more pixels than spread=1 (narrow=${narrow!.brightPixels}, wide=${wide!.brightPixels})`,
    ).toBeGreaterThan(narrow!.brightPixels);

    expect(errors).toEqual([]);
  });
});
