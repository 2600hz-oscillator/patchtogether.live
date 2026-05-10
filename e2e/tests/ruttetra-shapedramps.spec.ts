// e2e/tests/ruttetra-shapedramps.spec.ts
//
// Integration tests for the real RUTTETRA raster-scan-coordinate
// processor + SHAPEDRAMPS sync-locked ramp generator.
//
// Two scenarios:
//   1. Shaped wiring   — LINES → RUTTETRA.z, SHAPEDRAMPS.h_out → RUTTETRA.x,
//                        SHAPEDRAMPS.v_out → RUTTETRA.y. Crank xDisp/yDisp
//                        + shape morphs. Assert the on-card canvas renders
//                        non-uniform pixels and the patch produces no
//                        console errors.
//   2. Linear wiring   — LINES → RUTTETRA.z, SHAPEDRAMPS.h_lin → RUTTETRA.x,
//                        SHAPEDRAMPS.v_lin → RUTTETRA.y. The linear ramps
//                        are the identity coordinate field, so RUTTETRA's
//                        output should match a passthrough of LINES (within
//                        a small per-pixel tolerance — interpolation +
//                        canvas-side scaling create minor differences).

import { test, expect } from '@playwright/test';
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

test.describe('RUTTETRA + SHAPEDRAMPS integration', () => {
  test('shaped wiring renders a non-uniform deformed coordinate field', async ({ page }) => {
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
        { id: 'v-lines',  type: 'lines',       position: { x: 40,  y: 40  }, domain: 'video', params: { orient: 0.5, amp: 14, thickness: 0.45 } },
        { id: 'v-ramps',  type: 'shapedramps', position: { x: 320, y: 40  }, domain: 'video', params: { h_shape: 0.66, v_shape: 0.66, h_freq: 2, v_freq: 2 } },
        { id: 'v-rutt',   type: 'ruttetra',    position: { x: 700, y: 40  }, domain: 'video', params: { intensity: 1.2, xDisp: 0.5, yDisp: 0.5 } },
      ],
      [
        { id: 'e-lines-rutt-z', from: { nodeId: 'v-lines',  portId: 'out'   }, to: { nodeId: 'v-rutt', portId: 'z' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-ramps-rutt-x', from: { nodeId: 'v-ramps',  portId: 'h_out' }, to: { nodeId: 'v-rutt', portId: 'x' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-ramps-rutt-y', from: { nodeId: 'v-ramps',  portId: 'v_out' }, to: { nodeId: 'v-rutt', portId: 'y' }, sourceType: 'mono-video', targetType: 'mono-video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-lines'),       'LINES visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-shapedramps'), 'SHAPEDRAMPS visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-ruttetra'),    'RUTTETRA visible').toBeVisible();

    // Allow several rAF ticks before sampling. The shapedramps draw runs
    // first (no upstream deps) followed by RUTTETRA in topo order, so a
    // single frame is enough; we wait longer than that for CI stability.
    await page.waitForTimeout(800);

    const stats = await readCanvasStats('canvas[data-testid="ruttetra-canvas"]', page);
    expect(stats, 'RUTTETRA canvas stats sample').not.toBeNull();
    if (!stats) return;

    // Cracked shape morph + Disp = bright pixels in non-trivial places.
    // We just need the output not to be a flat color.
    expect(stats.variance, `variance ${stats.variance} > 50 (non-flat)`).toBeGreaterThan(50);
    expect(stats.nonZero / stats.samples, 'fraction of bright pixels > 5%').toBeGreaterThan(0.05);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('linear (h_lin/v_lin) wiring acts like a clean raster passthrough', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Two separate cards, same LINES feeding each. Output RUTTETRA wired
    // to h_lin/v_lin (identity coord field). The OUTPUT card displays
    // the same LINES feed directly. Their pixel stats should be very
    // close (within a small tolerance for canvas-side interpolation).
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',       position: { x: 40,  y: 40  }, domain: 'video', params: { orient: 0.0, amp: 12, thickness: 0.4 } },
        { id: 'v-ramps', type: 'shapedramps', position: { x: 320, y: 40  }, domain: 'video' },
        { id: 'v-rutt',  type: 'ruttetra',    position: { x: 700, y: 40  }, domain: 'video', params: { intensity: 1, xDisp: 0, yDisp: 0, tintR: 1, tintG: 1, tintB: 1 } },
        { id: 'v-out',   type: 'videoOut',    position: { x: 700, y: 360 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-rutt-z', from: { nodeId: 'v-lines', portId: 'out'   }, to: { nodeId: 'v-rutt', portId: 'z' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-ramps-rutt-x', from: { nodeId: 'v-ramps', portId: 'h_lin' }, to: { nodeId: 'v-rutt', portId: 'x' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-ramps-rutt-y', from: { nodeId: 'v-ramps', portId: 'v_lin' }, to: { nodeId: 'v-rutt', portId: 'y' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-lines-out',    from: { nodeId: 'v-lines', portId: 'out'   }, to: { nodeId: 'v-out',  portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-shapedramps'), 'SHAPEDRAMPS visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-ruttetra'),    'RUTTETRA visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    await page.waitForTimeout(800);

    const ruttStats = await readCanvasStats('canvas[data-testid="ruttetra-canvas"]', page);
    const outStats  = await readCanvasStats('canvas[data-testid="video-out-canvas"]', page);

    expect(ruttStats, 'RUTTETRA stats').not.toBeNull();
    expect(outStats,  'OUTPUT stats').not.toBeNull();
    if (!ruttStats || !outStats) return;

    // RUTTETRA should be rendering — not a black void.
    expect(ruttStats.variance, `RUTTETRA variance ${ruttStats.variance} > 50`).toBeGreaterThan(50);
    expect(ruttStats.nonZero / ruttStats.samples, 'RUTTETRA bright fraction > 5%').toBeGreaterThan(0.05);

    // Mean luma between the two paths should be close — RUTTETRA at
    // identity coord field with intensity=1 is supposed to equal the
    // input. They live in distinct cards rendered at potentially
    // different sizes, so we only compare a stat that survives scaling
    // (mean). Tolerance is generous (±15% of the larger value) to
    // absorb LINES's auto-scrolling phase shift between sample
    // capture moments.
    const meanScale = Math.max(1, ruttStats.mean, outStats.mean);
    const meanDelta = Math.abs(ruttStats.mean - outStats.mean);
    expect(
      meanDelta / meanScale,
      `mean delta ${meanDelta} too large (rutt=${ruttStats.mean}, out=${outStats.mean})`,
    ).toBeLessThan(0.15);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
