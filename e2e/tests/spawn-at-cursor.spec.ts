// e2e/tests/spawn-at-cursor.spec.ts
//
// Cursor-anchored spawn + on-top stacking. Two invariants the user explicitly
// asked for:
//
//   1. A new module is placed UNDER THE MOUSE CURSOR even when that point
//      lands on top of an existing module. The previous behavior nudged the
//      new card down-right by STACK_OFFSET (24px) until it cleared every
//      sibling — that worked but didn't match the "spawn here, I mean it"
//      reflex.
//
//   2. The new module RENDERS ON TOP of any cards it overlaps so the user
//      can see what they just added without having to drag the existing
//      cards out of the way first. Implemented in Canvas.svelte by tracking
//      a `topNodeId` and applying xyflow's `zIndex: 1000` to that node in
//      the snapshot → flowNodes mapping. The lift is cleared the moment the
//      user drags or deletes a different node so subsequent overlap
//      interactions follow normal stacking order.
//
// We assert via the dev-mode `__patch` + `__flow` + `__spawnAtFlowPos`
// globals (Canvas exposes them under import.meta.env.DEV). Same pattern
// the organize-modules suite uses; keeps tests stable against fitView.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface NodePos { x: number; y: number }
interface PatchNode { id: string; type: string; position: NodePos }

async function readNodes(page: Page): Promise<PatchNode[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return Object.values(w.__patch.nodes).filter(Boolean) as PatchNode[];
  });
}

async function paneBox(page: Page) {
  const pane = page.locator('.svelte-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane bounding box');
  return box;
}

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const w = window as unknown as { __patch?: unknown; __flow?: unknown };
    return !!w.__patch && !!w.__flow;
  });
}

// ============================================================================
// Cursor-anchored spawn (overlap allowed)
// ============================================================================

test('spawn lands at the requested cursor position even when overlapping', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [{ id: 'a', type: 'mixer', position: { x: 300, y: 250 } }]);
  await page.evaluate(() => {
    const w = window as unknown as {
      __spawnAtFlowPos: (type: string, p: NodePos) => void;
    };
    w.__spawnAtFlowPos('reverb', { x: 300, y: 250 });
  });
  const nodes = await readNodes(page);
  const reverb = nodes.find((n) => n.type === 'reverb');
  expect(reverb).toBeTruthy();
  // Exact match — the new card sits at the requested coords, not auto-offset.
  expect(reverb!.position).toEqual({ x: 300, y: 250 });
});

test('right-click spawn anchors at the click point with no auto-offset', async ({ page }) => {
  await ready(page);
  // Pre-populate one module so the right-click might land on top of it
  // depending on viewport. We directly drive the deterministic flow-space
  // path via the dev hook to avoid pixel-fitView-coupling, then verify
  // the spawn sits exactly where requested.
  await spawnPatch(page, [{ id: 'pre', type: 'mixer', position: { x: 0, y: 0 } }]);
  await page.evaluate(() => {
    const w = window as unknown as {
      __spawnAtFlowPos: (type: string, p: NodePos) => void;
    };
    w.__spawnAtFlowPos('lfo', { x: 0, y: 0 });
  });
  const nodes = await readNodes(page);
  const lfo = nodes.find((n) => n.type === 'lfo');
  expect(lfo).toBeTruthy();
  expect(lfo!.position).toEqual({ x: 0, y: 0 });
});

// ============================================================================
// Visual on-top stacking via xyflow zIndex
// ============================================================================

test('newly-spawned overlapping module renders ON TOP via elevated zIndex', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [{ id: 'underneath', type: 'mixer', position: { x: 200, y: 200 } }]);
  await page.evaluate(() => {
    const w = window as unknown as {
      __spawnAtFlowPos: (type: string, p: NodePos) => void;
    };
    w.__spawnAtFlowPos('reverb', { x: 200, y: 200 });
  });
  // xyflow renders the per-node zIndex onto the .svelte-flow__node element
  // as inline style: `z-index: <n>;`. The mixer keeps the default (0); the
  // reverb gets 1000 from topNodeId.
  const reverbNode = page.locator('.svelte-flow__node-reverb').first();
  const mixerNode = page.locator('.svelte-flow__node-mixer').first();
  await expect(reverbNode).toBeVisible();
  await expect(mixerNode).toBeVisible();
  const reverbZ = await reverbNode.evaluate((el) => Number((el as HTMLElement).style.zIndex || '0'));
  const mixerZ = await mixerNode.evaluate((el) => Number((el as HTMLElement).style.zIndex || '0'));
  expect(reverbZ).toBeGreaterThan(mixerZ);
});

