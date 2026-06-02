// e2e/tests/freezeframe.spec.ts
//
// FREEZEFRAME — video sample & hold + per-channel posterize. The
// regression-critical paths, asserted via canvas pixel sampling on the
// downstream VIDEOOUT card:
//
//   (a) UNGATED   → live passthrough: an animated source's frame keeps
//                   changing at the output (no freeze).
//   (b) GATE HIGH → output UPDATES (tracks the live source).
//   (c) GATE LOW  → output FROZEN: the held frame persists even while the
//                   source keeps animating underneath.
//   (d) QUANT     → raising all four QUANT knobs to max drops the number
//                   of DISTINCT colours at the output (posterization).
//
// The gate scenarios use the deterministic `__freezeframeForceGate` test
// hook (a number = "gate patched at this level") so the freeze-vs-live
// state is pinned without a timing-flaky real LFO. The REAL CV-bridge gate
// path (a gate source patched into gate_in) is covered by the
// per-module-per-port sweep + the freezeframe.test.ts shouldCapture unit
// tests; this spec proves the end-to-end render behaviour.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const OUT_CANVAS = 'canvas[data-testid="video-out-canvas"]';

interface FrameSample {
  /** Compact per-pixel brightness fingerprint (one byte per sampled pixel).
   *  Comparing two fingerprints pixel-by-pixel gives a robust "fraction of
   *  pixels that changed" motion detector — sensitive to a panning pattern
   *  even when the mean brightness is ~constant. */
  fingerprint: number[];
  nonZero: number;
  /** Count of DISTINCT quantized colours (5-bit-per-channel buckets). */
  distinctColors: number;
  samples: number;
}

async function sampleFrame(page: Page): Promise<FrameSample | null> {
  return page.locator(OUT_CANVAS).first().evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const data = img.data;
    let n = 0, nonZero = 0;
    const colors = new Set<number>();
    const fingerprint: number[] = [];
    // Coarse stride keeps this fast; we sample ~every 4th pixel.
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const v = (r + g + b) / 3;
      if (v > 8) nonZero++;
      fingerprint.push(Math.round(v));
      // Bucket each channel to 5 bits (32 levels) so anti-alias / sampling
      // noise doesn't inflate the distinct-colour count. Posterization to
      // ≤32 levels per channel will still collapse buckets measurably.
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      colors.add(key);
      n++;
    }
    return { fingerprint, nonZero, distinctColors: colors.size, samples: n };
  });
}

/** Fraction of sampled pixels whose brightness changed by > 8 (out of 255)
 *  between two frame fingerprints. ~0 ⇒ frozen; high ⇒ the frame moved. */
function changedFraction(a: FrameSample, b: FrameSample): number {
  const len = Math.min(a.fingerprint.length, b.fingerprint.length);
  if (len === 0) return 0;
  let changed = 0;
  for (let i = 0; i < len; i++) {
    if (Math.abs(a.fingerprint[i]! - b.fingerprint[i]!) > 8) changed++;
  }
  return changed / len;
}

/** Spin the rAF loop a few times so the chain re-renders. */
async function settle(page: Page, ms = 500): Promise<void> {
  await page.waitForTimeout(ms);
}

// A live/animated frame moves a meaningful fraction of pixels between
// samples; a frozen frame moves essentially none (identical held pixels).
const LIVE_FRACTION = 0.05;   // >5% of pixels changed ⇒ the frame moved
const FROZEN_FRACTION = 0.01; // <1% of pixels changed ⇒ held frame persists

