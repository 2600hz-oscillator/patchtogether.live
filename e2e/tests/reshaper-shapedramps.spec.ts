// e2e/tests/reshaper-shapedramps.spec.ts
//
// Integration tests for the real RESHAPER raster-scan-coordinate
// processor + SHAPEDRAMPS sync-locked ramp generator.
//
// Two scenarios:
//   1. Shaped wiring   — LINES → RESHAPER.z, SHAPEDRAMPS.h_out → RESHAPER.x,
//                        SHAPEDRAMPS.v_out → RESHAPER.y. Crank xDisp/yDisp
//                        + shape morphs. Assert the on-card canvas renders
//                        non-uniform pixels and the patch produces no
//                        console errors.
//   2. Linear wiring   — LINES → RESHAPER.z, SHAPEDRAMPS.h_lin → RESHAPER.x,
//                        SHAPEDRAMPS.v_lin → RESHAPER.y. The linear ramps
//                        are the identity coordinate field, so RESHAPER's
//                        output should match a passthrough of LINES (within
//                        a small per-pixel tolerance — interpolation +
//                        canvas-side scaling create minor differences).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

interface PixelStats {
  mean: number;
  variance: number;
  nonZero: number;
  samples: number;
}

async function readCanvasStats(
  selector: string,
  page: import('@playwright/test').Page,
): Promise<PixelStats | null> {
  const handle = page.locator(selector).first();
  return handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const data = img.data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v;
      sumSq += v * v;
      if (v > 8) nonZero++;
      n++;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return { mean, variance, nonZero, samples: n };
  });
}

