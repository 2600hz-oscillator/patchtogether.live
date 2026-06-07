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

// ── helpers reused from midi-learn.spec for the MIDI-mapped check ──
async function installSimMidi(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (globalThis as unknown as {
    __midiTestInstall?: () => boolean;
  }).__midiTestInstall === 'function');
  await page.evaluate(() => {
    (globalThis as unknown as { __midiTestInstall: () => boolean }).__midiTestInstall();
  });
}
async function injectCc(page: Page, channel: number, cc: number, value: number): Promise<void> {
  await page.evaluate(({ channel, cc, value }) => {
    const w = globalThis as unknown as { __midiTestInject?: (c: number, cc: number, v: number) => boolean };
    if (typeof w.__midiTestInject !== 'function') throw new Error('__midiTestInject missing — DEV build expected');
    w.__midiTestInject(channel, cc, value);
  }, { channel, cc, value });
}

test('multiple controls from multiple modules: grouped, lock/unlock + move, MIDI-mapped works on the proxy', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await installSimMidi(page);
  // Two source modules + a surface.
  await spawnPatch(page, [
    { id: 'cs-1', type: 'controlSurface', position: { x: 760, y: 60 }, domain: 'meta' },
    { id: 'adsr-1', type: 'adsr', position: { x: 60, y: 60 }, domain: 'audio' },
    { id: 'adsr-2', type: 'adsr', position: { x: 60, y: 420 }, domain: 'audio' },
  ]);
  const surface = page.locator('[data-testid="control-surface-card"][data-node-id="cs-1"]');

  // Send THREE controls from TWO modules (this is the path that used to break
  // after the first send).
  const sends: Array<[string, string]> = [['adsr-1', 'Attack'], ['adsr-1', 'Decay'], ['adsr-2', 'Attack']];
  for (const [nodeId, label] of sends) {
    const ctrl = page.locator(`.svelte-flow__node[data-id="${nodeId}"]`).locator(`[role="slider"][aria-label="${label}"]`);
    await ctrl.click({ button: 'right' });
    await page.locator('[data-testid="ctx-surface-cs-1"]').click();
    // The control menu portals an overlay; wait for it to close before the next
    // right-click (otherwise the lingering overlay intercepts the click).
    await expect(page.locator('[data-testid="control-context-menu"]')).toHaveCount(0);
  }

  // All three proxies present, grouped into TWO module boxes.
  await expect(surface.locator('[data-testid="control-surface-knob-adsr-1-attack"]')).toBeVisible();
  await expect(surface.locator('[data-testid="control-surface-knob-adsr-1-decay"]')).toBeVisible();
  await expect(surface.locator('[data-testid="control-surface-knob-adsr-2-attack"]')).toBeVisible();
  await expect(surface.locator('[data-testid="control-surface-group"]')).toHaveCount(2);
  expect(await readSurfaceBindings(page, 'cs-1')).toHaveLength(3);

  // MIDI-mapped param works THROUGH the surface: learn on the proxy, inject a
  // CC, the proxy shows the binding badge (shared moduleId:paramId key).
  const proxyAttack = surface.locator('[data-testid="control-surface-knob-adsr-1-attack"]');
  await proxyAttack.locator('[role="slider"]').click({ button: 'right' });
  await page.locator('[data-testid="control-context-menu"] [data-testid="ctx-midi-learn"]').click();
  await injectCc(page, 0, 41, 100);
  await expect(proxyAttack.locator('.midi-badge')).toContainText('CC 41');
  // ...and the SAME binding shows on the source card (one control, two views).
  await expect(
    page.locator('.svelte-flow__node[data-id="adsr-1"]').locator('[role="slider"][aria-label="Attack"]')
      .locator('xpath=ancestor-or-self::*[contains(@class,"fader-wrap") or contains(@class,"knob-wrap")][1]')
      .locator('.midi-badge'),
  ).toContainText('CC 41');

  await page.keyboard.press('Escape'); // dismiss any lingering control menu

  const box = surface.locator('[data-testid="control-surface-group"][data-source-id="adsr-1"]');
  const lockBtn = surface.locator('[data-testid="control-surface-lock"]');

  // Surface defaults to UNLOCKED → dragging a group box records a position.
  await expect(surface).toHaveAttribute('data-locked', 'false');
  const b1 = await box.boundingBox();
  if (b1) {
    await page.mouse.move(b1.x + 18, b1.y + 8);
    await page.mouse.down();
    await page.mouse.move(b1.x + 100, b1.y + 80, { steps: 6 });
    await page.mouse.up();
  }
  const layout = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return (w.__patch.nodes['cs-1']?.data as { layout?: Record<string, { x: number; y: number }> })?.layout ?? null;
  });
  expect(layout && layout['adsr-1']).toBeTruthy(); // unlocked drag persisted a position

  // Lock → boxes freeze (dragging no longer moves them).
  await lockBtn.click();
  await expect(surface).toHaveAttribute('data-locked', 'true');
  const beforeLocked = await box.boundingBox();
  if (beforeLocked) {
    await page.mouse.move(beforeLocked.x + 18, beforeLocked.y + 8);
    await page.mouse.down();
    await page.mouse.move(beforeLocked.x + 120, beforeLocked.y + 90, { steps: 5 });
    await page.mouse.up();
  }
  const afterLocked = await box.boundingBox();
  if (beforeLocked && afterLocked) expect(Math.abs(afterLocked.x - beforeLocked.x)).toBeLessThan(4);
});

