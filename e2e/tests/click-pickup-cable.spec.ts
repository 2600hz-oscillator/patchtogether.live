// e2e/tests/click-pickup-cable.spec.ts
//
// Drag-vs-click gesture differentiation on port handles.
//
// PR-204 (`fix/patch-menu-ux-streamline`) repurposed the fast-click
// gesture on a port handle: instead of activating xyflow's
// click-connect (pickup-mode cable that sticks to the cursor), a fast
// click now opens the "Patch to..." cascade menu (50 ms hold-timer fires
// either way; release inside that window also opens the menu via the
// click-fallback path). The original pickup-mode acceptance tests in
// this file were removed in PR-208 — they exercised the now-unreachable
// fast-click-→-pickup contract.
//
// What survives: the drag-vs-click differentiation. A normal
// mousedown-drag-mouseup MUST still enter xyflow's drag-connect flow
// (mode=dragging), NOT trip the hold timer's click-fallback (which
// opens the menu) and NOT engage pickup mode. The 5 px
// connectionDragThreshold is the boundary; this test pins it down.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

async function readPickupState(page: Page): Promise<{
  mode: string;
  active: boolean;
  sourcePortId: string | null;
}> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __connectDragState?: {
        mode: string;
        active: boolean;
        pickupSource: { portId: string } | null;
      };
    };
    return {
      mode: w.__connectDragState?.mode ?? 'idle',
      active: w.__connectDragState?.active ?? false,
      sourcePortId: w.__connectDragState?.pickupSource?.portId ?? null,
    };
  });
}

async function openPanel(page: Page, nodeId: string) {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(
    page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"]`),
  ).toHaveAttribute('aria-hidden', 'false');
  await page.waitForTimeout(200);
}

test.describe('PatchPanel: drag-vs-click differentiation', () => {
  test('drag past threshold uses drag flow, NOT pickup or menu', async ({ page }) => {
    // Regression: a normal mousedown-drag-mouseup must still enter xyflow's
    // drag-connect flow (mode=dragging), and the cable must commit on
    // pointerup over a compatible target handle.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'flt', type: 'filter', position: { x: 700, y: 100 } },
    ]);

    await openPanel(page, 'lfo');
    await openPanel(page, 'flt');

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const targetHandle = page.locator(
      `.svelte-flow__node[data-id="flt"] .svelte-flow__handle[data-handleid="cutoff"][class*="target"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    const tBox = await targetHandle.boundingBox();
    if (!sBox || !tBox) return;

    const sx = sBox.x + sBox.width / 2;
    const sy = sBox.y + sBox.height / 2;
    const tx = tBox.x + tBox.width / 2;
    const ty = tBox.y + tBox.height / 2;

    await page.mouse.move(sx, sy);
    await page.mouse.down();
    // Multi-step drag past the 5px threshold — xyflow fires onConnectStart.
    await page.mouse.move(sx + 30, sy + 10, { steps: 5 });
    // Mid-drag: mode is 'dragging', not 'pickup'.
    await expect
      .poll(async () => (await readPickupState(page)).mode, { timeout: 1500 })
      .toBe('dragging');

    // Move to target + release → commit via drag flow.
    await page.mouse.move(tx, ty, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(async () => (await readEdges(page)).length, { timeout: 1500 })
      .toBe(1);
    const after = await readPickupState(page);
    expect(after.mode, 'idle after drag commit').toBe('idle');
    // Drag never opens the patch-to cascade.
    await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
  });
});
