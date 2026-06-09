// e2e/tests/quadralogical-assign.spec.ts
//
// QUADRALOGICAL joystick X/Y → Control Surface + Electra assignment.
//
// The pad is a bespoke <div> XY pad with its OWN 2-axis right-click menu. Unlike
// a standard Knob/Fader it does not embed ControlContextMenu, so we add per-axis
// "Send X/Y to <Control Surface>" and "Send X/Y to <Electra> ▸ Row ▸ knob"
// entries that wire pos_x / pos_y through the SAME registration the standard
// ControlContextMenu uses (addBindingToSurface / assignSlotToElectra), with a
// "QUAD X" / "QUAD Y" preset name.
//
// This spec proves, for BOTH axes:
//   1. the send records the binding on the surface / Electra node's data
//      (a {moduleId, paramId, name} pointer — value-free),
//   2. the surface / Electra renders a proxied control for the axis, and
//   3. driving that proxied control writes the SOURCE node.params.pos_x /
//      node.params.pos_y — i.e. the surface/Electra control DRIVES the joystick
//      axis (the same param the live-CV poll reads to move the dot).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

async function readSurfaceBindings(page: Page, surfaceId: string) {
  return await page.evaluate((id) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    const data = w.__patch.nodes[id]?.data as { bindings?: unknown } | undefined;
    return data?.bindings ?? null;
  }, surfaceId);
}

async function readSlots(page: Page, electraId: string) {
  return await page.evaluate((id) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    const data = w.__patch.nodes[id]?.data as { slots?: Record<string, unknown> } | undefined;
    return data?.slots ?? null;
  }, electraId);
}

async function readAxis(page: Page, axis: 'pos_x' | 'pos_y') {
  return await page.evaluate((a) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return w.__patch.nodes['quad']?.params[a];
  }, axis);
}

// Force the source axis off its default so a proxy double-click (reset-to-default
// = 0 for pos_x/pos_y) provably writes node.params back through the binding.
async function setAxis(page: Page, axis: 'pos_x' | 'pos_y', value: number) {
  await page.evaluate(([a, v]) => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['quad'];
      if (n) n.params[a as string] = v as number;
    });
  }, [axis, value] as const);
}