test.describe('RESHAPER + SHAPEDRAMPS integration', () => {
  test('shaped wiring renders a non-uniform deformed coordinate field', async ({ page, rack, errorWatch }) => {
    await spawnPatch(
      page,
      [
        { id: 'v-lines',  type: 'lines',       position: { x: 40,  y: 40  }, domain: 'video', params: { orient: 0.5, amp: 14, thickness: 0.45 } },
        { id: 'v-ramps',  type: 'shapedramps', position: { x: 320, y: 40  }, domain: 'video', params: { h_shape: 0.66, v_shape: 0.66, h_freq: 2, v_freq: 2 } },
        { id: 'v-reshaper',   type: 'reshaper',    position: { x: 700, y: 40  }, domain: 'video', params: { intensity: 1.2, xDisp: 0.5, yDisp: 0.5 } },
      ],
      [
        { id: 'e-lines-rutt-z', from: { nodeId: 'v-lines',  portId: 'out'   }, to: { nodeId: 'v-reshaper', portId: 'z' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-ramps-rutt-x', from: { nodeId: 'v-ramps',  portId: 'h_out' }, to: { nodeId: 'v-reshaper', portId: 'x' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-ramps-rutt-y', from: { nodeId: 'v-ramps',  portId: 'v_out' }, to: { nodeId: 'v-reshaper', portId: 'y' }, sourceType: 'mono-video', targetType: 'mono-video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-lines'),       'LINES visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-shapedramps'), 'SHAPEDRAMPS visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-reshaper'),    'RESHAPER visible').toBeVisible();

    // Allow several rAF ticks before sampling. The shapedramps draw runs
    // first (no upstream deps) followed by RESHAPER in topo order, so a
    // single frame is enough; we wait longer than that for CI stability.
    await page.waitForTimeout(800);

    const stats = await readCanvasStats('canvas[data-testid="reshaper-canvas"]', page);
    expect(stats, 'RESHAPER canvas stats sample').not.toBeNull();
    if (!stats) return;

    // Cracked shape morph + Disp = bright pixels in non-trivial places.
    // We just need the output not to be a flat color.
    expect(stats.variance, `variance ${stats.variance} > 50 (non-flat)`).toBeGreaterThan(50);
    expect(stats.nonZero / stats.samples, 'fraction of bright pixels > 5%').toBeGreaterThan(0.05);

  });

  test('linear (h_lin/v_lin) wiring acts like a clean raster passthrough', async ({ page, rack, errorWatch }) => {
    // Two separate cards, same LINES feeding each. Output RESHAPER wired
    // to h_lin/v_lin (identity coord field). The OUTPUT card displays
    // the same LINES feed directly. Their pixel stats should be very
    // close (within a small tolerance for canvas-side interpolation).
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',       position: { x: 40,  y: 40  }, domain: 'video', params: { orient: 0.0, amp: 12, thickness: 0.4 } },
        { id: 'v-ramps', type: 'shapedramps', position: { x: 320, y: 40  }, domain: 'video' },
        { id: 'v-reshaper',  type: 'reshaper',    position: { x: 700, y: 40  }, domain: 'video', params: { intensity: 1, xDisp: 0, yDisp: 0, tintR: 1, tintG: 1, tintB: 1 } },
        { id: 'v-out',   type: 'videoOut',    position: { x: 700, y: 360 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-rutt-z', from: { nodeId: 'v-lines', portId: 'out'   }, to: { nodeId: 'v-reshaper', portId: 'z' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-ramps-rutt-x', from: { nodeId: 'v-ramps', portId: 'h_lin' }, to: { nodeId: 'v-reshaper', portId: 'x' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-ramps-rutt-y', from: { nodeId: 'v-ramps', portId: 'v_lin' }, to: { nodeId: 'v-reshaper', portId: 'y' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-lines-out',    from: { nodeId: 'v-lines', portId: 'out'   }, to: { nodeId: 'v-out',  portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-shapedramps'), 'SHAPEDRAMPS visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-reshaper'),    'RESHAPER visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    await page.waitForTimeout(800);

    const reshaperStats = await readCanvasStats('canvas[data-testid="reshaper-canvas"]', page);
    const outStats  = await readCanvasStats('canvas[data-testid="video-out-canvas"]', page);

    expect(reshaperStats, 'RESHAPER stats').not.toBeNull();
    expect(outStats,  'OUTPUT stats').not.toBeNull();
    if (!reshaperStats || !outStats) return;

    // RESHAPER should be rendering — not a black void.
    expect(reshaperStats.variance, `RESHAPER variance ${reshaperStats.variance} > 50`).toBeGreaterThan(50);
    expect(reshaperStats.nonZero / reshaperStats.samples, 'RESHAPER bright fraction > 5%').toBeGreaterThan(0.05);

    // Mean luma between the two paths should be close — RESHAPER at
    // identity coord field with intensity=1 is supposed to equal the
    // input. They live in distinct cards rendered at potentially
    // different sizes, so we only compare a stat that survives scaling
    // (mean). Tolerance is generous (±15% of the larger value) to
    // absorb LINES's auto-scrolling phase shift between sample
    // capture moments.
    const meanScale = Math.max(1, reshaperStats.mean, outStats.mean);
    const meanDelta = Math.abs(reshaperStats.mean - outStats.mean);
    expect(
      meanDelta / meanScale,
      `mean delta ${meanDelta} too large (reshaper=${reshaperStats.mean}, out=${outStats.mean})`,
    ).toBeLessThan(0.15);

  });

  test('onboard mix1 crossfades two LINES into RESHAPER.x and reacts to mix1 knob', async ({ page, rack, errorWatch }) => {
    // Two distinct LINES sources → SHAPEDRAMPS.mix1_a / mix1_b.
    // SHAPEDRAMPS.mix1_out → RESHAPER.x. Linear v_lin → RESHAPER.y so the
    // vertical axis is well-defined. LINES1 also drives RESHAPER.z (the
    // source signal we're scanning).
    await spawnPatch(
      page,
      [
        { id: 'v-lines1', type: 'lines',       position: { x: 40,  y: 40  }, domain: 'video', params: { orient: 0.0, amp: 12, thickness: 0.4 } },
        { id: 'v-lines2', type: 'lines',       position: { x: 40,  y: 280 }, domain: 'video', params: { orient: 1.0, amp: 18, thickness: 0.6 } },
        { id: 'v-ramps',  type: 'shapedramps', position: { x: 320, y: 40  }, domain: 'video', params: { mix1: 0.0 } },
        { id: 'v-reshaper',   type: 'reshaper',    position: { x: 700, y: 40  }, domain: 'video', params: { intensity: 1.2, xDisp: 0.4, yDisp: 0.4 } },
      ],
      [
        { id: 'e-l1-mix1a',  from: { nodeId: 'v-lines1', portId: 'out'      }, to: { nodeId: 'v-ramps', portId: 'mix1_a' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-l2-mix1b',  from: { nodeId: 'v-lines2', portId: 'out'      }, to: { nodeId: 'v-ramps', portId: 'mix1_b' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-mix1-x',    from: { nodeId: 'v-ramps',  portId: 'mix1_out' }, to: { nodeId: 'v-reshaper',  portId: 'x' },      sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-vlin-y',    from: { nodeId: 'v-ramps',  portId: 'v_lin'    }, to: { nodeId: 'v-reshaper',  portId: 'y' },      sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-l1-z',      from: { nodeId: 'v-lines1', portId: 'out'      }, to: { nodeId: 'v-reshaper',  portId: 'z' },      sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-shapedramps'), 'SHAPEDRAMPS visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-reshaper'),    'RESHAPER visible').toBeVisible();

    await page.waitForTimeout(800);

    // RESHAPER renders something visible (non-flat).
    const stats0 = await readCanvasStats('canvas[data-testid="reshaper-canvas"]', page);
    expect(stats0, 'RESHAPER stats at mix1=0').not.toBeNull();
    if (!stats0) return;
    expect(stats0.variance, `variance ${stats0.variance} > 50 at mix1=0`).toBeGreaterThan(50);
    expect(stats0.nonZero / stats0.samples, 'bright fraction > 5% at mix1=0').toBeGreaterThan(0.05);

    // Sweep mix1 from 0 → 1. The mixer crossfades from LINES1 (oriented
    // horizontal, amp 12) to LINES2 (oriented vertical, amp 18). The
    // resulting RESHAPER scan should change visibly as the X coordinate
    // field swings between the two distinct ramp sources.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const target = w.__patch.nodes['v-ramps'];
        if (target) target.params['mix1'] = 1.0;
      });
    });
    await page.waitForTimeout(400);

    const stats1 = await readCanvasStats('canvas[data-testid="reshaper-canvas"]', page);
    expect(stats1, 'RESHAPER stats at mix1=1').not.toBeNull();
    if (!stats1) return;
    expect(stats1.variance, `variance ${stats1.variance} > 50 at mix1=1`).toBeGreaterThan(50);

    // The two snapshots should differ — if mix1 had no effect the means
    // would be identical (modulo LINES auto-scrolling jitter, which we
    // tolerate by requiring at least 2.5 luma units of difference).
    const meanDelta = Math.abs(stats0.mean - stats1.mean);
    const varianceDelta = Math.abs(stats0.variance - stats1.variance);
    const movement = meanDelta + Math.sqrt(varianceDelta);
    expect(
      movement,
      `mix1 sweep should change RESHAPER output (mean ${stats0.mean}→${stats1.mean}, var ${stats0.variance}→${stats1.variance})`,
    ).toBeGreaterThan(2.5);

  });
});
