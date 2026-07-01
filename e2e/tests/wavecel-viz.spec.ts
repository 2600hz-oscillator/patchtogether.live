// e2e/tests/wavecel-viz.spec.ts
//
// E2E for the WAVECEL on-card 3D visualizer reactivity:
//  1. Morph moves the white-highlight position (the active wavetable frame).
//  2. Spread > 1 widens the highlight (more bright pixels).
//
// DETERMINISTIC render-smoke (DRS). The old version animated `morph` with an LFO
// → morph_cv and SAMPLED the on-card canvas 8× over wall-clock (waitForTimeout
// (450) between each), asserting the bright centroid's Y RANGE across samples —
// three un-synchronized clocks (the LFO phase, the card's rAF repaint, and the
// sample timing) plus a fixed sleep. Now: the move is proven by TWO FROZEN reads
// at two DIFFERENT, EXPLICIT morph values (no LFO, no time term) — the same
// two-read shape the spread test already used. The on-card visualizer draw
// (wavecel-draw.ts drawWave3D) is a PURE function of the static factory
// wavetable + morph/spread (activeFrame = round(morph·(frames-1))); it has no
// own clock, so once the card repaints after a param write the frame is stable.
// installRenderSmokeHooks pins the engine clock so any CV modulator tap the card
// reads (readModulatorTap) can't drift between the two reads.
//
// The on-card <canvas> is driven by the CARD's OWN rAF (not the video engine's
// step()), so instead of a fixed sleep we POLL until the canvas content settles
// after each param write — a deterministic "the repaint landed" wait, not a
// guess-the-slowest-CI-box timeout.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

interface VizSample {
  brightPixels: number;
  brightCentroidX: number;
  brightCentroidY: number;
  maxLuma: number;
  nonZeroPixels: number;
  w: number;
  h: number;
}

async function sampleCanvas(page: Page): Promise<VizSample | null> {
  const canvas = page.locator('canvas[data-testid="wavecel-viz"]');
  await expect(canvas).toHaveCount(1);
  return canvas.evaluate((el) => {
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
        // (255,255,255). Orange lines are (255,150,40) at depth-faded alpha;
        // their G channel maxes ~150 and B ~40. Threshold G>180 + B>150
        // reliably distinguishes the white-highlighted active frame from the
        // orange wavetable lines, surviving AA falloff around sub-pixel widths.
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

/** Set a WAVECEL param deterministically through the patch store (the card reads
 *  node.params reactively) and POLL until the on-card canvas content settles —
 *  the card repaints on its own rAF, so this is a "the repaint landed" wait, not
 *  a fixed sleep. Settled = two consecutive samples with an identical bright-
 *  pixel count (the draw is a pure function of the param, so it converges in a
 *  couple of frames + stays there). */
async function setParamAndSettle(page: Page, nodeId: string, param: string, value: number): Promise<VizSample> {
  await page.evaluate(({ nodeId, param, value }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[nodeId];
      if (n) n.params[param] = value;
    });
  }, { nodeId, param, value });

  let prev = -1;
  let stableCount = 0;
  let last: VizSample | null = null;
  // Bounded poll over real rAF frames (not a fixed sleep): the pure draw
  // converges in a few card-rAF repaints; we require 3 identical consecutive
  // bright-pixel counts so a mid-transition read can't pass for settled. 90
  // frames (~1.5s at 60fps) is a generous ceiling for a single card repaint.
  for (let i = 0; i < 90; i++) {
    // Wait exactly one card-rAF repaint, deterministically (no wall-clock guess).
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const s = await sampleCanvas(page);
    if (s) {
      last = s;
      if (s.brightPixels === prev) {
        if (++stableCount >= 2) return s;
      } else {
        stableCount = 0;
        prev = s.brightPixels;
      }
    }
  }
  if (!last) throw new Error('wavecel-viz canvas never produced a sample');
  return last;
}

test.describe('WAVECEL on-card 3D visualizer', () => {
  test('morph moves the white-highlight position (two frozen reads)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pin the engine clock so any CV modulator the card folds in (readModulatorTap)
    // is constant — the only thing moving the highlight is the morph we set.
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'wc', type: 'wavecel', position: { x: 80, y: 60 }, domain: 'audio',
          params: { morph: 0.2, spread: 1, fold: 0, tune: 0, fine: 0 } },
      ],
    );

    await expect(page.locator('.svelte-flow__node-wavecel')).toBeVisible();

    // Read A: morph LOW → active frame near the BACK of the 3D stack (high y).
    const low = await setParamAndSettle(page, 'wc', 'morph', 0.15);
    expect(
      low.brightPixels,
      `morph=0.15 highlights the active frame (got ${low.brightPixels}, maxLuma=${low.maxLuma.toFixed(1)})`,
    ).toBeGreaterThan(0);

    // Read B: morph HIGH → active frame near the FRONT of the stack (low y).
    const high = await setParamAndSettle(page, 'wc', 'morph', 0.85);
    expect(
      high.brightPixels,
      `morph=0.85 highlights the active frame (got ${high.brightPixels}, maxLuma=${high.maxLuma.toFixed(1)})`,
    ).toBeGreaterThan(0);

    // The white-highlight centroid Y must MOVE between the two morph values —
    // morph walks the active frame through the 3D-perspective stack (back→front),
    // and frame Y in drawWave3D increases with the frame's depth fraction.
    const yMove = Math.abs(high.brightCentroidY - low.brightCentroidY);
    expect(
      yMove,
      `white-highlight centroid moves with morph (lowY=${low.brightCentroidY.toFixed(1)}, highY=${high.brightCentroidY.toFixed(1)}, Δ=${yMove.toFixed(1)})`,
    ).toBeGreaterThan(8);

    expect(errors).toEqual([]);
  });

  test('spread > 1 expands the white-highlight pixel count (two frozen reads)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'wc', type: 'wavecel', position: { x: 80, y: 60 }, domain: 'audio',
          params: { morph: 0.5, spread: 1, fold: 0, tune: 0, fine: 0 } },
      ],
    );

    await expect(page.locator('.svelte-flow__node-wavecel')).toBeVisible();

    // Read A: spread=1 → a single tap, one frame blended toward white. (Re-set
    // morph=0.5 through the store so the on-card render path settles on it
    // regardless of param-seed timing.)
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
    const narrow = await setParamAndSettle(page, 'wc', 'spread', 1);
    expect(
      narrow.brightPixels,
      `spread=1 highlights at least one frame (got ${narrow.brightPixels}, maxLuma=${narrow.maxLuma.toFixed(1)})`,
    ).toBeGreaterThan(0);

    // Read B: spread=5 → multiple taps, more frames blended toward white.
    const wide = await setParamAndSettle(page, 'wc', 'spread', 5);

    // Spread=5 must produce strictly more white-highlight pixels than spread=1.
    expect(
      wide.brightPixels,
      `spread=5 highlights more pixels than spread=1 (narrow=${narrow.brightPixels}, wide=${wide.brightPixels})`,
    ).toBeGreaterThan(narrow.brightPixels);

    expect(errors).toEqual([]);
  });
});
