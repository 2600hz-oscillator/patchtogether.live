// e2e/tests/click-pickup-cable.spec.ts
//
// Click-to-pickup-cable gesture: single-click a port handle, the cable
// "sticks" to the cursor (no mouse button held), then click a target
// port handle to commit the patch. Touchscreen-friendly alternative to
// the existing press-drag-release gesture; both must continue to work.
//
// Detection contract:
//   * mousedown + mouseup on the SAME handle without moving past
//     SvelteFlow's connectionDragThreshold (5px in Canvas.svelte) →
//     pickup mode activates.
//   * Subsequent click on a compatible handle → patch commits via the
//     same code path as drag-connect (handleConnect in Canvas.svelte).
//   * Esc → pickup state cleared, no edge created.
//   * Mousedown + drag past 5px → existing drag flow takes over,
//     pickup does NOT engage.
//
// The pickup-mode `active` getter is true alongside drag-mode `active`,
// so PatchPanel's drag-lock + section expand-all behaviour engages
// uniformly for both gestures. This covers the user-requested "single-
// click into nested-section target port" workflow.

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

test.describe('PatchPanel: click-to-pickup cable mode', () => {
  test('single-click on source handle activates pickup mode (mode=pickup, active=true)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'flt', type: 'filter', position: { x: 700, y: 100 } },
    ]);

    // Open the source panel so the handle is in its row position.
    await openPanel(page, 'lfo');

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    expect(sBox, 'source handle has box').toBeTruthy();
    if (!sBox) return;

    // A short tap that stays inside the 5px drag threshold: mousedown +
    // immediate mouseup at the same point. xyflow's Handle onpointerdown
    // never crosses the threshold so onConnectStart never fires; the
    // browser synthesises a click event and xyflow's onclick handler
    // stores clickConnectStartHandle → onclickconnectstart fires our
    // pickup handler.
    const cx = sBox.x + sBox.width / 2;
    const cy = sBox.y + sBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();

    await expect
      .poll(async () => (await readPickupState(page)).mode, { timeout: 1500 })
      .toBe('pickup');
    const state = await readPickupState(page);
    expect(state.active, 'connectDragState.active true in pickup mode').toBe(true);
    expect(state.sourcePortId, 'pickup source recorded').toBe('phase0');
  });

  test('pickup mode renders ghost cable that tracks the cursor', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'flt', type: 'filter', position: { x: 700, y: 100 } },
    ]);

    await openPanel(page, 'lfo');
    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    if (!sBox) return;
    const cx = sBox.x + sBox.width / 2;
    const cy = sBox.y + sBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();

    // Move cursor away so the cable has a non-degenerate path.
    await page.mouse.move(cx + 200, cy + 100);

    const ghost = page.locator('[data-testid="pickup-cable"]');
    await expect(ghost).toBeVisible();
    const d = await ghost.locator('path').getAttribute('d');
    expect(d, 'ghost cable path is non-empty').toBeTruthy();
    expect((d ?? '').length, 'ghost cable path has bezier data').toBeGreaterThan(10);
  });

  test('pickup then click target handle commits edge', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'flt', type: 'filter', position: { x: 700, y: 100 } },
    ]);

    // Open both panels so handles sit in their row positions.
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

    // Click source — initiates pickup.
    const sx = sBox.x + sBox.width / 2;
    const sy = sBox.y + sBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.up();

    await expect
      .poll(async () => (await readPickupState(page)).mode, { timeout: 1500 })
      .toBe('pickup');

    // Click target — commits via xyflow's onConnectExtended → handleConnect.
    const tx = tBox.x + tBox.width / 2;
    const ty = tBox.y + tBox.height / 2;
    await page.mouse.move(tx, ty);
    await page.mouse.down();
    await page.mouse.up();

    // Edge present.
    await expect
      .poll(async () => (await readEdges(page)).length, { timeout: 1500 })
      .toBe(1);
    const edges = await readEdges(page);
    expect(edges[0]!.source).toEqual({ nodeId: 'lfo', portId: 'phase0' });
    expect(edges[0]!.target).toEqual({ nodeId: 'flt', portId: 'cutoff' });

    // Pickup mode cleared on commit.
    const after = await readPickupState(page);
    expect(after.mode, 'pickup cleared after commit').toBe('idle');
    expect(after.active, 'active false after commit').toBe(false);
  });

  test('Esc cancels pickup mode without creating an edge', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'flt', type: 'filter', position: { x: 700, y: 100 } },
    ]);

    await openPanel(page, 'lfo');
    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    if (!sBox) return;
    const sx = sBox.x + sBox.width / 2;
    const sy = sBox.y + sBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.up();

    await expect
      .poll(async () => (await readPickupState(page)).mode, { timeout: 1500 })
      .toBe('pickup');

    await page.keyboard.press('Escape');
    await expect
      .poll(async () => (await readPickupState(page)).mode, { timeout: 1500 })
      .toBe('idle');
    const state = await readPickupState(page);
    expect(state.active, 'pickup cancelled by Esc').toBe(false);
    expect((await readEdges(page)).length, 'no edge created').toBe(0);
  });

  test('drag past threshold uses drag flow, NOT pickup', async ({ page }) => {
    // Regression: a normal mousedown-drag-mouseup must still enter the
    // drag flow (mode=dragging) — NOT pickup. The 5px connectionDragThreshold
    // is what differentiates the two gestures: a tap inside 5px is a click
    // (pickup); a movement past 5px is a drag.
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
  });

  test('pickup into a nested PatchPanel: section auto-expands + click commits', async ({
    page,
  }) => {
    // The pickup mode shares connectDragState.active with the drag mode,
    // so the nested-sections expand-all from PR-126 engages identically.
    // This verifies a user-requested workflow: tap LFO.phase0, move
    // cursor to MIXMSTRS's panel trigger, panel auto-opens, sections
    // auto-expand, tap a nested handle → patched.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'mm', type: 'mixmstrs', position: { x: 700, y: 100 } },
    ]);

    await openPanel(page, 'lfo');

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    if (!sBox) return;
    const sx = sBox.x + sBox.width / 2;
    const sy = sBox.y + sBox.height / 2;

    // Tap LFO source → pickup mode active.
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.up();

    await expect
      .poll(async () => (await readPickupState(page)).mode, { timeout: 1500 })
      .toBe('pickup');

    // Hover MIXMSTRS panel trigger so panel opens. (Hover-open works
    // because pickup mode does NOT capture the pointer — the cursor is
    // free, no button held.)
    const mmTrigger = page.locator(
      `.svelte-flow__node[data-id="mm"] [data-testid="patch-trigger"]`,
    );
    const triggerBox = await mmTrigger.boundingBox();
    if (!triggerBox) return;
    await page.mouse.move(
      triggerBox.x + triggerBox.width / 2,
      triggerBox.y + triggerBox.height / 2,
      { steps: 5 },
    );

    const mmPanel = page.locator(
      `.svelte-flow__node[data-id="mm"] [data-testid="patch-panel"]`,
    );
    await expect(mmPanel).toHaveAttribute('aria-hidden', 'false');

    // Every section auto-expanded via the shared expand-all-on-active
    // effect (PR-126 mechanism + this PR's recursion guard).
    await page.waitForTimeout(150);
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      const expanded = await page
        .locator(
          `.svelte-flow__node[data-id="mm"] ` +
            `[data-testid="patch-panel-section"][data-section-label="${label}"]`,
        )
        .getAttribute('data-section-expanded');
      expect(expanded, `${label} expanded mid-pickup`).toBe('true');
    }

    // Wait for handle bounds to settle after expand-all (2-RAF chain
    // in PatchPanel's updateNodeInternals effect).
    await page.waitForTimeout(250);

    // Tap ch1_volume — a CV-accepting input inside the now-expanded Ch1
    // section. The pickup-source is an LFO 'cv' output, so cv→cv is
    // compatible.
    const ch1volHandle = page.locator(
      `.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid="ch1_volume"][class*="target"]`,
    );
    const vBox = await ch1volHandle.boundingBox();
    expect(vBox, 'ch1_volume handle reachable after expand-all').toBeTruthy();
    if (!vBox) return;
    await page.mouse.move(vBox.x + vBox.width / 2, vBox.y + vBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    // Commit via xyflow's click-connect → handleConnect.
    await expect
      .poll(async () => (await readEdges(page)).length, { timeout: 2000 })
      .toBe(1);
    const edges = await readEdges(page);
    expect(edges[0]!.source.portId).toBe('phase0');
    expect(edges[0]!.target).toEqual({ nodeId: 'mm', portId: 'ch1_volume' });
  });
});