test('elementFromPoint at the overlap center returns the newly-spawned card', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [{ id: 'underneath', type: 'mixer', position: { x: 400, y: 300 } }]);
  // Wait for the underneath card to settle so its rect is stable, then
  // spawn at the same flow-coord. Use a measured-rect center for the hit
  // test so we're testing visual stacking, not flow-coord math.
  const underneathBox = await page.locator('.svelte-flow__node-mixer').first().boundingBox();
  expect(underneathBox).toBeTruthy();
  const flowPos = await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { position: NodePos }> };
    };
    return w.__patch.nodes['underneath'].position;
  });
  await page.evaluate((pos) => {
    const w = window as unknown as {
      __spawnAtFlowPos: (type: string, p: NodePos) => void;
    };
    w.__spawnAtFlowPos('reverb', pos);
  }, flowPos);
  // Wait for the reverb DOM to mount.
  await expect(page.locator('.svelte-flow__node-reverb')).toHaveCount(1);
  // Hit test: at any point inside the underneath card's rect that the new
  // card also covers, the topmost element should belong to the reverb.
  const reverbBox = await page.locator('.svelte-flow__node-reverb').first().boundingBox();
  expect(reverbBox).toBeTruthy();
  const overlapCenterX = Math.max(underneathBox!.x, reverbBox!.x)
    + Math.min(underneathBox!.x + underneathBox!.width, reverbBox!.x + reverbBox!.width)
    >> 1; // integer midpoint of the overlap interval
  const overlapCenterY = Math.max(underneathBox!.y, reverbBox!.y)
    + Math.min(underneathBox!.y + underneathBox!.height, reverbBox!.y + reverbBox!.height)
    >> 1;
  const hitNodeId = await page.evaluate(
    (pt) => {
      const el = document.elementFromPoint(pt.x, pt.y) as HTMLElement | null;
      const node = el?.closest('.svelte-flow__node');
      return node?.getAttribute('data-id') ?? null;
    },
    { x: overlapCenterX, y: overlapCenterY },
  );
  // The hit must be the reverb (the most-recently-spawned card), not the
  // underneath mixer.
  expect(hitNodeId).not.toBeNull();
  expect(hitNodeId).not.toBe('underneath');
  // Sanity: the hit id is the reverb's data-id.
  const reverbId = await page.locator('.svelte-flow__node-reverb').first().getAttribute('data-id');
  expect(hitNodeId).toBe(reverbId);
});

test('spawn → palette UI flow: cursor-anchored at right-click point with overlap allowed', async ({ page }) => {
  // End-to-end through the palette right-click (not just the dev hook).
  // Place an existing module at flow-origin, right-click an empty area of
  // the pane (avoid the bottom-right where the minimap + Controls overlay
  // sit), then pick a module from the palette — the new card sits exactly
  // at the click in flow-space.
  await ready(page);
  await spawnPatch(page, [{ id: 'first', type: 'mixer', position: { x: 0, y: 0 } }]);
  const box = await paneBox(page);
  // Click in the upper-mid area of the pane: well clear of the topbar
  // (header), the bottom-right minimap, and the bottom-left Controls
  // affordance. The mixer's measured DOM rect tells us where to dodge.
  const mixerBox = await page.locator('.svelte-flow__node-mixer').first().boundingBox();
  const safeX = mixerBox
    ? Math.min(mixerBox.x + mixerBox.width + 80, box.x + box.width - 220)
    : box.x + box.width / 2;
  const click = { x: safeX, y: box.y + 60 };
  const expected = await page.evaluate(
    (pt) => {
      const w = window as unknown as { __flow: { screenToFlowPosition: (p: NodePos) => NodePos } };
      return w.__flow.screenToFlowPosition(pt);
    },
    click,
  );
  await page.mouse.click(click.x, click.y, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  // Search-mode shortcut (nested-menu palette flattens results on type).
  await page.keyboard.type('Reverb');
  await page.keyboard.press('Enter');
  const nodes = await readNodes(page);
  const reverb = nodes.find((n) => n.type === 'reverb');
  expect(reverb).toBeTruthy();
  expect(Math.abs(reverb!.position.x - expected.x)).toBeLessThan(4);
  expect(Math.abs(reverb!.position.y - expected.y)).toBeLessThan(4);
});
