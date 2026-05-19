// e2e/tests/joystick.spec.ts
//
// JOYSTICK smoke: spawn the module, assert the XY pad mounts, drag
// the dot, confirm the CV outputs (pos_x / pos_y) update via the patch
// store, and that pointer-up snaps back to center.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('JOYSTICK — XY CV utility', () => {
  test('spawns + pad mounts + no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'j1', type: 'joystick', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    await expect(page.locator('[data-testid="joystick-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="joystick-pad"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="joystick-dot"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="joystick-readout"]')).toHaveCount(1);

    await page.waitForTimeout(80);
    expect(errors, 'no console / page errors during JOYSTICK render').toEqual([]);
  });

  test('drag updates pos_x + pos_y; pointer-up snaps back', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'j1', type: 'joystick', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const pad = page.locator('[data-testid="joystick-pad"]');
    await expect(pad).toHaveCount(1);
    const box = await pad.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // Drag from center toward the upper-right corner. Expect pos_x > 0.3
    // and pos_y > 0.3 (positive y is "up").
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const tx = box.x + box.width * 0.85;
    const ty = box.y + box.height * 0.15;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });

    // Still holding — sample the params.
    const heldParams = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['j1'];
      return { pos_x: n?.params.pos_x ?? 0, pos_y: n?.params.pos_y ?? 0 };
    });
    expect(heldParams.pos_x, 'pos_x positive after drag right').toBeGreaterThan(0.3);
    expect(heldParams.pos_y, 'pos_y positive after drag up (Y flipped)').toBeGreaterThan(0.3);

    // Release — should snap back to center.
    await page.mouse.up();
    await page.waitForTimeout(120);

    const releasedParams = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['j1'];
      return { pos_x: n?.params.pos_x ?? 99, pos_y: n?.params.pos_y ?? 99 };
    });
    expect(releasedParams.pos_x, 'pos_x snapped to 0').toBeCloseTo(0, 3);
    expect(releasedParams.pos_y, 'pos_y snapped to 0').toBeCloseTo(0, 3);
  });
});
