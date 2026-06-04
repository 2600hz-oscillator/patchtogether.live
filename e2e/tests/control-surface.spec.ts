// e2e/tests/control-surface.spec.ts
//
// CONTROL SURFACE Phase 1 — the full behavioral loop:
//   1. spawn a surface (blank square) + an ADSR.
//   2. right-click the ADSR's Attack control → "Send to <surface>".
//   3. a proxied control appears on the surface, grouped under the ADSR,
//      and the binding is recorded on the surface node's data.
//   4. the proxy is a POINTER: double-clicking it (reset-to-default) writes
//      the SOURCE module's param — proving no separate state.
//   5. collapse the ADSR into a Group → the source card hides but the proxy
//      stays live (the whole point: control collapsed modules).
//   6. "Remove from <surface>" takes the proxy away again.

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

async function setup(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'cs-1', type: 'controlSurface', position: { x: 700, y: 80 }, domain: 'meta' },
    { id: 'adsr-1', type: 'adsr', position: { x: 80, y: 80 }, domain: 'audio' },
  ]);
}

test('send a control to a surface → proxy appears, drives the source, survives collapse', async ({ page }) => {
  await setup(page);

  const surface = page.locator('[data-testid="control-surface-card"][data-node-id="cs-1"]');
  await expect(surface).toBeVisible();
  // Fresh surface = blank square (empty-state prompt).
  await expect(surface.locator('[data-testid="control-surface-empty"]')).toBeVisible();

  // Right-click the ADSR's Attack control → control menu → Send to surface.
  const adsr = page.locator('.svelte-flow__node-adsr');
  const attack = adsr.locator('[role="slider"][aria-label="Attack"]');
  await expect(attack).toBeVisible();
  await attack.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  const sendItem = menu.locator('[data-testid="ctx-surface-cs-1"]');
  await expect(sendItem).toContainText('Send to');
  await sendItem.click();

  // The proxy control now lives on the surface, grouped under the ADSR.
  const proxy = surface.locator('[data-testid="control-surface-knob-adsr-1-attack"]');
  await expect(proxy).toBeVisible();
  await expect(surface.locator('[data-testid="control-surface-group-label"]')).toContainText('ADSR');
  await expect(surface.locator('[data-testid="control-surface-empty"]')).toHaveCount(0);

  // The binding is recorded on the surface node (a pointer, value-free).
  expect(await readSurfaceBindings(page, 'cs-1')).toEqual([{ moduleId: 'adsr-1', paramId: 'attack' }]);

  // Pointer proof: push the SOURCE param off-default, then reset via the
  // PROXY (double-click) — the source param must change (the proxy writes
  // the source, it has no state of its own).
  await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    w.__patch.nodes['adsr-1'].params.attack = 0.9;
  });
  await proxy.locator('[role="slider"]').dblclick();
  const attackAfter = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return w.__patch.nodes['adsr-1'].params.attack;
  });
  expect(attackAfter).not.toBe(0.9); // proxy reset the SOURCE to its default

  // Collapse the ADSR into a Group (mirror the grouping-phase1 transact):
  // the source card hides, but the proxy must keep working because the
  // source node stays live in patch.nodes.
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['g-1'] = {
        id: 'g-1', type: 'group', domain: 'meta',
        position: { x: 80, y: 420 }, params: {},
        data: { childIds: ['adsr-1'], exposedPorts: [] },
      } as PatchNode;
      const child = w.__patch.nodes['adsr-1'];
      if (!child.data) child.data = {};
      (child.data as { parentGroupId?: string }).parentGroupId = 'g-1';
    });
  });
  // The group card appears (collapse happened) and the source ADSR card is
  // gone from the canvas...
  await expect(page.locator('[data-testid="group-card"][data-node-id="g-1"]')).toBeVisible();
  await expect(page.locator('.svelte-flow__node-adsr')).toHaveCount(0);
  // ...yet the proxy is still on the surface AND still drives the (now
  // collapsed) source — the whole point of the feature.
  await expect(proxy).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    w.__patch.nodes['adsr-1'].params.attack = 0.77;
  });
  await proxy.locator('[role="slider"]').dblclick();
  const attackCollapsed = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return w.__patch.nodes['adsr-1'].params.attack;
  });
  expect(attackCollapsed).not.toBe(0.77); // proxy still wrote the collapsed source

  // Unbind via the proxy's OWN control menu — it's a real control, so its
  // right-click menu offers "Remove from <surface>" (the proxy shares the
  // source's moduleId:paramId, so the menu knows it's bound here).
  await proxy.locator('[role="slider"]').click({ button: 'right' });
  const menu2 = page.locator('[data-testid="control-context-menu"]');
  await expect(menu2).toBeVisible();
  const removeItem = menu2.locator('[data-testid="ctx-surface-cs-1"]');
  await expect(removeItem).toContainText('Remove from');
  await removeItem.click();
  expect(await readSurfaceBindings(page, 'cs-1')).toEqual([]);
  await expect(surface.locator('[data-testid="control-surface-empty"]')).toBeVisible();
});