// ── CARD-LAYOUT RESIZE: the surface grows to show ALL groups (no clipping) ──
//
// REGRESSION (the resize bug): the card was a fixed 360px wide with a fixed-
// height (~150px), overflow:hidden `.cs-canvas`, while group boxes are tiled in
// rows of 2. Groups past the first row (or in the right column) were
// added-to-the-Y.Doc-but-CLIPPED → "can't add more than ~2 controls". The fix:
// LOCKED renders boxes in a wrap layout + the card grows to fit; UNLOCKED sizes
// the canvas from the box positions. Either way EVERY group + knob must render
// AND sit within the card's bounding box.

async function bindControls(page: Page, surfaceId: string): Promise<void> {
  // Bind one control from each of 4 distinct source modules straight onto the
  // surface node's data (the add path is covered above; here we exercise the
  // RENDER/clip path with 4 groups deterministically, no per-send menu dance).
  await page.evaluate((sid) => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const cs = w.__patch.nodes[sid];
      if (!cs.data) cs.data = {};
      (cs.data as Record<string, unknown>).bindings = [
        { moduleId: 'adsr-1', paramId: 'attack' },
        { moduleId: 'adsr-2', paramId: 'decay' },
        { moduleId: 'filter-1', paramId: 'cutoff' },
        { moduleId: 'lfo-1', paramId: 'rate' },
      ];
    });
  }, surfaceId);
}

test('card grows so ALL groups + knobs render within bounds (locked + unlocked)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'cs-1', type: 'controlSurface', position: { x: 900, y: 40 }, domain: 'meta' },
    { id: 'adsr-1', type: 'adsr', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: 'adsr-2', type: 'adsr', position: { x: 40, y: 360 }, domain: 'audio' },
    { id: 'filter-1', type: 'filter', position: { x: 400, y: 40 }, domain: 'audio' },
    { id: 'lfo-1', type: 'lfo', position: { x: 400, y: 360 }, domain: 'audio' },
  ]);

  const surface = page.locator('[data-testid="control-surface-card"][data-node-id="cs-1"]');
  await expect(surface).toBeVisible();
  await bindControls(page, 'cs-1');

  const groupSel = '[data-testid="control-surface-group"]';
  const knobSel = '[data-testid^="control-surface-knob-"]';

  // Assert every group + every knob renders and is fully inside the card box.
  async function expectAllWithinBounds(label: string): Promise<void> {
    await expect(surface.locator(groupSel), label).toHaveCount(4);
    await expect(surface.locator(knobSel), label).toHaveCount(4);
    const cardBox = await surface.boundingBox();
    expect(cardBox, `${label}: card has a box`).toBeTruthy();
    const eps = 2; // sub-pixel tolerance
    const n = await surface.locator(groupSel).count();
    for (let i = 0; i < n; i++) {
      const gb = await surface.locator(groupSel).nth(i).boundingBox();
      expect(gb, `${label}: group ${i} visible`).toBeTruthy();
      if (gb && cardBox) {
        // Each group box sits within the card's bounds (not clipped off-card).
        expect(gb.x + gb.width, `${label}: group ${i} right edge within card`)
          .toBeLessThanOrEqual(cardBox.x + cardBox.width + eps);
        expect(gb.y + gb.height, `${label}: group ${i} bottom edge within card`)
          .toBeLessThanOrEqual(cardBox.y + cardBox.height + eps);
        expect(gb.x, `${label}: group ${i} left edge within card`)
          .toBeGreaterThanOrEqual(cardBox.x - eps);
        expect(gb.y, `${label}: group ${i} top edge within card`)
          .toBeGreaterThanOrEqual(cardBox.y - eps);
      }
    }
    // Every knob is non-zero-size + visible (not collapsed/hidden by clipping).
    const kn = await surface.locator(knobSel).count();
    for (let i = 0; i < kn; i++) {
      const kb = await surface.locator(knobSel).nth(i).boundingBox();
      expect(kb && kb.width > 0 && kb.height > 0, `${label}: knob ${i} has size`).toBeTruthy();
    }
  }

  // Toggling lock changes the button label + the card layout (so the button can
  // shift/reflow). Click then wait for the attribute to settle to the target,
  // re-locating + retrying once if the first click landed mid-reflow.
  async function setLocked(want: 'true' | 'false'): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await surface.getAttribute('data-locked')) === want) return;
      await surface.locator('[data-testid="control-surface-lock"]').click();
      try {
        await expect(surface).toHaveAttribute('data-locked', want, { timeout: 1500 });
        return;
      } catch {
        /* reflow may have moved the button; loop re-reads + retries */
      }
    }
    await expect(surface).toHaveAttribute('data-locked', want);
  }

  // Default state is UNLOCKED → absolute layout sized from box positions.
  await expect(surface).toHaveAttribute('data-locked', 'false');
  await expectAllWithinBounds('unlocked');

  // LOCKED (the normal display) → flow/wrap layout, card grows to fit.
  await setLocked('true');
  await expectAllWithinBounds('locked');

  // Drag-when-unlocked still works: unlock, drag a group, position persists.
  await setLocked('false');
  const dragBox = surface.locator(`${groupSel}[data-source-id="filter-1"]`);
  const b = await dragBox.boundingBox();
  if (b) {
    await page.mouse.move(b.x + 18, b.y + 8);
    await page.mouse.down();
    await page.mouse.move(b.x + 90, b.y + 70, { steps: 6 });
    await page.mouse.up();
  }
  const layout = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return (w.__patch.nodes['cs-1']?.data as { layout?: Record<string, { x: number; y: number }> })?.layout ?? null;
  });
  expect(layout && layout['filter-1'], 'unlocked drag persisted a position').toBeTruthy();
  // ...and after the drag the canvas still contains every group (grew to fit).
  await expectAllWithinBounds('unlocked-after-drag');
});

