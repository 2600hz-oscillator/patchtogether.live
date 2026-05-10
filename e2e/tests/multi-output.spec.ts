// e2e/tests/multi-output.spec.ts
//
// Regression: multiple OUTPUT cards in the same rack must each render
// the video stream that's actually patched into them, not the
// engine's shared default framebuffer.
//
// Pre-fix bug: the OUTPUT module ran TWO passes per frame — one into
// its own FBO, one into the engine's default FB. With N OUTPUTs in
// topo order, every pass-2 stomped the previous one, so all N cards
// displayed whatever the LAST OUTPUT had as its input. Two cards on
// the same engine showed the same content regardless of patching.
//
// Fix shape: OUTPUT no longer writes to the default FB during
// per-frame draw(); each card's `draw()` calls
// `engine.blitOutputToDrawingBuffer(nodeId)` immediately before its
// `drawImage(engine.canvas)` blit so each card sees its own
// per-OUTPUT FBO content. This spec proves the routing per card.
//
// Test pattern: spawn LINES + INWARDS as two visually-distinct
// procedural sources, wire each into its OWN OUTPUT, and assert the
// two visible canvases produce DIFFERENT pixel statistics. (Same
// stats would prove the cards share a render path — the original
// bug.)

import { test, expect, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PixelStats {
  mean: number;
  variance: number;
  nonZero: number;
  samples: number;
}

async function readCanvasStats(canvas: Locator): Promise<PixelStats | null> {
  return canvas.evaluate((el) => {
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

test.describe('video: multi-OUTPUT independent routing', () => {
  test('LINES->OUT-A and INWARDS->OUT-B render independent content', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Two visually-distinct procedural sources, each piped into its
    // own OUTPUT card. LINES = horizontal stripes, INWARDS = radial
    // expanding rings; their pixel stats are easy to distinguish.
    await spawnPatch(
      page,
      [
        { id: 'v-lines',   type: 'lines',    position: { x: 40,  y: 40 },  domain: 'video', params: { amp: 8, thickness: 0.4 } },
        { id: 'v-inwards', type: 'inwards',  position: { x: 40,  y: 320 }, domain: 'video', params: { density: 30, speed: 0.05, thickness: 0.4 } },
        { id: 'v-out-a',   type: 'videoOut', position: { x: 480, y: 40 },  domain: 'video' },
        { id: 'v-out-b',   type: 'videoOut', position: { x: 480, y: 320 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-out-a',   from: { nodeId: 'v-lines',   portId: 'out' }, to: { nodeId: 'v-out-a', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-inwards-out-b', from: { nodeId: 'v-inwards', portId: 'out' }, to: { nodeId: 'v-out-b', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    // Both OUTPUT cards rendered.
    const outA = page.locator('canvas[data-testid="video-out-canvas"][data-node-id="v-out-a"]');
    const outB = page.locator('canvas[data-testid="video-out-canvas"][data-node-id="v-out-b"]');
    await expect(outA, 'OUTPUT A canvas').toHaveCount(1);
    await expect(outB, 'OUTPUT B canvas').toHaveCount(1);

    // Allow several rAF ticks for both cards to drive their per-card
    // blits. ~800ms covers slow CI runners with margin.
    await page.waitForTimeout(800);

    const a = await readCanvasStats(outA);
    const b = await readCanvasStats(outB);
    expect(a, 'A non-null').not.toBeNull();
    expect(b, 'B non-null').not.toBeNull();
    if (!a || !b) return;

    // Both canvases must show non-trivial content (not all-black,
    // not flat colour) — that rules out an "engine never started"
    // false positive on the diff assertion below.
    expect(a.variance, `OUTPUT A variance ${a.variance} > 50 (non-flat)`).toBeGreaterThan(50);
    expect(b.variance, `OUTPUT B variance ${b.variance} > 50 (non-flat)`).toBeGreaterThan(50);
    expect(a.nonZero / a.samples, 'A bright pixels > 5%').toBeGreaterThan(0.05);
    expect(b.nonZero / b.samples, 'B bright pixels > 5%').toBeGreaterThan(0.05);

    // The critical assertion: A and B are NOT showing the same
    // content. Different sources → different pixel stats by a wide
    // margin. We compare three statistics independently (mean,
    // variance, non-zero count) and require at least two of them to
    // diverge by > 10% of the larger sample. That tolerance avoids
    // flakes from rAF timing while still catching the original
    // last-OUTPUT-wins bug (which would make every diff exactly 0).
    const meanDelta = Math.abs(a.mean - b.mean);
    const varianceDelta = Math.abs(a.variance - b.variance);
    const nzDelta = Math.abs(a.nonZero - b.nonZero);

    const meanScale = Math.max(1, a.mean, b.mean);
    const varianceScale = Math.max(1, a.variance, b.variance);
    const nzScale = Math.max(1, a.nonZero, b.nonZero);

    const meanRel = meanDelta / meanScale;
    const varianceRel = varianceDelta / varianceScale;
    const nzRel = nzDelta / nzScale;

    const movedFlags = [meanRel > 0.10, varianceRel > 0.10, nzRel > 0.10];
    const movedCount = movedFlags.filter(Boolean).length;

    expect(
      movedCount,
      `at least 2 of {mean, variance, nonZero} differ between OUTPUT A and B by >10%; ` +
        `A=mean=${a.mean.toFixed(1)},var=${a.variance.toFixed(1)},nz=${a.nonZero} ` +
        `B=mean=${b.mean.toFixed(1)},var=${b.variance.toFixed(1)},nz=${b.nonZero} ` +
        `(rels: meanΔ=${(meanRel * 100).toFixed(1)}%, varΔ=${(varianceRel * 100).toFixed(1)}%, nzΔ=${(nzRel * 100).toFixed(1)}%)`,
    ).toBeGreaterThanOrEqual(2);

    // Diagnostic — captured in CI artifacts on failure.
    await page.screenshot({ path: 'test-results/multi-output-demo.png', fullPage: false });

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('unpatched second OUTPUT shows idle pattern, patched first OUTPUT shows source', async ({ page }) => {
    // Edge case: only ONE of two OUTPUTs has its input wired. The
    // patched OUTPUT shows its source; the unpatched one shows the
    // OUTPUT shader's idle pattern (not the source either, and not
    // the same content as the patched one).
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
        { id: 'v-lines', type: 'lines',    position: { x: 40,  y: 40 },  domain: 'video', params: { amp: 8, thickness: 0.4 } },
        { id: 'v-out-a', type: 'videoOut', position: { x: 480, y: 40 },  domain: 'video' },
        { id: 'v-out-b', type: 'videoOut', position: { x: 480, y: 320 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-out-a', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-out-a', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        // v-out-b is intentionally NOT wired to anything.
      ],
    );

    const outA = page.locator('canvas[data-testid="video-out-canvas"][data-node-id="v-out-a"]');
    const outB = page.locator('canvas[data-testid="video-out-canvas"][data-node-id="v-out-b"]');
    await expect(outA, 'OUTPUT A canvas').toHaveCount(1);
    await expect(outB, 'OUTPUT B canvas').toHaveCount(1);

    await page.waitForTimeout(800);

    const a = await readCanvasStats(outA);
    const b = await readCanvasStats(outB);
    expect(a, 'A non-null').not.toBeNull();
    expect(b, 'B non-null').not.toBeNull();
    if (!a || !b) return;

    // A: LINES pattern → high variance.
    expect(a.variance, `OUTPUT A LINES variance ${a.variance} > 50`).toBeGreaterThan(50);
    // B: idle pattern is a near-flat dark navy gradient → very low
    // variance (<< A's). Pre-fix bug: B would have shown LINES too
    // (last-OUTPUT-wins) → variance similar to A's. The wide gap is
    // the regression gate.
    expect(b.variance, `OUTPUT B idle variance ${b.variance} < A's by >10×`).toBeLessThan(a.variance / 10);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