test.describe('QUADRALOGICAL — joystick X/Y assignable to Control Surface + Electra', () => {
  test('send X + Y to a Control Surface → proxies appear, named QUAD X/Y, and drive node.params.pos_x/pos_y', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'quad', type: 'quadralogical', position: { x: 80, y: 80 }, domain: 'video' },
      { id: 'cs-1', type: 'controlSurface', position: { x: 720, y: 80 }, domain: 'meta' },
    ]);

    const surface = page.locator('[data-testid="control-surface-card"][data-node-id="cs-1"]');
    await expect(surface).toBeVisible();
    await expect(surface.locator('[data-testid="control-surface-empty"]')).toBeVisible();

    const pad = page.locator('[data-testid="quadralogical-pad"]');
    await expect(pad).toBeVisible();

    // ── Send X to the surface ──
    await pad.click({ button: 'right' });
    const menu = page.locator('[data-testid="quadralogical-axis-menu"]');
    await expect(menu).toBeVisible();
    const sendX = menu.locator('[data-testid="quadralogical-surface-x-cs-1"]');
    await expect(sendX).toContainText('Send X to');
    await sendX.click();
    await expect(menu).toHaveCount(0);

    // ── Send Y to the surface ──
    await pad.click({ button: 'right' });
    const sendY = page.locator('[data-testid="quadralogical-axis-menu"] [data-testid="quadralogical-surface-y-cs-1"]');
    await expect(sendY).toContainText('Send Y to');
    await sendY.click();
    await expect(page.locator('[data-testid="quadralogical-axis-menu"]')).toHaveCount(0);

    // Both bindings recorded as pointers with the friendly preset names.
    await expect.poll(async () => await readSurfaceBindings(page, 'cs-1')).toEqual([
      { moduleId: 'quad', paramId: 'pos_x', name: 'QUAD X' },
      { moduleId: 'quad', paramId: 'pos_y', name: 'QUAD Y' },
    ]);

    // Both proxied controls render on the surface, grouped under QUADRALOGICAL.
    const proxyX = surface.locator('[data-testid="control-surface-knob-quad-pos_x"]');
    const proxyY = surface.locator('[data-testid="control-surface-knob-quad-pos_y"]');
    await expect(proxyX).toBeVisible();
    await expect(proxyY).toBeVisible();
    await expect(surface.locator('[data-testid="control-surface-group-label"]')).toContainText('QUADRALOGICAL');
    // The custom names show on the proxies.
    await expect(proxyX).toContainText('QUAD X');
    await expect(proxyY).toContainText('QUAD Y');

    // ── DRIVE proof: the surface control writes node.params.pos_x/pos_y ──
    // Push each axis off-default, then reset via the proxy (double-click → 0):
    // the source joystick param must change to the default, proving the surface
    // control drives the joystick axis.
    await setAxis(page, 'pos_x', 0.83);
    await proxyX.locator('[role="slider"]').dblclick();
    await expect.poll(async () => await readAxis(page, 'pos_x')).toBe(0); // surface reset the SOURCE axis

    await setAxis(page, 'pos_y', -0.77);
    await proxyY.locator('[role="slider"]').dblclick();
    await expect.poll(async () => await readAxis(page, 'pos_y')).toBe(0);

    // Remove X via the pad menu → only Y remains on the surface.
    await pad.click({ button: 'right' });
    const removeX = page.locator('[data-testid="quadralogical-axis-menu"] [data-testid="quadralogical-surface-x-cs-1"]');
    await expect(removeX).toContainText('Remove X from');
    await removeX.click();
    await expect.poll(async () => await readSurfaceBindings(page, 'cs-1')).toEqual([
      { moduleId: 'quad', paramId: 'pos_y', name: 'QUAD Y' },
    ]);
    await expect(proxyX).toHaveCount(0);
  });

  test('send X + Y to an Electra Control (fixed Row × knob slots) → proxies render, named QUAD X/Y, and drive node.params.pos_x/pos_y', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'quad', type: 'quadralogical', position: { x: 80, y: 80 }, domain: 'video' },
      { id: 'ec-1', type: 'electraControl', position: { x: 720, y: 80 }, domain: 'meta' },
    ]);

    const card = page.locator('[data-testid="electra-control-card"][data-node-id="ec-1"]');
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid^="electra-control-slot-"][data-filled="true"]')).toHaveCount(0);

    const pad = page.locator('[data-testid="quadralogical-pad"]');
    await expect(pad).toBeVisible();

    // ── Send X → Row1 → knob1 = slotIndex(1,1) = 0 ──
    await pad.click({ button: 'right' });
    let menu = page.locator('[data-testid="quadralogical-axis-menu"]');
    await menu.locator('[data-testid="quadralogical-electra-x-ec-1"]').click();
    await menu.locator('[data-testid="quadralogical-electra-x-ec-1-row-1"]').click();
    await menu.locator('[data-testid="quadralogical-electra-x-ec-1-row-1-knob-1"]').click();
    await expect(menu).toHaveCount(0);

    // ── Send Y → Row2 → knob2 = slotIndex(2,2) = 7 ──
    await pad.click({ button: 'right' });
    menu = page.locator('[data-testid="quadralogical-axis-menu"]');
    await menu.locator('[data-testid="quadralogical-electra-y-ec-1"]').click();
    await menu.locator('[data-testid="quadralogical-electra-y-ec-1-row-2"]').click();
    await menu.locator('[data-testid="quadralogical-electra-y-ec-1-row-2-knob-2"]').click();
    await expect(menu).toHaveCount(0);

    // Both slots recorded as pointers with the preset names (slot 0 = X, 7 = Y).
    await expect.poll(async () => await readSlots(page, 'ec-1')).toEqual({
      '0': { moduleId: 'quad', paramId: 'pos_x', name: 'QUAD X' },
      '7': { moduleId: 'quad', paramId: 'pos_y', name: 'QUAD Y' },
    });

    // The matching grid cells render proxied controls.
    const slotX = card.locator('[data-testid="electra-control-slot-1-1"]');
    const slotY = card.locator('[data-testid="electra-control-slot-2-2"]');
    await expect(slotX).toHaveAttribute('data-filled', 'true');
    await expect(slotY).toHaveAttribute('data-filled', 'true');
    await expect(slotX.locator('[role="slider"]')).toBeVisible();
    await expect(slotY.locator('[role="slider"]')).toBeVisible();

    // ── DRIVE proof: each Electra proxy writes node.params.pos_x/pos_y ──
    await setAxis(page, 'pos_x', 0.61);
    await slotX.locator('[role="slider"]').dblclick();
    await expect.poll(async () => await readAxis(page, 'pos_x')).toBe(0);

    await setAxis(page, 'pos_y', 0.42);
    await slotY.locator('[role="slider"]').dblclick();
    await expect.poll(async () => await readAxis(page, 'pos_y')).toBe(0);

    // Remove X from the Electra via the pad menu → only Y's slot remains.
    await pad.click({ button: 'right' });
    const clearX = page.locator('[data-testid="quadralogical-axis-menu"] [data-testid="quadralogical-electra-x-ec-1-clear"]');
    await expect(clearX).toContainText('Remove X from');
    await clearX.click();
    await expect.poll(async () => Object.keys((await readSlots(page, 'ec-1')) ?? {})).toEqual(['7']);
    await expect(slotX).toHaveAttribute('data-filled', 'false');
  });
});
