// e2e/tests/mandleblot.spec.ts
//
// MANDLEBLOT smoke: spawn the module + a VIDEO-OUT sink, wire COLOR
// output → VIDEO-OUT.in, wait for the shader to paint, assert the
// VIDEO-OUT canvas variance is high enough to prove the Mandelbrot
// pipeline actually rendered. A flat canvas (= shader didn't compile,
// = engine isn't pumping the fractal program, = colour mode broke)
// produces variance near 0; the boundary-rich Mandelbrot image always
// produces variance well above 5.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('MANDLEBLOT — Mandelbrot fractal generator', () => {
  test('COLOR output -> VIDEO-OUT paints a non-trivial frame', async ({ page }) => {
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
        // zoom=0 → 1× (full Mandelbrot set in view). At full zoom-out the
        // boundary fills most of the frame so the iteration-count
        // distribution is rich + the colour shader paints visibly across
        // the whole canvas (not just a thin strip at the boundary).
        // Position both nodes inside the SvelteFlow camera's default
        // viewport (≈ x>=300 lands centred in 1280px canvas).
        { id: 'mb', type: 'mandleblot', position: { x: 400, y: 200 }, domain: 'video',
          params: { zoom: 0, center_x: -0.5, center_y: 0, iterations: 100, color_cycle: 1, rotation: 0 } },
        { id: 'vo', type: 'videoOut',   position: { x: 800, y: 200 }, domain: 'video' },
      ],
      [
        {
          id: 'e-mb-vo',
          from: { nodeId: 'mb', portId: 'color_out' },
          to:   { nodeId: 'vo', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    // The MANDLEBLOT node spawns inside SvelteFlow's viewport at the
    // chosen position. Don't gate on toBeVisible() — SvelteFlow's
    // viewport-virtualization can declare a still-mounted node "hidden"
    // if it's near the camera edge. The card-present assertion below
    // (data-testid count) is the real "did the card mount" gate.
    await expect(
      page.locator('[data-testid="mandleblot-card"]'),
      'MANDLEBLOT card present',
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="mandleblot-canvas"]'),
      'MANDLEBLOT preview canvas mounted',
    ).toHaveCount(1);

    const outCanvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(outCanvas, 'video-out canvas in DOM').toHaveCount(1);

    // Wait ~1s — gives the engine several rAF ticks to compile the
    // shader, set up the FBOs, and render at least one frame. Same
    // budget every other video module spec uses for its first-frame
    // assertion.
    await page.waitForTimeout(1000);

    // Sample pixel variance from the VIDEO-OUT canvas. The Mandelbrot
    // boundary is information-rich (escape-count varies dramatically
    // across the frame), so the colour shader produces large per-pixel
    // R/G/B differences. A flat (= shader broken) canvas would be ~0.
    const stats = await outCanvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const data = img.data;
      let n = 0, sum = 0, sumSq = 0, nonZero = 0;
      // Stride 16 (every 4th pixel) — a sparse sample is plenty for
      // variance estimation and keeps the test fast.
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

    expect(stats, 'pixel-stats sample').not.toBeNull();
    if (!stats) return;

    // Variance > 5: the spec's documented gate. The actual Mandelbrot
    // boundary produces variance in the thousands, so >5 is a safe
    // "shader rendered SOMETHING complex" sanity check — the floor
    // would only be tripped if the shader compiled to a constant.
    expect(
      stats.variance,
      `output variance ${stats.variance.toFixed(1)} > 5 (shader painted complex content)`,
    ).toBeGreaterThan(5);
    // Non-trivial fraction of bright pixels — the colour pass should
    // light up far more than the in-set region (which is black). The
    // shader's hue cycling guarantees at least some non-black pixels
    // every frame.
    expect(
      stats.nonZero / stats.samples,
      `fraction of bright pixels > 10% (got ${(stats.nonZero / stats.samples * 100).toFixed(1)}%)`,
    ).toBeGreaterThan(0.1);

    expect(errors, `no console / page errors: ${errors.join('; ')}`).toEqual([]);
  });

  // NOTE (Phase 2 lean, webgl-suite-optimization §2/§7-3): the old test 2
  // ("zoom param mutation propagates to the engine without errors") was a pure
  // store round-trip (wrote node.params.zoom, read it BACK from the store; never
  // touched the engine) → DOWNGRADED to mandleblot.test.ts
  // ("MANDLEBLOT factory setParam propagates to the live engine param"), which
  // drives the REAL factory setParam + reads the post-curve zoomFactor (a
  // stronger, GPU-free check). The single GL PIXEL gate above (variance>5 +
  // brightFrac>10%) stays here — it is the ONLY pixel backstop for this
  // VRT-exempt module (plan §6).
});
