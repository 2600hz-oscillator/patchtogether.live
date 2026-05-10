// e2e/tests/video-hide-controls.spec.ts
//
// Verifies the hide-controls + free-resize gesture on RUTTETRA + MONOGLITCH:
//   1. Click the hide-toggle - controls hide, canvas remains, card becomes
//      resizable via the corner handle.
//   2. Drag the corner handle - card grows, node.data.resizedWidth/height
//      update.
//   3. Double-click the card body - hide-controls clears + size resets.
// Also asserts:
//   - OUTPUT (videoOut) keeps its existing always-resizable behavior
//     (regression on PR-85 / VideoOutCard's data.width / data.height path).
//   - Double-clicking on a .svelte-flow__handle inside the card still
//     reaches the document-level patch-to listener (PR-113 regression).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface NodeDataShape {
  hideControls?: boolean;
  resizedWidth?: number;
  resizedHeight?: number;
  width?: number;
  height?: number;
}

async function readNodeData(page: Page, id: string): Promise<NodeDataShape> {
  return page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: NodeDataShape }> };
    };
    return (w.__patch.nodes[nid]?.data ?? {}) as NodeDataShape;
  }, id);
}

async function clickHideToggle(page: Page, testid: string): Promise<void> {
  const btn = page.locator(`[data-testid="${testid}"]`);
  await expect(btn, `${testid} present`).toBeVisible();
  await btn.click();
}

async function expectControlsHidden(page: Page, controlsTestid: string): Promise<void> {
  await expect(
    page.locator(`[data-testid="${controlsTestid}"]`),
    `${controlsTestid} hidden`,
  ).toHaveCount(0);
}

