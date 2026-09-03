// e2e/tests/toybox-control-surface.spec.ts
//
// CONTROL SURFACE × TOYBOX — the two surface tests that boot a full TOYBOX
// WebGL console. SPLIT OUT of control-surface.spec.ts (which stays in the
// parallel sharded matrix) so the filename matches the `**/toybox-*.spec.ts`
// WEBGL_HEAVY_GLOB and these run in the SERIALIZED heavy lane instead:
// under 10-way shard contention on CI's SwiftShader the toybox console renders
// its controls well past any sane budget (60s flat blown on main push
// fc123c92, #1043, #1052, #1054 — passes ~8s locally idle). No behavioral
// change; assertions are verbatim modulo surface homes.
//
// On the default shell both surfaces live in DOCK FULL VIEW panes (two can be
// open at once): the toybox console is `toybox-face-console` (same layer tabs;
// its material knobs are `toybox-dial-layer:<n>:<param>` — the dial IS the
// role=slider element), and the control surface board is `cs-board` with
// `cs-board-knob-<module>-<param>` proxies whose dial is
// `cs-board-dial-<module>-<param>`.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

type WGlobals = {
  __patch: { nodes: Record<string, PatchNode> };
  __ydoc: { transact: (fn: () => void) => void };
  __openDockFullView?: (id: string) => void;
};

async function readSurfaceBindings(page: Page, surfaceId: string) {
  return await page.evaluate((id) => {
    const w = window as unknown as WGlobals;
    const data = w.__patch.nodes[id]?.data as { bindings?: unknown } | undefined;
    return data?.bindings ?? null;
  }, surfaceId);
}

/** Open both dock panes (toybox console + surface board) and return them. */
async function openPanes(page: Page) {
  await page.evaluate(() => {
    const w = globalThis as unknown as WGlobals;
    w.__openDockFullView?.('cs-1');
    w.__openDockFullView?.('toybox-1');
  });
  const tbPane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="toybox-1"]');
  const csPane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="cs-1"]');
  await expect(tbPane).toBeVisible({ timeout: 20_000 });
  await expect(csPane).toBeVisible();
  return { tbPane, csPane };
}

// ── TOYBOX (nested node.data params) → control surface ──
//
// REGRESSION (this PR): TOYBOX controls do NOT live on node.params — material
// fields are on node.data.layers[i].material, combine op params on
// node.data.combine.nodes[].params — and the toybox def declares NO params. So
// the surface's old registry+flat-read resolution silently dropped every toybox
// binding (paramDefFor → undefined → empty group → nothing rendered). The param
// adapter (control-surface-params.ts → toybox-control-params.ts) resolves
// these through the SAME live location the console knobs + CV routing use. This
// spec proves a material SCALE and a combine fade-T proxy both RENDER on the
// surface board and DRIVE the live toybox node.

async function seedToyboxAndBindings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as WGlobals;
    w.__ydoc.transact(() => {
      const tb = w.__patch.nodes['toybox-1'];
      if (!tb.data) tb.data = {};
      // One OBJ layer (material → SCALE knob) + a minimal combine graph with a
      // single fade op node 'op1' (the default-graph op id) exposing 'amount'.
      (tb.data as Record<string, unknown>).layers = [
        {
          kind: 'obj',
          contentId: null,
          params: {},
          material: { modelId: 'cube', rotX: 0.3, rotY: 0.6, rotZ: 0, scale: 1, spin: 0.4, matcap: 0, tintR: 1, tintG: 1, tintB: 1 },
        },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ];
      (tb.data as Record<string, unknown>).combine = {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 0, y: 0 },
          { id: 'src1', kind: 'source', layer: 1, x: 0, y: 0 },
          { id: 'op1', kind: 'fade', x: 0, y: 0, params: { amount: 1 } },
          { id: 'out', kind: 'output', x: 0, y: 0 },
        ],
        edges: [],
      };
      // Bind the toybox material SCALE + the combine fade amount onto the surface.
      const cs = w.__patch.nodes['cs-1'];
      if (!cs.data) cs.data = {};
      (cs.data as Record<string, unknown>).bindings = [
        { moduleId: 'toybox-1', paramId: 'scale' },
        { moduleId: 'toybox-1', paramId: 'combine:op1:amount' },
      ];
    });
  });
}

