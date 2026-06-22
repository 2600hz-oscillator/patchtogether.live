// e2e/tests/foxy.spec.ts
//
// E2E for FOXY — the hybrid SWOLEVCO→RASTERIZE→XYZ→live-wavetable→WAVECEL
// module. FOXY is SELF-DRIVING: its internal mini-SWOLEVCO feeds the raster,
// so spawning it alone is enough to exercise the whole chain. We assert:
//
//   1. The card + all three preview canvases (RASTER / XYZ / live WAVETABLE)
//      render with real content (non-trivial pixels).
//   2. The wavetable display ANIMATES — because the table is regenerated in
//      realtime from the evolving XYZ field, two snapshots a moment apart
//      differ.
//   3. FOXY's wave3d_out video port (driven by the SAME realtime bridge that
//      feeds the internal WAVECEL VCO) renders real content into a video
//      OUTPUT — proving the audio-side wavetable is live, not a static
//      factory table.
//   4. No console / page errors throughout.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Sum of all RGB across a canvas — cheap "is there content" + "did it
 *  change" probe. */
async function canvasSum(page: import('@playwright/test').Page, testid: string): Promise<number> {
  return page.locator(`canvas[data-testid="${testid}"]`).first().evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      sum += img.data[i]! + img.data[i + 1]! + img.data[i + 2]!;
    }
    return sum;
  });
}

test.describe('FOXY hybrid module', () => {
  // FOXY mounts a lot before the rasters paint: 3 SwoleBlocks (osc graph each),
  // 3 RasterPainters (256×256 buffers), a WAVECEL worklet, plus the per-tick
  // box-blur + bilinear-sample pass added in v4.1. On slow Linux CI runners the
  // 30s default budget runs out before the 'foxy-xyz' canvas appears. Bump.
  test.setTimeout(90_000);
  test('renders the full internal chain + animates the live wavetable + makes audio', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // FOXY alone (self-driving) → audio OUTPUT (so the WAVECEL VCO actually
    // plays) AND wave3d_out → video OUTPUT (so we can read the live wavetable
    // render that the same bridge feeds the worklet).
    await spawnPatch(
      page,
      [
        { id: 'foxy',  type: 'foxy',     position: { x: 80,  y: 60 },  domain: 'audio' },
        { id: 'aout',  type: 'audioOut', position: { x: 520, y: 60 },  domain: 'audio' },
        { id: 'vout',  type: 'videoOut', position: { x: 520, y: 320 }, domain: 'video' },
      ],
      [
        {
          id: 'e-foxy-aout',
          from: { nodeId: 'foxy', portId: 'out_l' },
          to:   { nodeId: 'aout', portId: 'L' },
          sourceType: 'audio',
          targetType: 'audio',
        },
        {
          id: 'e-foxy-vout',
          from: { nodeId: 'foxy', portId: 'wave3d_out' },
          to:   { nodeId: 'vout', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    const card = page.locator('.svelte-flow__node-foxy');
    await expect(card, 'FOXY card visible').toBeVisible();

    // All preview canvases exist: RASTER A + RASTER B + RASTER C + XYZ + WAVETABLE.
    // (v3 replaced the BOX 3D preview with a third raster C feeding the new
    //  3-axis distribution wavetable: A=X, B=Y, C=Z.)
    await expect(card.locator('[data-testid="foxy-raster-a"]'), 'raster A canvas').toHaveCount(1);
    await expect(card.locator('[data-testid="foxy-raster-b"]'), 'raster B canvas').toHaveCount(1);
    await expect(card.locator('[data-testid="foxy-raster-c"]'), 'raster C canvas').toHaveCount(1);
    await expect(card.locator('[data-testid="foxy-xyz"]'), 'xyz canvas').toHaveCount(1);
    await expect(card.locator('[data-testid="foxy-wavetable"]'), 'wavetable canvas').toHaveCount(1);

    // WAVECEL's full IO surface is present on the card.
    for (const h of ['pitch', 'fm', 'morph_cv', 'spread_cv', 'fold_cv']) {
      await expect(card.locator(`[data-handleid="${h}"]`), `input ${h}`).toHaveCount(1);
    }
    for (const h of ['out_l', 'out_r', 'scope_out', 'wave3d_out']) {
      await expect(card.locator(`[data-handleid="${h}"]`), `output ${h}`).toHaveCount(1);
    }

    // 1. Real content in every preview — POLL until all fill. A fixed
    //    waitForTimeout + one-shot read flakes when a GPU transient (the always-
    //    present WindowServer GPU co-tenant on a real GPU) delays a raster past
    //    the single sample; the bounded poll absorbs the stall while a genuinely
    //    dead preview still fails after the timeout.
    await expect
      .poll(
        async () => {
          const sums = await Promise.all([
            canvasSum(page, 'foxy-raster-a'),
            canvasSum(page, 'foxy-raster-b'),
            canvasSum(page, 'foxy-raster-c'),
            canvasSum(page, 'foxy-xyz'),
            canvasSum(page, 'foxy-wavetable'),
          ]);
          return Math.min(...sums);
        },
        { timeout: 15_000, message: 'every FOXY preview canvas (A/B/C/XYZ/wavetable) fills with content' },
      )
      .toBeGreaterThan(0);

    // 2. The live wavetable animates — poll until a later sample DIFFERS from the
    //    first (the table regenerates from the evolving XYZ field). Polling
    //    absorbs a transient frame stall instead of flaking on a single
    //    fixed-wait diff.
    const wt1 = await canvasSum(page, 'foxy-wavetable');
    await expect
      .poll(async () => Math.abs((await canvasSum(page, 'foxy-wavetable')) - wt1), {
        timeout: 10_000,
        message: `FOXY wavetable display animates frame-to-frame (wt1 ${wt1})`,
      })
      .toBeGreaterThan(0);

    // 3. The wave3d_out video port renders real content into OUTPUT. This port is
    //    fed by the SAME realtime bridge that posts the live table to the
    //    internal WAVECEL worklet, so non-trivial pixels here prove the audio-
    //    side wavetable is live (not a static factory table). Poll the variance
    //    (same transient-tolerance rationale as the previews).
    const voutCanvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(voutCanvas).toHaveCount(1);
    await expect
      .poll(
        async () =>
          voutCanvas.evaluate((el) => {
            const c = el as HTMLCanvasElement;
            const ctx = c.getContext('2d');
            if (!ctx) return -1;
            const img = ctx.getImageData(0, 0, c.width, c.height);
            let n = 0, sum = 0, sumSq = 0;
            for (let i = 0; i < img.data.length; i += 4) {
              const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
              sum += v; sumSq += v * v; n++;
            }
            const mean = sum / n;
            return sumSq / n - mean * mean;
          }),
        { timeout: 10_000, message: 'wave3d_out renders live wavetable content (variance)' },
      )
      .toBeGreaterThan(5);

    expect(errors, 'no console / page errors').toEqual([]);
  });
});