test.describe('FREEZEFRAME — video sample & hold + posterize', () => {
  test('(a) ungated = live passthrough; (b/c) gate high updates / gate low freezes', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Clear any stale force-gate from a previous test in the worker.
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    await spawnPatch(
      page,
      [
        // ACIDWARP — animated colourful plasma source (speed high so the
        // frame visibly changes frame-to-frame).
        { id: 'v-src', type: 'acidwarp',    position: { x: 40,  y: 40 }, domain: 'video', params: { speed: 1, scene: 0 } },
        { id: 'v-ff',  type: 'freezeframe', position: { x: 380, y: 40 }, domain: 'video' },
        { id: 'v-out', type: 'videoOut',    position: { x: 720, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-src-ff', from: { nodeId: 'v-src', portId: 'out' },       to: { nodeId: 'v-ff',  portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-ff-out', from: { nodeId: 'v-ff',  portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' },       sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-acidwarp'),    'ACIDWARP visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-freezeframe'), 'FREEZEFRAME visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    // ---- (a) UNGATED: live passthrough — output keeps changing ----
    await settle(page, 700);
    const a1 = await sampleFrame(page);
    await settle(page, 700);
    const a2 = await sampleFrame(page);
    expect(a1, 'sample a1').not.toBeNull();
    expect(a2, 'sample a2').not.toBeNull();
    if (!a1 || !a2) return;
    expect(a1.nonZero, 'ungated output renders content').toBeGreaterThan(0);
    // Animated source + live passthrough → many pixels change between samples.
    const aChanged = changedFraction(a1, a2);
    expect(
      aChanged,
      `ungated live passthrough: frame changes over time (changed=${(aChanged * 100).toFixed(1)}%)`,
    ).toBeGreaterThan(LIVE_FRACTION);

    // ---- (b) GATE HIGH: output updates (tracks the live source) ----
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number }).__freezeframeForceGate = 1;
    });
    await settle(page, 700);
    const b1 = await sampleFrame(page);
    await settle(page, 700);
    const b2 = await sampleFrame(page);
    expect(b1, 'sample b1').not.toBeNull();
    expect(b2, 'sample b2').not.toBeNull();
    if (!b1 || !b2) return;
    expect(b1.nonZero, 'gate-high output renders content').toBeGreaterThan(0);
    const bChanged = changedFraction(b1, b2);
    expect(
      bChanged,
      `gate HIGH: output keeps updating (changed=${(bChanged * 100).toFixed(1)}%)`,
    ).toBeGreaterThan(LIVE_FRACTION);

    // ---- (c) GATE LOW: output FROZEN while source still animates ----
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number }).__freezeframeForceGate = 0;
    });
    // One settle for the last open-gate frame to land in the hold buffer,
    // then sample twice: the held frame must persist.
    await settle(page, 500);
    const c1 = await sampleFrame(page);
    await settle(page, 900); // plenty of time for the source to have moved on
    const c2 = await sampleFrame(page);
    expect(c1, 'sample c1').not.toBeNull();
    expect(c2, 'sample c2').not.toBeNull();
    if (!c1 || !c2) return;
    expect(c1.nonZero, 'frozen output still shows the held frame').toBeGreaterThan(0);
    const cChanged = changedFraction(c1, c2);
    expect(
      cChanged,
      `gate LOW: frozen frame persists while source animates (changed=${(cChanged * 100).toFixed(1)}%)`,
    ).toBeLessThan(FROZEN_FRACTION);

    // Clean up the hook so it can't leak into another test in the worker.
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('(d) raising QUANT knobs drops the distinct-colour count (posterize)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    // Start with QUANT at 0 (full depth → many colours).
    await spawnPatch(
      page,
      [
        { id: 'v-src', type: 'acidwarp',    position: { x: 40,  y: 40 }, domain: 'video', params: { speed: 0.4, scene: 0 } },
        { id: 'v-ff',  type: 'freezeframe', position: { x: 380, y: 40 }, domain: 'video',
          params: { quant_r: 0, quant_g: 0, quant_b: 0, quant_luma: 0 } },
        { id: 'v-out', type: 'videoOut',    position: { x: 720, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-src-ff', from: { nodeId: 'v-src', portId: 'out' },       to: { nodeId: 'v-ff',  portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-ff-out', from: { nodeId: 'v-ff',  portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' },       sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-freezeframe'), 'FREEZEFRAME visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    await settle(page, 800);
    const full = await sampleFrame(page);
    expect(full, 'full-depth sample').not.toBeNull();
    if (!full) return;
    expect(full.nonZero, 'full-depth output renders content').toBeGreaterThan(0);

    // Crank every QUANT knob to MAX (2 levels per channel → heavy posterize).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const ff = w.__patch.nodes['v-ff'];
        if (ff) {
          ff.params.quant_r = 1;
          ff.params.quant_g = 1;
          ff.params.quant_b = 1;
          ff.params.quant_luma = 1;
        }
      });
    });

    await settle(page, 800);
    const quantized = await sampleFrame(page);
    expect(quantized, 'quantized sample').not.toBeNull();
    if (!quantized) return;
    expect(quantized.nonZero, 'quantized output still renders content').toBeGreaterThan(0);

    // Posterizing to 2 levels per channel collapses the colour space hard:
    // the distinct-colour count must drop substantially.
    expect(
      quantized.distinctColors,
      `posterize drops distinct colours (full=${full.distinctColors} quantized=${quantized.distinctColors})`,
    ).toBeLessThan(full.distinctColors);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
