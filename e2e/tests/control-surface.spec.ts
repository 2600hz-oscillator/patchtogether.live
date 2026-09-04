// e2e/tests/control-surface.spec.ts
//
// CONTROL SURFACE Phase 1 — the full behavioral loop, on the DEFAULT shell
// (S2 re-point; the module was promoted off NON_SHELL_LANE_TYPES, so the
// board lives in the DOCK full view and the send gesture starts on the
// source's faced tile knob — the same recipes controlsurface-face.spec.ts
// proves):
//   1. spawn a surface + an ADSR; the tile paints the empty-state prompt.
//   2. right-click the ADSR tile's attack knob → "Send to <surface>".
//   3. a proxied control appears on the dock BOARD, grouped under the ADSR,
//      and the binding is recorded on the surface node's data.
//   4. the proxy is a POINTER: double-clicking it (reset-to-default) writes
//      the SOURCE module's param — proving no separate state.
//   5. collapse the ADSR into a Group → the source's lane node unmounts but
//      the proxy stays live (the whole point: control collapsed modules).
//   6. "Remove from <surface>" takes the proxy away again.

import { test, expect } from './_fixtures';
import { type Locator, type Page } from '@playwright/test';
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
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'cs-1', type: 'controlSurface', position: { x: 700, y: 80 }, domain: 'meta' },
    { id: 'adsr-1', type: 'adsr', position: { x: 80, y: 80 }, domain: 'audio' },
  ]);
}

/** The LANE tile's shell for a node. */
function laneShell(page: Page, nodeId: string): Locator {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
}

/** Open the surface's dock faceplate and return the BOARD, scoped by node
 *  (the controlsurface-face.spec.ts recipe — the board is dock-only). */
async function openBoard(page: Page, nodeId = 'cs-1'): Promise<Locator> {
  const shell = laneShell(page, nodeId);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dockShell).toBeVisible();
  return dockShell.getByTestId('cs-board');
}

/** Right-click a SOURCE tile knob → control menu → "Send to <surface>". The
 *  send happens from the LANE (before any dock pane is open — an open drawer
 *  can intercept lane clicks). */
async function sendToSurface(page: Page, sourceId: string, paramId: string, surfaceId = 'cs-1'): Promise<void> {
  const knob = laneShell(page, sourceId).locator(`[data-testid="control-${paramId}"]`);
  await expect(knob).toBeVisible();
  await knob.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator(`[data-testid="ctx-surface-${surfaceId}"]`).click();
  // The control menu portals an overlay; wait for it to close before the next
  // gesture (a lingering overlay intercepts clicks).
  await expect(menu).toHaveCount(0);
}

test('send a control to a surface → proxy appears, drives the source, survives collapse', async ({ page }) => {
  await setup(page);

  // Fresh surface = the tile's empty-state prompt (the module's discovery path).
  await expect(laneShell(page, 'cs-1').getByTestId('cs-tile-empty-cs-1')).toContainText(/Send to/);

  // Right-click the ADSR tile's attack knob → control menu → Send to surface —
  // from the LANE, before the dock pane opens.
  const knob = laneShell(page, 'adsr-1').locator('[data-testid="control-attack"]');
  await expect(knob).toBeVisible();
  await knob.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  const sendItem = menu.locator('[data-testid="ctx-surface-cs-1"]');
  await expect(sendItem).toContainText('Send to');
  await sendItem.click();
  await expect(menu).toHaveCount(0);

  // The proxy control now lives on the dock BOARD, grouped under the ADSR.
  const surface = await openBoard(page);
  const proxy = surface.locator('[data-testid="cs-board-knob-adsr-1-attack"]');
  await expect(proxy).toBeVisible();
  await expect(surface.locator('[data-testid="cs-board-group-label"]')).toContainText(/adsr/i);
  await expect(surface.locator('[data-testid="cs-board-empty"]')).toHaveCount(0);

  // The binding is recorded on the surface node (a pointer, value-free).
  expect(await readSurfaceBindings(page, 'cs-1')).toEqual([{ moduleId: 'adsr-1', paramId: 'attack' }]);

  // Pointer proof: push the SOURCE param off-default, then reset via the
  // PROXY (double-click) — the source param must change (the proxy writes
  // the source, it has no state of its own).
  await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    w.__patch.nodes['adsr-1'].params.attack = 0.9;
  });
  await surface.locator('[data-testid="cs-board-dial-adsr-1-attack"]').dblclick();
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
  // The group card appears (collapse happened — groups are NON_SHELL_LANE, so
  // the card renders even on the default shell) and the source ADSR's lane
  // node is gone from the canvas...
  await expect(page.locator('[data-testid="group-card"][data-node-id="g-1"]')).toBeVisible();
  await expect(page.locator('.svelte-flow__node[data-id="adsr-1"]')).toHaveCount(0);
  // ...yet the proxy is still on the surface AND still drives the (now
  // collapsed) source — the whole point of the feature.
  await expect(proxy).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    w.__patch.nodes['adsr-1'].params.attack = 0.77;
  });
  await surface.locator('[data-testid="cs-board-dial-adsr-1-attack"]').dblclick();
  const attackCollapsed = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return w.__patch.nodes['adsr-1'].params.attack;
  });
  expect(attackCollapsed).not.toBe(0.77); // proxy still wrote the collapsed source

  // Unbind via the proxy's OWN control menu — it's a real control, so its
  // right-click menu offers "Remove from <surface>" (the proxy shares the
  // source's moduleId:paramId, so the menu knows it's bound here).
  await surface.locator('[data-testid="cs-board-dial-adsr-1-attack"]').click({ button: 'right' });
  const menu2 = page.locator('[data-testid="control-context-menu"]');
  await expect(menu2).toBeVisible();
  const removeItem = menu2.locator('[data-testid="ctx-surface-cs-1"]');
  await expect(removeItem).toContainText('Remove from');
  await removeItem.click();
  await expect.poll(async () => await readSurfaceBindings(page, 'cs-1')).toEqual([]);
  await expect(surface.locator('[data-testid="cs-board-empty"]')).toBeVisible();
});