test('toybox material + combine params: proxy renders on the surface and drives the live node', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'toybox-1', type: 'toybox', position: { x: 0, y: 0 }, domain: 'video' },
    { id: 'cs-1', type: 'controlSurface', position: { x: 1200, y: 0 }, domain: 'meta' },
  ]);

  await seedToyboxAndBindings(page);
  const { csPane } = await openPanes(page);
  const board = csPane.getByTestId('cs-board');
  await expect(board).toBeVisible();

  // BUG FIX: both proxies RENDER (before this PR the bindings resolved to
  // undefined defs → the group was dropped → empty surface).
  const scaleProxy = board.locator('[data-testid="cs-board-knob-toybox-1-scale"]');
  const fadeProxy = board.locator('[data-testid="cs-board-knob-toybox-1-combine:op1:amount"]');
  await expect(scaleProxy).toBeVisible();
  await expect(fadeProxy).toBeVisible();
  await expect(board.locator('[data-testid="cs-board-empty"]')).toHaveCount(0);
  await expect(board.locator('[data-testid="cs-board-group-label"]')).toContainText('TOYBOX');

  // The proxy is a POINTER into node.data: push the live material SCALE off its
  // default, then reset via the proxy (double-click → default 1) — the live
  // toybox material.scale must change (proxy writes node.data, not node.params).
  await page.evaluate(() => {
    const w = window as unknown as WGlobals;
    const mat = ((w.__patch.nodes['toybox-1'].data as { layers: Array<{ material: Record<string, number> }> }).layers[0].material);
    mat.scale = 2.8;
  });
  await board.locator('[data-testid="cs-board-dial-toybox-1-scale"]').dblclick();
  const scaleAfter = await page.evaluate(() => {
    const w = window as unknown as WGlobals;
    return (w.__patch.nodes['toybox-1'].data as { layers: Array<{ material: Record<string, number> }> }).layers[0].material.scale;
  });
  expect(scaleAfter).toBe(1); // proxy reset the SOURCE material to the default

  // Same for the COMBINE fade amount (lives on node.data.combine.nodes[op1].params).
  await page.evaluate(() => {
    const w = window as unknown as WGlobals;
    const g = (w.__patch.nodes['toybox-1'].data as { combine: { nodes: Array<{ id: string; params?: Record<string, number> }> } }).combine;
    const op1 = g.nodes.find((n) => n.id === 'op1')!;
    op1.params = { amount: 0.2 };
  });
  await board.locator('[data-testid="cs-board-dial-toybox-1-combine:op1:amount"]').dblclick();
  const amountAfter = await page.evaluate(() => {
    const w = window as unknown as WGlobals;
    const g = (w.__patch.nodes['toybox-1'].data as { combine: { nodes: Array<{ id: string; params?: Record<string, number> }> } }).combine;
    return g.nodes.find((n) => n.id === 'op1')!.params!.amount;
  });
  expect(amountAfter).toBe(1); // fade T default is 1 → proxy reset the live op node
});

