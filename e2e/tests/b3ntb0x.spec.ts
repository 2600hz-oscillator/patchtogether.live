// e2e/tests/b3ntb0x.spec.ts
//
// B3NTB0X — circuit-level NTSC composite re-arch OUTPUT. Real-GL coverage
// (jsdom can't exercise WebGL, so the 4-pass float pipeline is only
// verifiable in a browser): spawn a SHAPES source → B3NTB0X, confirm the
// card + canvas mount, the pipeline decodes a NON-BLACK frame, and turning
// up Sync Crush / Enhance VISIBLY changes the output (the Phase-1 proof
// point: a real composite that decodes back and mangles when bent).
//
// We assert pixel STATISTICS (non-black + per-run frame difference), not
// pixel-exact content — the module is animated (subcarrier drift + frame
// persistence) and VRT-exempt by design.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('B3NTB0X — NTSC composite re-arch output', () => {
  test('spawns + canvas mounts + decodes a non-black frame', async ({ page }) => {
    // WebGL video modules compile + warm slowly on CI's software renderer
    // (SwiftShader) against the preview build — the 30s default is tight for a
    // goto + networkidle + spawnPatch + 4-pass float pipeline warm-up.
    test.setTimeout(60_000);
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
        { id: 'src', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
        { id: 'bb',  type: 'b3ntb0x', position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-b3ntb0x'), 'B3NTB0X node visible').toBeVisible();
    await expect(page.locator('[data-testid="b3ntb0x-card"]'), 'card present').toHaveCount(1);

    const canvas = page.locator('[data-testid="b3ntb0x-canvas"]');
    await expect(canvas, 'canvas mounted').toHaveCount(1);

    const dims = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return { width: c.width, height: c.height };
    });
    expect(dims.width, 'canvas has positive width').toBeGreaterThan(100);
    expect(dims.height, 'canvas has positive height').toBeGreaterThan(50);

    // Let the 4-pass pipeline tick a bunch of frames (encode→bend→decode→CRT
    // + the bend/CRT ping-pong fill their empty sentinels).
    await page.waitForTimeout(600);

    // The decoded CRT frame must be NON-BLACK with spatial structure — proof
    // the composite encode→bend→decode→CRT path actually produced an image.
    const stats = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0, sum = 0, sumSq = 0, nonZero = 0;
      for (let i = 0; i < data.length; i += 16) {
        const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
        sum += v; sumSq += v * v; n++;
        if (v > 8) nonZero++;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      return { mean, variance, nonZeroFrac: nonZero / n };
    });
    expect(stats, 'canvas readable').not.toBeNull();
    expect(stats!.nonZeroFrac, 'decoded output is not all-black').toBeGreaterThan(0.02);
    expect(stats!.variance, 'decoded output has spatial structure').toBeGreaterThan(15);

    expect(errors, 'no console / page errors during B3NTB0X render').toEqual([]);
  });

  test('Sync Crush + Enhance visibly change the decoded output (the bend proof point)', async ({ page }) => {
    // TWO full captures (each: goto + networkidle + spawnPatch + GL warm-up), so
    // this needs ~2× the single-capture budget. On CI's SwiftShader software
    // renderer that blows past the 30s default — it timed out (not an assertion
    // failure) on the first CI run. 90s gives both captures headroom.
    test.setTimeout(90_000);
    // Sample the same scene at rest vs heavily-bent. A real composite signal
    // path means high gain into the clip (Sync Crush) + HF peaking (Enhance)
    // mangle the demodulated frame — so the two captures must differ.
    async function capture(bend: boolean): Promise<{ frame: number[]; mean: number }> {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(
        page,
        [
          { id: 'src', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
          { id: 'bb',  type: 'b3ntb0x', position: { x: 540, y: 100 }, domain: 'video',
            // TBC=1 (steady) so the diff is the BEND, not random sync jitter.
            params: bend
              ? { sync_crush: 1.9, enhance: 0.9, bias: 0.3, chroma_leak: 0.8, tbc: 1, feedback: 0, sub_drift: 0 }
              : { sync_crush: 1.0, enhance: 0.0, bias: 0.0, chroma_leak: 0.0, tbc: 1, feedback: 0, sub_drift: 0 } },
        ],
        [
          { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        ],
      );
      const canvas = page.locator('[data-testid="b3ntb0x-canvas"]');
      await expect(canvas).toHaveCount(1);
      await page.waitForTimeout(500);
      return canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return { frame: [], mean: 0 };
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const frame: number[] = [];
        let sum = 0, n = 0;
        for (let i = 0; i < d.length; i += 4 * 32) {
          const v = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
          frame.push(v);
          sum += v; n++;
        }
        return { frame, mean: n ? sum / n : 0 };
      });
    }

    const clean = await capture(false);
    const bent = await capture(true);

    expect(clean.frame.length, 'clean frame sampled').toBeGreaterThan(0);
    expect(bent.frame.length, 'bent frame sampled').toBeGreaterThan(0);

    // Mean-absolute-difference across the sampled grid: the bent frame must be
    // meaningfully different from the clean one.
    const m = Math.min(clean.frame.length, bent.frame.length);
    let diff = 0;
    for (let k = 0; k < m; k++) diff += Math.abs(clean.frame[k]! - bent.frame[k]!);
    const mad = diff / m;
    expect(mad, `bent output differs from clean (MAD=${mad.toFixed(2)})`).toBeGreaterThan(3);
  });

  test('CV-bending knobs mutate params via the patch store', async ({ page }) => {
    test.setTimeout(60_000); // CI SwiftShader GL warm-up (see above)
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'bb', type: 'b3ntb0x', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="b3ntb0x-card"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['bb'];
        if (!n) return;
        n.params.sync_crush = 1.7;
        n.params.enhance = 0.6;
        n.params.bend_a = -0.5;
      });
    });
    await page.waitForTimeout(120);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['bb'];
      return { sync_crush: n?.params.sync_crush, enhance: n?.params.enhance, bend_a: n?.params.bend_a };
    });
    expect(params.sync_crush).toBe(1.7);
    expect(params.enhance).toBe(0.6);
    expect(params.bend_a).toBe(-0.5);
  });
});