test('rename a bound control on the surface → custom name persists in node.data (Electra naming)', async ({ page }) => {
  await setup(page);

  // Bind ADSR attack onto the surface (from the lane, then open the board).
  await sendToSurface(page, 'adsr-1', 'attack');
  const surface = await openBoard(page);
  const proxy = surface.locator('[data-testid="cs-board-knob-adsr-1-attack"]');
  await expect(proxy).toBeVisible();

  // The surface defaults to UNLOCKED → the per-knob rename affordance shows.
  await expect(surface).toHaveAttribute('data-locked', 'false');
  const renameBtn = surface.locator('[data-testid="cs-board-rename-adsr-1-attack"]');
  await expect(renameBtn).toBeVisible();
  await renameBtn.click();

  // Type a custom name + commit with Enter.
  const renameInput = surface.locator('[data-testid="cs-board-rename-input-adsr-1-attack"]');
  await expect(renameInput).toBeVisible();
  await renameInput.fill('Punch');
  await renameInput.press('Enter');

  // The custom name persists on the binding in node.data.
  await expect
    .poll(async () => await readSurfaceBindings(page, 'cs-1'))
    .toEqual([{ moduleId: 'adsr-1', paramId: 'attack', name: 'Punch' }]);

  // And the on-card label reflects the custom name (the proxy knob shows it).
  await expect(proxy).toContainText('Punch');

  // Clearing the name reverts the binding to the auto abbreviation (no name key).
  await renameBtn.click();
  await renameInput.fill('');
  await renameInput.press('Enter');
  await expect
    .poll(async () => await readSurfaceBindings(page, 'cs-1'))
    .toEqual([{ moduleId: 'adsr-1', paramId: 'attack' }]);
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

test('multiple controls from multiple modules: grouped, lock/unlock + move, MIDI-mapped works on the proxy', async ({ page, rack }) => {
  await installSimMidi(page);
  // Two source modules + a surface.
  await spawnPatch(page, [
    { id: 'cs-1', type: 'controlSurface', position: { x: 760, y: 60 }, domain: 'meta' },
    { id: 'adsr-1', type: 'adsr', position: { x: 60, y: 60 }, domain: 'audio' },
    { id: 'adsr-2', type: 'adsr', position: { x: 60, y: 420 }, domain: 'audio' },
  ]);

  // Send THREE controls from TWO modules (this is the path that used to break
  // after the first send) — all from the LANE tiles, before the dock opens.
  const sends: Array<[string, string]> = [['adsr-1', 'attack'], ['adsr-1', 'decay'], ['adsr-2', 'attack']];
  for (const [nodeId, paramId] of sends) {
    await sendToSurface(page, nodeId, paramId);
  }

  // All three proxies present on the dock BOARD, grouped into TWO module boxes.
  const surface = await openBoard(page);
  await expect(surface.locator('[data-testid="cs-board-knob-adsr-1-attack"]')).toBeVisible();
  await expect(surface.locator('[data-testid="cs-board-knob-adsr-1-decay"]')).toBeVisible();
  await expect(surface.locator('[data-testid="cs-board-knob-adsr-2-attack"]')).toBeVisible();
  await expect(surface.locator('[data-testid="cs-board-group"]')).toHaveCount(2);
  expect(await readSurfaceBindings(page, 'cs-1')).toHaveLength(3);

  // MIDI-mapped param works THROUGH the surface: learn on the proxy, inject a
  // CC, the proxy shows the binding badge (shared moduleId:paramId key).
  const proxyAttack = surface.locator('[data-testid="cs-board-knob-adsr-1-attack"]');
  await surface.locator('[data-testid="cs-board-dial-adsr-1-attack"]').click({ button: 'right' });
  await page.locator('[data-testid="control-context-menu"] [data-testid="ctx-midi-learn"]').click();
  await injectCc(page, 0, 41, 100);
  await expect(proxyAttack.locator('.midi-badge')).toContainText('CC 41');
  // ...and the SAME binding shows on the source tile (one control, two views;
  // the ADSR has exactly one binding, so exactly one badge on its tile).
  await expect(laneShell(page, 'adsr-1').locator('.midi-badge')).toContainText('CC 41');

  // No lingering control menu (⚠ NOT an Escape press — with the dock open,
  // a spare Escape closes the whole full view out from under the board).
  await expect(page.locator('[data-testid="control-context-menu"]')).toHaveCount(0);

  const box = surface.locator('[data-testid="cs-board-group"][data-source-id="adsr-1"]');
  // The LOCK cell sits on the dock shell's ladder, outside the board itself
  // (scoped to the dock tier — the lane tile ranks the same testid).
  const lockBtn = page
    .locator('[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="cs-1"]')
    .getByTestId('shell-cell-control-surface-lock');

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

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 10 recovered-on-retry observation(s) across 6 SHA(s) / 6 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: that the control surface card grows to contain every proxied group and knob in BOTH locked and unlocked states — controls rendering outside their own card bounds are unreachable.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('card grows so ALL groups + knobs render within bounds (locked + unlocked)', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 10 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
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
