// e2e/tests/bentbox.spec.ts
//
// BENTBOX smoke: spawn the module, confirm its card + canvas mount, drive
// a CV-controlled bending knob, assert no console errors. The module is a
// video-domain OUTPUT — we don't try to assert pixel content (animated by
// design — see vrt-meta.test.ts exempt entry).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('BENTBOX — CRT-emulation output', () => {
  test('spawns + canvas mounts + no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Spawn a SHAPES source feeding into BENTBOX so the bending pipeline
    // has real input to chew on (shapes is a video source already in the
    // registry; mirrors how monoglitch/feedback specs pair source+sink).
    await spawnPatch(
      page,
      [
        { id: 'shapes', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'bb',     type: 'bentbox', position: { x: 500, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e-shapes-bb', source: 'shapes', sourceHandle: 'out', target: 'bb', targetHandle: 'in' },
      ],
    );

    await expect(
      page.locator('.svelte-flow__node-bentbox'),
      'BENTBOX node visible',
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="bentbox-card"]'),
      'BENTBOX card present',
    ).toHaveCount(1);

    const canvas = page.locator('[data-testid="bentbox-canvas"]');
    await expect(canvas, 'BENTBOX canvas mounted').toHaveCount(1);

    // Confirm the canvas has a positive size (it's been laid out, not
    // collapsed). 4:3 letterbox math means width should at least exceed
    // the minimum card-width minus padding.
    const dims = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return { width: c.width, height: c.height };
    });
    expect(dims.width, 'canvas has positive width').toBeGreaterThan(100);
    expect(dims.height, 'canvas has positive height').toBeGreaterThan(50);

    // Let the rAF loop tick a few frames so the CRT pipeline runs at least
    // once with real input (and the feedback ping-pong fills its empty
    // sentinel).
    await page.waitForTimeout(250);

    expect(errors, 'no console / page errors during BENTBOX render').toEqual([]);
  });

  test('CV-bending knobs mutate params via patch store', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'bb', type: 'bentbox', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="bentbox-card"]')).toHaveCount(1);

    // Drive a bending knob via direct patch-store mutation (the same path
    // CV inputs use after the engine bridge writes through). Sweeping
    // hsync_drift + wavefold is what produces the canonical AVEmod look.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['bb'];
        if (!n) return;
        n.params.hsync_drift = 0.4;
        n.params.wavefold    = 0.6;
        n.params.feedback_gain = 0.5;
      });
    });
    await page.waitForTimeout(120);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['bb'];
      return {
        hsync_drift: n?.params.hsync_drift,
        wavefold: n?.params.wavefold,
        feedback_gain: n?.params.feedback_gain,
      };
    });

    expect(params.hsync_drift).toBe(0.4);
    expect(params.wavefold).toBe(0.6);
    expect(params.feedback_gain).toBe(0.5);
  });

  test('resize handle is present + drag grows the card', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'bb', type: 'bentbox', position: { x: 200, y: 100 }, domain: 'video' },
    ]);

    const card = page.locator('[data-testid="bentbox-card"]');
    const handle = page.locator('[data-testid="bentbox-resize-handle"]');
    await expect(card).toHaveCount(1);
    await expect(handle, 'resize handle present').toHaveCount(1);

    const initial = await card.evaluate(
      (el) => (el as HTMLElement).getBoundingClientRect(),
    );

    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 100, sy + 80, { steps: 5 });
    await page.mouse.move(sx + 200, sy + 160, { steps: 5 });
    await page.mouse.up();

    await page.waitForTimeout(150);

    const after = await card.evaluate(
      (el) => (el as HTMLElement).getBoundingClientRect(),
    );
    expect(after.width, `card grew horizontally (${initial.width} -> ${after.width})`)
      .toBeGreaterThan(initial.width + 20);
    expect(after.height, `card grew vertically (${initial.height} -> ${after.height})`)
      .toBeGreaterThan(initial.height + 20);
  });
});
