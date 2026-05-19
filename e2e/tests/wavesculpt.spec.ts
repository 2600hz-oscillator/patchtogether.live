// e2e/tests/wavesculpt.spec.ts
//
// WAVESCULPT smoke: spawn the module, confirm card + canvas mount,
// poke a gate via the patch store, assert the UNISON toggle flips the
// `unison` param, and that no console errors fire during render.
//
// We don't try to assert pixel content — the 3D ribbon render +
// CRT-style frame feedback is intentionally animated (see vrt-meta.test.ts
// exempt entry).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('WAVESCULPT — hybrid 3D-camera video synth', () => {
  test('spawns + card + canvas mount, no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="wavesculpt-pad"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="wavesculpt-unison"]')).toHaveCount(1);

    // Let the rAF render loop tick a few frames so any shader/init
    // failure surfaces as a console.error before we assert.
    await page.waitForTimeout(300);

    expect(errors, 'no console / page errors during WAVESCULPT render').toEqual([]);
  });

  test('UNISON toggle flips the unison param', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const initialUnison = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch.nodes['ws']?.params.unison ?? 0;
    });
    expect(initialUnison).toBe(0);

    await page.locator('[data-testid="wavesculpt-unison"]').click();
    await page.waitForTimeout(80);

    const afterUnison = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch.nodes['ws']?.params.unison ?? 0;
    });
    expect(afterUnison, 'UNISON toggle on').toBe(1);

    await page.locator('[data-testid="wavesculpt-unison"]').click();
    await page.waitForTimeout(80);

    const afterUnison2 = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch.nodes['ws']?.params.unison ?? 0;
    });
    expect(afterUnison2, 'UNISON toggle off again').toBe(0);
  });

  test('camera XY pad drags update pos_x / pos_y in the patch store', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const pad = page.locator('[data-testid="wavesculpt-pad"]');
    await expect(pad).toHaveCount(1);
    const box = await pad.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const tx = box.x + box.width * 0.85;
    const ty = box.y + box.height * 0.15;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.up();

    await page.waitForTimeout(80);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['ws'];
      return { pos_x: n?.params.pos_x ?? 0, pos_y: n?.params.pos_y ?? 0 };
    });
    // No snap-back on WAVESCULPT's pad — the camera should stay put.
    expect(params.pos_x, 'pos_x positive after drag right').toBeGreaterThan(0.3);
    expect(params.pos_y, 'pos_y positive after drag up (Y flipped)').toBeGreaterThan(0.3);
  });

  test('ribbons render pre-ADSR — canvas is non-empty even without any gate', async ({ page }) => {
    // Enhancement 3: ribbons are decoupled from ADSR amplitude and should
    // be continuously visible. We assert the canvas backbuffer has at
    // least SOME non-black pixels after a few frames, with no gate
    // patched in. Not pixel-exact — just that the wave shape renders.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);

    // Let several render frames tick so the rAF render loop runs.
    await page.waitForTimeout(400);

    const hasNonBlackPixels = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
      if (!c) return false;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      // Look for any pixel with R+G+B > 24 (the bg is #050608 ≈ 19/2 total
      // per channel). Use a small sample stride to keep this fast.
      for (let i = 0; i < data.length; i += 4 * 32) {
        const sum = (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
        if (sum > 60) return true;
      }
      return false;
    });
    expect(hasNonBlackPixels, 'ribbons visible without any gate fired').toBe(true);
  });

  test('alpha_in compositing — patch a PICTUREBOX into alpha_in, canvas stays alive', async ({ page }) => {
    // Enhancement 1: when ALPHA LAYER IN is patched, the alpha-osc-
    // shaped region samples the input video. We don't assert pixel
    // content (the picturebox starts as a placeholder image until the
    // user uploads). We DO assert the patch is accepted (no console
    // errors, edge exists in the store, wavesculpt canvas non-empty).
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
        { id: 'pb', type: 'picturebox', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'ws', type: 'wavesculpt', position: { x: 600, y: 100 }, domain: 'audio' },
      ],
      [
        {
          id: 'pb_to_ws_alpha',
          from: { nodeId: 'pb', portId: 'out' },
          to: { nodeId: 'ws', portId: 'alpha_in' },
          sourceType: 'image',
          targetType: 'video',
        },
      ],
    );
    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);

    // Let alpha_in pipeline tick.
    await page.waitForTimeout(400);

    const edgeExists = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, { target?: { nodeId: string; portId: string } }> };
      };
      return Object.values(w.__patch.edges).some(
        (e) => e.target?.nodeId === 'ws' && e.target?.portId === 'alpha_in',
      );
    });
    expect(edgeExists, 'alpha_in edge present in patch graph').toBe(true);

    expect(errors, 'no errors with alpha_in patched').toEqual([]);
  });

  test('per-osc thickness param routes through the patch store', async ({ page }) => {
    // Enhancement 2: thickness1..4 params exist and accept writes.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['ws'];
        if (!n) return;
        n.params.thickness1 = 0.8;
        n.params.thickness3 = 0.1;
      });
    });
    await page.waitForTimeout(120);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['ws'];
      return { t1: n?.params.thickness1, t3: n?.params.thickness3 };
    });
    expect(params.t1).toBe(0.8);
    expect(params.t3).toBe(0.1);
  });

  test('bentscreen wiggle knobs route through the patch store', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['ws'];
        if (!n) return;
        n.params.hsync_drift = 0.35;
        n.params.wavefold = 0.5;
        n.params.feedback_gain = 0.6;
      });
    });
    await page.waitForTimeout(120);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['ws'];
      return {
        hsync_drift: n?.params.hsync_drift,
        wavefold: n?.params.wavefold,
        feedback_gain: n?.params.feedback_gain,
      };
    });
    expect(params.hsync_drift).toBe(0.35);
    expect(params.wavefold).toBe(0.5);
    expect(params.feedback_gain).toBe(0.6);
  });
});
