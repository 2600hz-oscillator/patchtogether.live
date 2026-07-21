// e2e/tests/videocube-assign.spec.ts
//
// VIDEOCUBE joystick per-axis MIDI / Control-Surface / Electra ASSIGN.
//
// Each XyPad axis carries a tiny ASSIGN BUTTON (X / Y). It does NOT change the
// value (the pad still drives it) — right-click (or click) opens the SAME shared
// ControlContextMenu a <Knob> opens, wired through the SAME makeMidiAssignable
// factory against that axis's paramId. This spec proves, for the slice-ROT pad's
// two axes (slice_rx / slice_ry):
//   1. the assign button opens the shared control menu (MIDI Learn item present),
//   2. "Send to <Control Surface>" records the binding on the surface node's data
//      as a {moduleId, paramId} pointer for the CORRECT axis param, and
//   3. driving the resulting surface proxy writes the SOURCE node.params.slice_rx
//      — i.e. the assigned control DRIVES the joystick axis (like a knob CC).
//
// VideoCube is a heavy WebGL card; freeze the per-frame GL draw before boot (the
// spec reads bindings/params, never pixels) — the quadralogical-assign mitigation.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

interface PatchNode {
  id: string;
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

async function readParam(page: Page, paramId: string) {
  return await page.evaluate((p) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return w.__patch.nodes['vc']?.params[p];
  }, paramId);
}

// Push a source param off its default so a proxy double-click (reset-to-default)
// provably writes node.params back through the binding.
async function setParamRaw(page: Page, paramId: string, value: number) {
  await page.evaluate(([p, v]) => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['vc'];
      if (n) n.params[p as string] = v as number;
    });
  }, [paramId, value] as const);
}

test.describe('VIDEOCUBE — joystick axis assign buttons (MIDI / Surface / Electra)', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await freezeVideoRender(page);
  });

  test('slice-ROT X/Y assign buttons open the shared menu + bind the correct axis param + drive it', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'vc', type: 'videocube', position: { x: 40, y: 40 }, domain: 'video' },
      // videocube is ~4hp wide → place the surface well clear so its proxies aren't occluded.
      { id: 'cs-1', type: 'controlSurface', position: { x: 900, y: 40 }, domain: 'meta' },
    ]);

    await expect(page.locator('[data-testid="videocube-card"]')).toBeVisible();
    const surface = page.locator('[data-testid="control-surface-card"][data-node-id="cs-1"]');
    await expect(surface).toBeVisible();

    const menu = page.locator('[data-testid="control-context-menu"]');

    // ── X axis: assign button → shared menu (MIDI Learn present) → Send to surface ──
    const btnX = page.locator('[data-testid="videocube-slice-rot-joystick-assign-x"]');
    await expect(btnX).toBeVisible();
    await btnX.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-testid="ctx-midi-learn"]'), 'MIDI Learn item wired for the axis').toBeVisible();
    await menu.locator('[data-testid="ctx-surface-cs-1"]').click({ force: true });
    await expect(menu).toHaveCount(0);
    await expect.poll(async () => await readSurfaceBindings(page, 'cs-1')).toEqual([
      { moduleId: 'vc', paramId: 'slice_rx' },
    ]);

    // ── Y axis button binds the OTHER axis param (slice_ry) ──
    const btnY = page.locator('[data-testid="videocube-slice-rot-joystick-assign-y"]');
    await expect(btnY).toBeVisible();
    await btnY.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await menu.locator('[data-testid="ctx-surface-cs-1"]').click({ force: true });
    await expect.poll(async () => await readSurfaceBindings(page, 'cs-1')).toEqual([
      { moduleId: 'vc', paramId: 'slice_rx' },
      { moduleId: 'vc', paramId: 'slice_ry' },
    ]);

    // Both proxies render on the surface (grouped under VIDEOCUBE).
    const proxyX = surface.locator('[data-testid="control-surface-knob-vc-slice_rx"]');
    const proxyY = surface.locator('[data-testid="control-surface-knob-vc-slice_ry"]');
    await expect(proxyX).toBeVisible();
    await expect(proxyY).toBeVisible();

    // ── DRIVE proof: the surface proxy writes node.params.slice_rx ──
    // Push the axis off-default, then reset via the proxy (double-click → default 0):
    // the source joystick param must change to the default, proving the assigned
    // surface control drives the joystick axis (the same param the pad drives).
    await setParamRaw(page, 'slice_rx', 1.2);
    await proxyX.locator('[role="slider"]').dblclick();
    await expect.poll(async () => await readParam(page, 'slice_rx')).toBe(0);

    // Left-clicking the assign button ALSO opens the menu (it never changes the value).
    await btnX.click();
    await expect(menu).toBeVisible();
    // "Remove from" is now offered (the axis is already on the surface).
    await expect(menu.locator('[data-testid="ctx-surface-cs-1"]')).toContainText('Remove from');
  });
});
