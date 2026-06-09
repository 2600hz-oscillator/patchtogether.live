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

// QUADRALOGICAL is a heavy WebGL card (a live 3D MIX-preview canvas + cube
// viewport rendering every rAF tick). On CI's SwiftShader SOFTWARE renderer
// that per-frame GL draw saturates the main thread, so a context-menu item's
// actionability check ("waiting for element … stable") can starve and time out
// at the 30s default even though the menu is up and correct — the same heavy-GL
// CI flake class that hits the per-module-per-port shard (run 27179093253: both
// quad tests timed out at 30s on shard 9). Two mitigations, both rendering-
// independent (the spec asserts bindings/params, never pixels):
//   1) freezeVideoRender — flip the VideoEngine's per-frame-draw kill switch
//      BEFORE the app boots so the heavy GL pass is skipped (cards still mount;
//      handles/menus still render), removing the main-thread contention.
//   2) heavy test timeout + force-click on the menu items — bypass the
//      actionability wait on the (hover-driven) cascade triggers so the click
//      is deterministic under load. We still assert each item is visible + has
//      the right text first, so the interaction stays meaningful.
async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

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
  // Heavy-GL card on the SwiftShader CI renderer → lift to the 90s heavy tier
  // and freeze the per-frame GL draw before boot (see header note). Both
  // mitigations are pixel-independent; the spec only reads bindings/params.
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await freezeVideoRender(page);
  });

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
    // force: bypass the actionability/stability wait that starves under the
    // heavy-GL main-thread load on CI's SwiftShader renderer (visibility +
    // text already asserted above, so the interaction stays meaningful).
    await sendX.click({ force: true });
    await expect(menu).toHaveCount(0);

    // ── Send Y to the surface ──
    await pad.click({ button: 'right' });
    const sendY = page.locator('[data-testid="quadralogical-axis-menu"] [data-testid="quadralogical-surface-y-cs-1"]');
    await expect(sendY).toContainText('Send Y to');
    await sendY.click({ force: true });
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
    await removeX.click({ force: true });
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
    // The cascade is hover-driven (onmouseenter) but each trigger ALSO has an
    // onclick that opens the next level, so a force-click drives it
    // deterministically without depending on a hover that the heavy-GL load can
    // disrupt. After each level's click we wait for the next level's submenu to
    // render before clicking into it (the submenus mount conditionally).
    await pad.click({ button: 'right' });
    let menu = page.locator('[data-testid="quadralogical-axis-menu"]');
    const xTrigger = menu.locator('[data-testid="quadralogical-electra-x-ec-1"]');
    await expect(xTrigger).toBeVisible();
    await xTrigger.click({ force: true });
    const xRow1 = menu.locator('[data-testid="quadralogical-electra-x-ec-1-row-1"]');
    await expect(xRow1).toBeVisible();
    await xRow1.click({ force: true });
    const xKnob1 = menu.locator('[data-testid="quadralogical-electra-x-ec-1-row-1-knob-1"]');
    await expect(xKnob1).toBeVisible();
    await xKnob1.click({ force: true });
    await expect(menu).toHaveCount(0);

    // ── Send Y → Row2 → knob2 = slotIndex(2,2) = 7 ──
    await pad.click({ button: 'right' });
    menu = page.locator('[data-testid="quadralogical-axis-menu"]');
    const yTrigger = menu.locator('[data-testid="quadralogical-electra-y-ec-1"]');
    await expect(yTrigger).toBeVisible();
    await yTrigger.click({ force: true });
    const yRow2 = menu.locator('[data-testid="quadralogical-electra-y-ec-1-row-2"]');
    await expect(yRow2).toBeVisible();
    await yRow2.click({ force: true });
    const yKnob2 = menu.locator('[data-testid="quadralogical-electra-y-ec-1-row-2-knob-2"]');
    await expect(yKnob2).toBeVisible();
    await yKnob2.click({ force: true });
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
    await clearX.click({ force: true });
    await expect.poll(async () => Object.keys((await readSlots(page, 'ec-1')) ?? {})).toEqual(['7']);
    await expect(slotX).toHaveAttribute('data-filled', 'false');
  });
});
