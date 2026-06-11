// e2e/tests/video-r1.spec.ts
//
// Phase 0 video-domain spike — end-to-end demo verification.
//
// Spawns LINES → OUTPUT, lets the WebGL2 engine settle for a few rAF
// ticks, and asserts the OUTPUT card's visible <canvas> contains a
// non-trivial pixel pattern. The acceptance criterion is "the demo
// runs": once we see non-zero pixel variance inside the OUTPUT canvas
// the engine + LINES shader + texture-pull-from-engine + 2D blit are
// all working end-to-end.
//
// Why pixel variance and not exact-match: the LINES shader is time-
// driven (auto-scrolls phase) and we don't want a brittle baseline
// here. Variance > 0 with mean somewhere in [0.05, 0.95] catches the
// trivial "canvas is all black" / "canvas is all white" regressions.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('video Phase-0: LINES → OUTPUT', () => {
  // @webgl-smoke — REQUIRED on-CI WebGL floor: a video module (LINES) renders a
  // frame to a VideoOut WebGL canvas without throwing + paints non-trivial
  // content. Renderer-tolerant (variance/non-black, NOT exact pixels).
  test('renders a non-trivial pattern into the OUTPUT canvas @webgl-smoke', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Spawn the two-node patch with a single video edge between them.
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines', position: { x: 80, y: 60 }, domain: 'video' },
        { id: 'v-out',   type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-v-lines-out-v-out-in',
          from: { nodeId: 'v-lines', portId: 'out' },
          to:   { nodeId: 'v-out',   portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );

    // Both cards visible.
    await expect(page.locator('.svelte-flow__node-lines'), 'LINES visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas, 'video-out canvas in DOM').toHaveCount(1);

    // Allow a few rAF ticks for the engine to render LINES into its FBO
    // and the OUTPUT card's per-card rAF blit to copy it onto the
    // visible canvas. ~10 frames at 60fps is ~167ms; budget 600ms with
    // headroom for slow CI runners.
    await page.waitForTimeout(600);

    // Grab the canvas's pixels and compute mean + variance. A trivial
    // "engine never started" failure produces a stable colour (the idle
    // pattern in OUTPUT's COPY_FRAG); a working LINES feed produces
    // alternating bright/dark bands → high variance.
    const stats = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const data = img.data;
      // Sample every 4th pixel (stride 16 bytes) for speed; full scan
      // would be ~230KB on a 320×180 canvas which is fine but stride is
      // cheaper and still gives ample stats.
      let n = 0;
      let sum = 0;
      let sumSq = 0;
      let nonZero = 0;
      for (let i = 0; i < data.length; i += 16) {
        // Average of R,G,B — alpha is forced 255 by the 2d ctx.
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

    // Assertions: variance > 0 means the canvas isn't a flat colour;
    // nonZero count > 5% means it's not "all black" (would be the case
    // if the engine threw or the texture upload failed silently).
    expect(stats.variance, `variance ${stats.variance} > 50 (non-flat)`).toBeGreaterThan(50);
    expect(stats.nonZero / stats.samples, 'fraction of bright pixels > 5%').toBeGreaterThan(0.05);

    // Diagnostic screenshot (referenced in the PR body — not a hard
    // assertion). Path is e2e/test-results/<spec>/<test>/...
    await page.screenshot({ path: 'test-results/video-r1-demo.png', fullPage: false });

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
