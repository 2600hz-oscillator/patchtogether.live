// e2e/tests/backdraft.spec.ts
//
// BACKDRAFT (video feedback generator) functional e2e.
//
// Graph (matches the module spec's E2E request):
//   SHAPES (circle)  -> in_a   \
//   SHAPES (squares) -> in_b     BACKDRAFT --> OUTPUT
//   LINES            -> lighten /
//   SHAPES (tris)    -> darken /
//
// The spec asks for LINES + SHAPES as the lighten/darken key masks and a
// couple of video sources into in_a / in_b. We assert:
//   1. all cards spawn + the BACKDRAFT card + preview canvas mount,
//   2. the wired-up output renders a non-trivial (moving feedback) frame,
//   3. params route through the patch store (MIDI-Learn-wired faders path),
//   4. no console / page errors.
//
// Determinism for the PIXEL baseline lives in the VRT suite (vrt-scenes.ts:
// BACKDRAFT freezes after settle). This spec is the behavioural gate.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('BACKDRAFT — video feedback generator', () => {
  test('SHAPES/LINES masks + SHAPES sources -> BACKDRAFT -> OUTPUT renders a live feedback frame', async ({ page }) => {
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
        { id: 'src_a',  type: 'shapes',    position: { x: 40,  y: 40  }, domain: 'video', params: { shape: 0, zoom: 1.6 } },
        { id: 'src_b',  type: 'shapes',    position: { x: 40,  y: 260 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 5, zoom: 0.7 } },
        { id: 'mask_l', type: 'lines',     position: { x: 40,  y: 480 }, domain: 'video', params: { amp: 8 } },
        { id: 'mask_d', type: 'shapes',    position: { x: 40,  y: 700 }, domain: 'video', params: { shape: 2, tile: 1, tileN: 4 } },
        { id: 'bd',     type: 'backdraft', position: { x: 460, y: 80  }, domain: 'video',
          params: { mix: 0.5, feedback: 1.05, delay: 16, luma: 1.1, chroma: 1.3, lighten: 0.9, darken: 0.9 } },
        { id: 'v-out',  type: 'videoOut',  position: { x: 980, y: 80  }, domain: 'video' },
      ],
      [
        { id: 'e_a', from: { nodeId: 'src_a',  portId: 'out' }, to: { nodeId: 'bd', portId: 'in_a'    }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_b', from: { nodeId: 'src_b',  portId: 'out' }, to: { nodeId: 'bd', portId: 'in_b'    }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_l', from: { nodeId: 'mask_l', portId: 'out' }, to: { nodeId: 'bd', portId: 'lighten' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_d', from: { nodeId: 'mask_d', portId: 'out' }, to: { nodeId: 'bd', portId: 'darken'  }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_out', from: { nodeId: 'bd',   portId: 'out' }, to: { nodeId: 'v-out', portId: 'in'   }, sourceType: 'video',      targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-backdraft'), 'BACKDRAFT visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),  'OUTPUT visible').toBeVisible();
    await expect(page.locator('[data-testid="backdraft-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="backdraft-canvas"]')).toHaveCount(1);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas, 'video-out canvas in DOM').toHaveCount(1);

    // Let the feedback loop run a bunch of frames.
    await page.waitForTimeout(800);

    // The output should be non-trivial (feedback trails + masks). Assert a
    // spread of pixel values (variance) rather than pixel-exact — that's
    // the VRT suite's job.
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
    expect(stats!.nonZeroFrac, 'output is not all-black (feedback rendered)').toBeGreaterThan(0.02);
    expect(stats!.variance, 'output has spatial structure (trails + masks)').toBeGreaterThan(20);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('FREEZE holds the output still (deterministic capture hook)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'src_a', type: 'shapes',    position: { x: 40,  y: 40 }, domain: 'video', params: { shape: 0, zoom: 1.6 } },
        { id: 'bd',    type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video', params: { feedback: 1.1, delay: 16 } },
        { id: 'v-out', type: 'videoOut',  position: { x: 980, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e_a',   from: { nodeId: 'src_a', portId: 'out' }, to: { nodeId: 'bd',    portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_out', from: { nodeId: 'bd',    portId: 'out' }, to: { nodeId: 'v-out', portId: 'in'   }, sourceType: 'video',      targetType: 'video' },
      ],
    );

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(500);

    // Freeze BACKDRAFT.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['bd'];
        if (n) n.params.freeze = 1;
      });
    });
    await page.waitForTimeout(150);

    const sample = (): Promise<number[]> =>
      canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return [];
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const out: number[] = [];
        for (let i = 0; i < d.length; i += 4 * 64) out.push(d[i]!);
        return out;
      });

    const a = await sample();
    await page.waitForTimeout(200);
    const b = await sample();

    // Frozen: the two samples (200ms apart, many rAFs) should be identical.
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  test('faders route through the patch store', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'bd', type: 'backdraft', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="backdraft-card"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['bd'];
        if (!n) return;
        n.params.feedback = 1.2;
        n.params.chroma = 1.8;
        n.params.darken = 0.4;
      });
    });
    await page.waitForTimeout(120);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['bd'];
      return { fb: n?.params.feedback, ch: n?.params.chroma, dk: n?.params.darken };
    });
    expect(params.fb).toBe(1.2);
    expect(params.ch).toBe(1.8);
    expect(params.dk).toBe(0.4);
  });
});