// ── TOYBOX (nested node.data params) → control surface ──
//
// REGRESSION (this PR): TOYBOX controls do NOT live on node.params — material
// fields are on node.data.layers[i].material, combine op params on
// node.data.combine.nodes[].params — and the toybox def declares NO params. So
// the surface's old registry+flat-read resolution silently dropped every toybox
// binding (paramDefFor → undefined → empty group → nothing rendered). The param
// adapter (control-surface-params.ts → toybox-control-params.ts) now resolves
// these through the SAME live location the card knobs + CV routing use. This
// spec proves a material SCALE and a combine fade-T proxy both RENDER on the
// surface and DRIVE the live toybox node.

async function seedToyboxAndBindings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
      __ydoc: { transact: (fn: () => void) => void };
    };
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

test('toybox material + combine params: proxy renders on the surface and drives the live node', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // The TOYBOX card is WIDE (~880px) + tall and has its OWN SCALE knob; place
  // the surface well to the right so its proxy knobs aren't occluded by the
  // toybox card. spawnPatch's fitView zooms both into view, preserving the gap.
  await spawnPatch(page, [
    { id: 'toybox-1', type: 'toybox', position: { x: 0, y: 0 }, domain: 'video' },
    { id: 'cs-1', type: 'controlSurface', position: { x: 1200, y: 0 }, domain: 'meta' },
  ]);

  const surface = page.locator('[data-testid="control-surface-card"][data-node-id="cs-1"]');
  await expect(surface).toBeVisible();

  await seedToyboxAndBindings(page);

  // BUG FIX: both proxies RENDER (before this PR the bindings resolved to
  // undefined defs → the group was dropped → empty surface).
  const scaleProxy = surface.locator('[data-testid="control-surface-knob-toybox-1-scale"]');
  const fadeProxy = surface.locator('[data-testid="control-surface-knob-toybox-1-combine:op1:amount"]');
  await expect(scaleProxy).toBeVisible();
  await expect(fadeProxy).toBeVisible();
  await expect(surface.locator('[data-testid="control-surface-empty"]')).toHaveCount(0);
  await expect(surface.locator('[data-testid="control-surface-group-label"]')).toContainText('TOYBOX');

  // The proxy is a POINTER into node.data: push the live material SCALE off its
  // default, then reset via the proxy (double-click → default 1) — the live
  // toybox material.scale must change (proxy writes node.data, not node.params).
  await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    const mat = ((w.__patch.nodes['toybox-1'].data as { layers: Array<{ material: Record<string, number> }> }).layers[0].material);
    mat.scale = 2.8;
  });
  await scaleProxy.locator('[role="slider"]').dblclick();
  const scaleAfter = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return (w.__patch.nodes['toybox-1'].data as { layers: Array<{ material: Record<string, number> }> }).layers[0].material.scale;
  });
  expect(scaleAfter).toBe(1); // proxy reset the SOURCE material to the default

  // Same for the COMBINE fade amount (lives on node.data.combine.nodes[op1].params).
  await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    const g = (w.__patch.nodes['toybox-1'].data as { combine: { nodes: Array<{ id: string; params?: Record<string, number> }> } }).combine;
    const op1 = g.nodes.find((n) => n.id === 'op1')!;
    op1.params = { amount: 0.2 };
  });
  await fadeProxy.locator('[role="slider"]').dblclick();
  const amountAfter = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    const g = (w.__patch.nodes['toybox-1'].data as { combine: { nodes: Array<{ id: string; params?: Record<string, number> }> } }).combine;
    return g.nodes.find((n) => n.id === 'op1')!.params!.amount;
  });
  expect(amountAfter).toBe(1); // fade T default is 1 → proxy reset the live op node
});
