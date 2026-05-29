// e2e/tests/shapegen.spec.ts
//
// SHAPEGEN — smoke + I/O coverage for the standalone 3D-shape-generator
// video module extracted from FOXY. Confirms:
//   1. The module spawns + the card renders with NO console errors.
//   2. Wiring ONE raster input still produces a non-blank scene (the
//      wireframe box paints even with two unpatched rasters — the
//      generateShapes path degrades to an empty shape list cleanly).
//   3. Toggling SOLIDS produces a different rendered output (pixel
//      content changes), proving the renderer mode-switch is wired.
//
// Reference rig: a SHAPES procedural video source feeds raster_a; the
// other two inputs stay unpatched. The card's preview canvas is sampled
// via getImageData. We don't try to assert specific shape positions —
// those are pinned by the unit suite (shapegen.test.ts +
// shapegen-math.test.ts) without a browser in the loop.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('SHAPEGEN — 3D-shape-generator video module', () => {
  test('spawns + card mounts + preview canvas paints without errors', async ({ page }) => {
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
        { id: 'src',  type: 'shapes',   position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0 } },
        { id: 'sg',   type: 'shapegen', position: { x: 500, y: 100 }, domain: 'video' },
      ],
      [
        // Wire only raster_a — leave raster_b + raster_c unpatched. The
        // factory's readRasterTexture fall-back zero-fills the missing
        // buffers, generateShapes sees flat B/C (still emits shapes from
        // A's feature peaks though — B controls Z, C controls type/hue,
        // both default to 0 luma → all spheres in the back plane).
        { id: 'e_a', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'sg', portId: 'raster_a' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(
      page.locator('.svelte-flow__node-shapegen'),
      'SHAPEGEN node visible',
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="shapegen-card"]'),
      'SHAPEGEN card present',
    ).toHaveCount(1);

    const canvas = page.locator('[data-testid="shapegen-screen"]');
    await expect(canvas, 'SHAPEGEN preview canvas mounted').toHaveCount(1);

    // Let the rAF loop tick a few frames so the canvas2D paint runs +
    // gets blitted into the preview canvas (the card polls at ~30 Hz).
    await page.waitForTimeout(400);

    // Verify the canvas has SOMETHING — the wireframe box itself paints
    // even with no shapes, plus the BG_TOP/BG_BOT vertical gradient. We
    // assert non-trivial luma variance (the gradient + box edges differ
    // from a flat solid colour).
    const variance = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const lum = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
        sum += lum;
        n++;
      }
      const mean = sum / n;
      let v = 0;
      for (let i = 0; i < data.length; i += 4) {
        const lum = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
        const d = lum - mean;
        v += d * d;
      }
      return v / n;
    });
    // Variance > 5 — well above noise (a flat fill returns ~0). The
    // wireframe box + bg gradient + any shape silhouettes drive this.
    expect(variance, 'preview canvas paints non-flat content').toBeGreaterThan(5);

    expect(errors, 'no console / page errors during SHAPEGEN render').toEqual([]);
  });

  test('SOLIDS toggle changes the rendered pixel content', async ({ page }) => {
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
        { id: 'src', type: 'shapes',   position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0 } },
        // SIZE = 3 maxes the knob so the resulting spheres are big enough
        // for the wireframe-vs-solids fill difference to show up in a
        // canvas pixel sum (a 5-px sphere at the minimum baseline radius
        // is too small to register a measurable mean-luma shift).
        { id: 'sg',  type: 'shapegen', position: { x: 500, y: 100 }, domain: 'video', params: { size: 3 } },
      ],
      [
        { id: 'e_a', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'sg', portId: 'raster_a' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(page.locator('[data-testid="shapegen-card"]')).toHaveCount(1);
    const canvas = page.locator('[data-testid="shapegen-screen"]');

    // Settle initial render.
    await page.waitForTimeout(400);

    // Capture WIREFRAME-mode mean luma (solids=0 default).
    const lumaWireframe = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let s = 0;
      for (let i = 0; i < data.length; i += 4) s += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      return s / (data.length / 4);
    });

    // Flip SOLIDS on via the patch store + wait for the next paint.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['sg'];
        if (n) n.params.solids = 1;
      });
    });
    await page.waitForTimeout(300);

    const lumaSolids = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let s = 0;
      for (let i = 0; i < data.length; i += 4) s += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      return s / (data.length / 4);
    });

    // The wireframe vs solids paths fill primitives differently — the
    // solids renderer's gradient fills + visible cube faces shift the
    // average luma. The delta is feature-set-dependent: when the scene
    // happens to land on ring + tetraFrame (both stay wireframe in v1)
    // the delta is tiny. Threshold 0.05 confirms the branch DOES engage
    // (vs 0 if SOLIDS were a no-op) without depending on the random
    // primitive type pull. The composite VRT diff (idle vs solids) is
    // the deeper regression gate when we add it.
    expect(
      Math.abs(lumaSolids - lumaWireframe),
      `solids mode shifts mean luma (wf=${lumaWireframe.toFixed(2)}, solids=${lumaSolids.toFixed(2)})`,
    ).toBeGreaterThan(0.05);

    expect(errors, 'no console / page errors during SOLIDS toggle').toEqual([]);
  });

  test('SIZE + ROT knobs mutate params via the patch store', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'sg', type: 'shapegen', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="shapegen-card"]')).toHaveCount(1);

    // Set both knobs to non-default values.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['sg'];
        if (!n) return;
        n.params.size = 2;
        n.params.rotate = 0.5;
      });
    });
    await page.waitForTimeout(100);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['sg'];
      return {
        size: n?.params.size,
        rotate: n?.params.rotate,
      };
    });

    expect(params.size).toBe(2);
    expect(params.rotate).toBe(0.5);
  });
});