// REGRESSION (user: "toybox scale on a model when assigned to a control surface
// doesn't work"). The console's material knobs emit a LAYER-QUALIFIED paramId
// ('layer:<activeLayer>:scale'), so a "send to surface" binds the SPECIFIC layer
// the user is editing — NOT the first OBJ layer (the old bare-'scale' behaviour
// drove the wrong layer when the model sat on layer 2/3/4). This drives the WHOLE
// chain through the real console dial (right-click → Send to surface), so it
// proves the surface emission, not just the resolver. On the face the dial's
// testid is itself layer-qualified (`toybox-dial-layer:2:scale`) — the binding
// assert below is what proves the EMITTED id matches it.
test('toybox model SCALE on a NON-FIRST layer: console dial → surface drives the LEARNED layer', async ({ page, rack }) => {
  // Heavy TOYBOX WebGL console under 10-way-sharded CI CPU contention renders
  // controls well past the default 30s/5s budgets (passes ~8s locally idle).
  // Mirror the sibling toybox specs' CI-robustness timeout.
  test.setTimeout(60_000);
  await spawnPatch(page, [
    { id: 'toybox-1', type: 'toybox', position: { x: 0, y: 0 }, domain: 'video' },
    { id: 'cs-1', type: 'controlSurface', position: { x: 1200, y: 0 }, domain: 'meta' },
  ]);

  // Seed: layer 0 OFF; layer 1 a DIFFERENT obj (scale 1.1, must stay untouched);
  // layer 2 the user's model (scale 1) — the one we'll edit + send to the surface.
  await page.evaluate(() => {
    const w = window as unknown as WGlobals;
    w.__ydoc.transact(() => {
      const tb = w.__patch.nodes['toybox-1'];
      if (!tb.data) tb.data = {};
      (tb.data as Record<string, unknown>).layers = [
        { kind: 'off', contentId: null, params: {} },
        { kind: 'obj', contentId: null, params: {}, material: { modelId: 'cube', scale: 1.1, matcap: 0, tintR: 1, tintG: 1, tintB: 1 } },
        { kind: 'obj', contentId: null, params: {}, material: { modelId: 'cube', scale: 1, matcap: 0, tintR: 1, tintG: 1, tintB: 1 } },
        { kind: 'off', contentId: null, params: {} },
      ];
    });
  });

  const { tbPane, csPane } = await openPanes(page);

  // Activate LAYER 3 (index 2) — the user's model. The console's SCALE dial now
  // edits layer 2 and carries the layer-qualified id.
  await tbPane.getByTestId('toybox-layer-tab-2').click();
  const dial = tbPane.locator('[data-testid="toybox-dial-layer:2:scale"]');
  await expect(dial).toBeVisible({ timeout: 15_000 });

  // Right-click the material SCALE dial → Send to surface cs-1.
  await dial.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-surface-cs-1"]').click();

  // PROOF the console emitted the LAYER-QUALIFIED id (not bare 'scale').
  expect(await readSurfaceBindings(page, 'cs-1')).toEqual([
    { moduleId: 'toybox-1', paramId: 'layer:2:scale' },
  ]);

  // The proxy drives LAYER 2's material, not layer 1's. Push layer 2 off-default,
  // reset via the proxy (double-click → default 1), and assert layer 2 reset while
  // layer 1 (the first OBJ, the old wrong target) stays at 1.1.
  const scaleProxy = csPane.locator('[data-testid="cs-board-knob-toybox-1-layer:2:scale"]');
  await expect(scaleProxy).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => {
    const w = window as unknown as WGlobals;
    const layers = (w.__patch.nodes['toybox-1'].data as { layers: Array<{ material?: Record<string, number> }> }).layers;
    layers[2]!.material!.scale = 2.8;
  });
  await csPane.locator('[data-testid="cs-board-dial-toybox-1-layer:2:scale"]').dblclick();

  const { l1, l2 } = await page.evaluate(() => {
    const w = window as unknown as WGlobals;
    const layers = (w.__patch.nodes['toybox-1'].data as { layers: Array<{ material?: Record<string, number> }> }).layers;
    return { l1: layers[1]!.material!.scale, l2: layers[2]!.material!.scale };
  });
  expect(l2).toBe(1);   // the LEARNED layer was driven (reset to default)
  expect(l1).toBe(1.1); // the first OBJ layer was NOT touched (the old bug)
});
