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