async function dragCorner(
  page: Page,
  handleTestid: string,
  dx: number,
  dy: number,
): Promise<void> {
  const handle = page.locator(`[data-testid="${handleTestid}"]`);
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx / 2, sy + dy / 2, { steps: 5 });
  await page.mouse.move(sx + dx, sy + dy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

async function cardBoundingSize(
  page: Page,
  cardTestid: string,
): Promise<{ width: number; height: number }> {
  return page.locator(`[data-testid="${cardTestid}"]`).evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
}

interface ModuleSpec {
  type: 'ruttetra' | 'monoglitch';
  cardTestid: string;
  toggleTestid: string;
  resizeTestid: string;
  controlsTestid: string;
  canvasTestid: string;
}

const MODULES: ModuleSpec[] = [
  {
    type: 'ruttetra',
    cardTestid: 'ruttetra-card',
    toggleTestid: 'ruttetra-hide-toggle',
    resizeTestid: 'ruttetra-resize-handle',
    controlsTestid: 'ruttetra-controls',
    canvasTestid: 'ruttetra-canvas',
  },
  {
    type: 'monoglitch',
    cardTestid: 'monoglitch-card',
    toggleTestid: 'monoglitch-hide-toggle',
    resizeTestid: 'monoglitch-resize-handle',
    controlsTestid: 'monoglitch-controls',
    canvasTestid: 'monoglitch-canvas',
  },
];

for (const m of MODULES) {
  test.describe(`${m.type.toUpperCase()} - hide-controls + free resize`, () => {
    test('hide -> resize -> dblclick restore', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await spawnPatch(page, [
        { id: 'v', type: m.type, position: { x: 200, y: 100 }, domain: 'video' },
      ]);

      const card = page.locator(`[data-testid="${m.cardTestid}"]`);
      await expect(card).toHaveCount(1);
      await expect(
        page.locator(`[data-testid="${m.controlsTestid}"]`),
        'controls visible by default',
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="${m.canvasTestid}"]`),
        'canvas visible by default',
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="${m.resizeTestid}"]`),
        'resize handle absent by default',
      ).toHaveCount(0);

      await clickHideToggle(page, m.toggleTestid);

      await expectControlsHidden(page, m.controlsTestid);
      await expect(
        page.locator(`[data-testid="${m.canvasTestid}"]`),
        'canvas still visible in hide-controls mode',
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="${m.resizeTestid}"]`),
        'resize handle appears in hide-controls mode',
      ).toBeVisible();
      const dataAfterHide = await readNodeData(page, 'v');
      expect(dataAfterHide.hideControls, 'hideControls flagged true').toBe(true);

      const sizeBeforeDrag = await cardBoundingSize(page, m.cardTestid);
      await dragCorner(page, m.resizeTestid, 200, 150);
      const sizeAfterDrag = await cardBoundingSize(page, m.cardTestid);
      expect(
        sizeAfterDrag.width,
        `card grew (${sizeBeforeDrag.width} -> ${sizeAfterDrag.width})`,
      ).toBeGreaterThan(sizeBeforeDrag.width + 20);
      expect(
        sizeAfterDrag.height,
        `card grew (${sizeBeforeDrag.height} -> ${sizeAfterDrag.height})`,
      ).toBeGreaterThan(sizeBeforeDrag.height + 20);

      const dataAfterDrag = await readNodeData(page, 'v');
      expect(dataAfterDrag.resizedWidth, 'resizedWidth persisted').toBeGreaterThan(360);
      expect(dataAfterDrag.resizedHeight, 'resizedHeight persisted').toBeGreaterThan(240);

      // Double-click on the card body (not on a handle) to restore.
      await card.dblclick({ position: { x: 30, y: 80 } });
      await page.waitForTimeout(120);

      const dataAfterRestore = await readNodeData(page, 'v');
      expect(dataAfterRestore.hideControls, 'hideControls cleared').toBeFalsy();
      expect(dataAfterRestore.resizedWidth, 'resizedWidth cleared').toBeUndefined();
      expect(dataAfterRestore.resizedHeight, 'resizedHeight cleared').toBeUndefined();

      await expect(
        page.locator(`[data-testid="${m.controlsTestid}"]`),
        'controls back after restore',
      ).toBeVisible();

      expect(errors).toEqual([]);
    });
  });
}

test.describe('OUTPUT regression', () => {
  test('videoOut keeps existing data.width/data.height resize behavior', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'v-out', type: 'videoOut', position: { x: 200, y: 100 }, domain: 'video' },
    ]);

    const card = page.locator('[data-testid="video-out-card"]');
    await expect(card).toHaveCount(1);
    await expect(page.locator('[data-testid="video-out-resize-handle"]')).toBeVisible();
    // OUTPUT should NOT have a hide-toggle button (it's already minimal).
    await expect(page.locator('[data-testid="video-out-hide-toggle"]')).toHaveCount(0);

    const before = await cardBoundingSize(page, 'video-out-card');
    await dragCorner(page, 'video-out-resize-handle', 180, 120);
    const after = await cardBoundingSize(page, 'video-out-card');
    expect(after.width).toBeGreaterThan(before.width + 20);
    expect(after.height).toBeGreaterThan(before.height + 20);

    const data = await readNodeData(page, 'v-out');
    expect(data.width, 'OUTPUT still uses node.data.width').toBeGreaterThanOrEqual(360);
    expect(data.height, 'OUTPUT still uses node.data.height').toBeGreaterThanOrEqual(240);
    expect(data.resizedWidth, 'OUTPUT does NOT use new resizedWidth key').toBeUndefined();
  });
});

test.describe('PR-113 regression - handle dblclick still opens patch-to', () => {
  test('dblclick on a Handle inside RUTTETRA opens the port menu', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'r', type: 'ruttetra', position: { x: 200, y: 100 }, domain: 'video' },
      { id: 'l', type: 'lines', position: { x: 600, y: 100 }, domain: 'video' },
    ]);

    const card = page.locator('[data-testid="ruttetra-card"]');
    await expect(card).toHaveCount(1);

    const handle = page
      .locator('.svelte-flow__node-ruttetra .svelte-flow__handle.source')
      .first();
    await expect(handle).toBeVisible();
    await handle.dblclick();

    await expect(
      page.locator('[data-testid="port-context-menu"]'),
      'port-to cascade opened from handle dblclick',
    ).toBeVisible();
  });
});
