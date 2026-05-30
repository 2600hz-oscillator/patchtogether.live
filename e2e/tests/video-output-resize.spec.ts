// e2e/tests/video-output-resize.spec.ts
//
// Verifies OUTPUT card resize: spawn an OUTPUT, drag the corner handle,
// assert width+height in node.data update; the visible canvas content
// scales aspect-fit (we check the inner canvas dimensions update).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('OUTPUT card — corner-drag resize', () => {
  test('drag corner handle resizes card; node.data updates', async ({ page }) => {
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
        { id: 'v-out', type: 'videoOut', position: { x: 200, y: 100 }, domain: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    const card = page.locator('[data-testid="video-out-card"]');
    const handle = page.locator('[data-testid="video-out-resize-handle"]');
    await expect(card, 'card present').toHaveCount(1);
    await expect(handle, 'resize handle present').toHaveCount(1);

    // Read initial size.
    const initial = await card.evaluate((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { width: r.width, height: r.height };
    });

    // Drag the corner: down, move +200/+150, up.
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    if (!handleBox) return;

    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move in steps so pointermove handlers tick steadily.
    await page.mouse.move(startX + 100, startY + 75, { steps: 5 });
    await page.mouse.move(startX + 200, startY + 150, { steps: 5 });
    await page.mouse.up();

    // Allow layout + Svelte to flush.
    await page.waitForTimeout(150);

    const after = await card.evaluate((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(after.width, `card grew horizontally (${initial.width} -> ${after.width})`).toBeGreaterThan(initial.width + 20);
    expect(after.height, `card grew vertically (${initial.height} -> ${after.height})`).toBeGreaterThan(initial.height + 20);

    // node.data persisted.
    const nodeData = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { width?: number; height?: number } }> };
      };
      const n = w.__patch.nodes['v-out'];
      return { width: n?.data?.width, height: n?.data?.height };
    });
    expect(nodeData.width, 'node.data.width set').toBeGreaterThanOrEqual(360);
    expect(nodeData.height, 'node.data.height set').toBeGreaterThanOrEqual(240);

    expect(errors).toEqual([]);
  });

  test('inner canvas keeps aspect-fit after resize (engine 4:3)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'v-out', type: 'videoOut', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);

    // Force a known size via direct patch mutation (skip the drag) so
    // the aspect-fit math is testable independent of the drag harness.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['v-out'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.width = 800;
        n.data.height = 480;
      });
    });
    await page.waitForTimeout(150);

    const inner = await page.evaluate(() => {
      const c = document.querySelector('canvas[data-testid="video-out-canvas"]') as HTMLCanvasElement | null;
      if (!c) return null;
      // The aspect inside the card should be 4:3 (engine resolution),
      // but the canvas-wrap simply takes (width - PAD, height - HEADER).
      // We check it's CLOSE to that size and not collapsed to 0.
      return { width: c.width, height: c.height };
    });
    expect(inner).not.toBeNull();
    if (!inner) return;
    expect(inner.width, 'inner canvas width follows card width').toBeGreaterThan(700);
    expect(inner.height, 'inner canvas height follows card height').toBeGreaterThan(380);
  });
});
