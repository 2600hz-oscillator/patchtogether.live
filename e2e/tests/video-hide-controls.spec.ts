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
      // RUTTETRA renders a 320×180 LINE grid (~57k grid points) into its
      // on-card preview every animation frame — by far the heaviest
      // per-frame GL work in the suite. On a loaded CI runner that draw loop
      // starves the main thread, so the multi-step corner-resize drag
      // (page.mouse.move with {steps:5}, twice) can take several seconds per
      // move (~3.5s each was observed on shard 8/8), pushing the whole test
      // past the default 30s budget even though every assertion ultimately
      // passes. Give the heavy-WebGL cards the same headroom the video/DOOM
      // specs already grant (picturebox-limits, multi-video, etc.). Cheap
      // fullscreen-quad cards (MONOGLITCH) finish well under this.
      test.setTimeout(60_000);

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

  // Folded in from video-output-resize.spec.ts (consolidation §2): the corner-drag
  // resize itself is the dup the test above already covers (same dragCorner +
  // node.data.width/height); the UNIQUE leg is that after a known size is forced,
  // the INNER canvas dimensions follow the card (aspect-fit, not collapsed to 0).
  // We set the size directly via patch mutation (skip the drag) so the aspect-fit
  // math is testable independent of the drag harness.
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

test.describe('PR-113 regression - handle dblclick still opens patch-to', () => {
  // Uses CHROMA — a RAW-handle card (visible side jacks). RUTTETRA was the
  // original fixture, but the #767 sweep moved it onto the yellow PatchPanel
  // menu, where the patch-trigger button covers the hidden handle stack and
  // intercepts the dblclick (only the real-GPU attest lane runs this heavy spec,
  // so regular shards never caught the regression). PatchPanel cards patch via
  // the drill-down menu — that path is covered by cable-drag-drilldown.spec;
  // THIS test asserts the raw-handle dblclick→patch-to cascade still works, so it
  // needs a card that still exposes raw side handles.
  test('dblclick on a Handle inside a raw-handle card opens the port menu', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'c', type: 'chroma', position: { x: 200, y: 100 }, domain: 'video' },
      { id: 'l', type: 'lines', position: { x: 600, y: 100 }, domain: 'video' },
    ]);

    const card = page.locator('.svelte-flow__node-chroma');
    await expect(card).toHaveCount(1);

    const handle = page
      .locator('.svelte-flow__node-chroma .svelte-flow__handle.source')
      .first();
    await expect(handle).toBeVisible();
    await handle.dblclick();

    await expect(
      page.locator('[data-testid="port-context-menu"]'),
      'port-to cascade opened from handle dblclick',
    ).toBeVisible();
  });
});
