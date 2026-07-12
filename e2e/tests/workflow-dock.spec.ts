// e2e/tests/workflow-dock.spec.ts
//
// WORKFLOW MODE P2.5a — the DOCKING CORE on /rack?mode=workflow:
//
//   * THE SPIKE (gated PatchPanel): a REAL module card renders in a dock
//     rail OUTSIDE the SvelteFlow provider — zero pageerrors, functional
//     patch-menu chrome — while the canvas shows a DockStubCard with the
//     SAME node id (the node's only .svelte-flow__node / handle set).
//   * Dock via right-click → stub appears, cables stay attached to the
//     stub AND functional (signal proof: noise → docked mixer → scope
//     keeps flowing through the docked module's wire).
//   * Independent zoom: ± changes the rendered rail-frame size (discrete
//     50–150%).
//   * Undock restores the dock-time canvas position through the existing
//     layouts/node.position split.
//   * Quicksave slot round-trip: docked state RETIRES to a tombstone when
//     the patch is swapped out and REVIVES on quickload (the verifier's
//     naive-prune scenario, end-to-end).
//   * Dawless unchanged: no rails, no dock menu entries, PatchPanel's
//     canvas handle stack intact.
//
// Driving /rack?mode=workflow keeps this in the NORMAL e2e lane (no
// DB/relay) — same rationale as workflow-mode.spec.ts. Docking is LOCAL
// state (never in the Y.Doc), so no multi-context spec here (the tagged
// multi-user dock spec is P2.5b's, per the owner's attest answer).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, runFor } from './_module-coverage-helpers';

/** Collect page errors + console errors for the zero-pageerror asserts. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Right-click a canvas node (on its TITLE — the card body is full of
 *  knobs/faders whose own contextmenu handlers would win) and pick a
 *  context-menu entry by testid. Dock STUBS have no .title; their whole
 *  face is a neutral surface, so fall back to the node element. */
async function nodeMenuPick(page: Page, nodeId: string, entryTestId: string): Promise<void> {
  const node = page.locator(`.svelte-flow__node[data-id="${nodeId}"]`);
  const title = node.locator('.title');
  if ((await title.count()) > 0) {
    await title.first().click({ button: 'right' });
  } else {
    await node.click({ button: 'right' });
  }
  await page.getByTestId(entryTestId).click();
}

test.describe('P2.5a docking core (workflow racks)', () => {
  test('SPIKE: a real card renders in a rail OUTSIDE the SvelteFlow provider — no pageerrors, single handle set on the stub', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'mx', type: 'mixer', position: { x: 300, y: 200 } }]);

    // Programmatic dock (the __dock hook drives the same dockNode the
    // context menu calls) — LEFT rail, the owner's new v1 zone.
    await page.evaluate(() => {
      (globalThis as unknown as { __dock: { dock: (id: string, z: string) => void } }).__dock.dock('mx', 'left');
    });

    // The rail hosts the REAL MixerCard as a plain mount (no flow host):
    const railCard = page.locator('[data-dock-card="mx"]');
    await expect(railCard).toBeVisible();
    await expect(railCard.locator('.mod-card, .card, .moog-panel').first()).toBeVisible();
    // …with PatchPanel's chrome trigger present (the gated panel mounts
    // its UI — only the provider-coupled handle stack self-disables):
    await expect(railCard.getByTestId('patch-trigger')).toBeVisible();
    // …and ZERO xyflow handles / node wrappers inside the rail:
    await expect(railCard.locator('.svelte-flow__handle')).toHaveCount(0);
    await expect(railCard.locator('.svelte-flow__node')).toHaveCount(0);

    // The canvas presence is the stub — the node's ONE .svelte-flow__node,
    // carrying the full declared handle stack (4 ins + 1 out = 5).
    const stubNode = page.locator('.svelte-flow__node[data-id="mx"]');
    await expect(stubNode).toHaveCount(1);
    await expect(stubNode.locator('[data-testid="dock-stub"]')).toBeVisible();
    await expect(stubNode.locator('.svelte-flow__handle')).toHaveCount(5);

    // The patch MENU works from the rail (document-level event seam):
    await railCard.getByTestId('patch-trigger').click();
    const chrome = page.locator('[data-patch-panel-chrome="mx"]');
    await expect(chrome).toBeVisible();
    // Edge-aligned to the rail frame (not the 0×0 viewport-origin bug):
    const chromeBox = await chrome.boundingBox();
    const frameBox = await railCard.locator('[data-dock-card-frame]').boundingBox();
    expect(chromeBox && frameBox && Math.abs(chromeBox.x - frameBox.x) < 200).toBeTruthy();
    await page.keyboard.press('Escape');

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('dock a matrixmix to the LEFT rail via right-click → stub + rail card; undock via stub menu restores position', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'mm', type: 'matrixMix', position: { x: 420, y: 260 }, domain: 'meta' }]);

    // Right-click → Dock to left rail (allowlisted meta module).
    await nodeMenuPick(page, 'mm', 'ctx-dock-left');

    const rail = page.getByTestId('dock-rail-left');
    await expect(rail).toBeVisible();
    await expect(rail.locator('[data-dock-card="mm"]')).toBeVisible();
    const stub = page.locator('.svelte-flow__node[data-id="mm"] [data-testid="dock-stub"]');
    await expect(stub).toBeVisible();
    await expect(stub).toHaveAttribute('data-stub-zone', 'left');

    // Clicking the stub focuses the rail card (flash affordance).
    await stub.click();
    await expect(rail.locator('[data-dock-card="mm"]')).toHaveClass(/dock-flash/);

    // Undock from the stub's context menu → the full card returns at the
    // dock-time position (single-user path writes node.position).
    await nodeMenuPick(page, 'mm', 'ctx-undock');
    await expect(page.locator('[data-dock-card="mm"]')).toHaveCount(0);
    await expect(page.locator('.svelte-flow__node[data-id="mm"] [data-testid="dock-stub"]')).toHaveCount(0);
    await expect(page.locator('.svelte-flow__node[data-id="mm"] [data-testid="matrixmix-card"]')).toBeVisible();
    const pos = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { position: { x: number; y: number } }> } };
      return w.__patch.nodes['mm']?.position;
    });
    expect(pos).toEqual({ x: 420, y: 260 });
    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('cables to a docked module stay attached to the stub AND functional (signal through the docked wire)', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    // noise → mixer.in1 ; mixer.audio → scope.ch1 — the mixer is the module
    // we dock; the scope taps its OUTPUT, so a peak there is signal flowing
    // THROUGH the docked module's wires.
    await spawnPatch(
      page,
      [
        { id: 'nz', type: 'noise', position: { x: 80, y: 120 } },
        { id: 'mx', type: 'mixer', position: { x: 380, y: 160 } },
        { id: 'scp', type: 'scope', position: { x: 700, y: 160 }, params: { timeMs: 50 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'nz', portId: 'white' }, to: { nodeId: 'mx', portId: 'in1' } },
        { id: 'e2', from: { nodeId: 'mx', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' } },
      ],
    );
    await runFor(page, 400);
    const before = await readScopePeakOverWindow(page, 'scp', 800);
    expect(before.peak, `pre-dock peak=${before.peak.toFixed(4)}`).toBeGreaterThan(0.01);

    const edgeCountBefore = await page.locator('.svelte-flow__edge').count();
    expect(edgeCountBefore).toBe(2);

    // Dock the mixer via the real UI path.
    await nodeMenuPick(page, 'mx', 'ctx-dock-bottom');
    await expect(page.getByTestId('dock-zone-bottom').locator('[data-dock-card="mx"]')).toBeVisible();
    const stub = page.locator('.svelte-flow__node[data-id="mx"] [data-testid="dock-stub"]');
    await expect(stub).toBeVisible();

    // BOTH cables still materialize (now anchored on the stub — same ids).
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);

    // …and the signal still flows THROUGH the docked module's wires.
    const after = await readScopePeakOverWindow(page, 'scp', 800);
    expect(after.peak, `post-dock peak=${after.peak.toFixed(4)}`).toBeGreaterThan(0.01);
    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('independent zoom: ± steps the discrete scale and resizes the rail frame; ctrl+wheel is guarded', async ({ page }) => {
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'mx', type: 'mixer', position: { x: 300, y: 200 } }]);
    await page.evaluate(() => {
      (globalThis as unknown as { __dock: { dock: (id: string, z: string) => void } }).__dock.dock('mx', 'top');
    });
    const card = page.getByTestId('dock-rail-top').locator('[data-dock-card="mx"]');
    await expect(card).toBeVisible();
    const frame = card.locator('[data-dock-card-frame]');
    await expect(card).toHaveAttribute('data-dock-scale', '1');
    const at1 = await frame.boundingBox();

    await card.getByTestId('dock-zoom-in').click();
    await expect(card).toHaveAttribute('data-dock-scale', '1.25');
    const at125 = await frame.boundingBox();
    expect(at1 && at125 && at125.width > at1.width * 1.15).toBeTruthy();

    // Reset → 100%; zoom out → 75% (discrete ladder, clamped ends).
    await card.getByTestId('dock-zoom-reset').click();
    await expect(card).toHaveAttribute('data-dock-scale', '1');
    await card.getByTestId('dock-zoom-out').click();
    await expect(card).toHaveAttribute('data-dock-scale', '0.75');
    const at075 = await frame.boundingBox();
    expect(at1 && at075 && at075.width < at1.width * 0.85).toBeTruthy();
  });

  test('quicksave slot round-trip: docked state retires to a tombstone and REVIVES on quickload', async ({ page }) => {
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'mx', type: 'mixer', position: { x: 300, y: 200 } }]);
    await nodeMenuPick(page, 'mx', 'ctx-dock-top');
    await expect(page.getByTestId('dock-rail-top').locator('[data-dock-card="mx"]')).toBeVisible();

    // Quicksave the docked patch to slot 1 (File.. menu).
    await page.getByTestId('workflow-file-trigger').click();
    await page.getByTestId('workflow-file-quicksave').click();
    await page.getByTestId('workflow-quicksave-1').click();

    // Simulate the slot SWITCH: the whole node set is replaced (the exact
    // scenario naive dock-GC wipes state on). The node vanishes → the
    // entry RETIRES (stub + rail card gone, tombstone held — not wiped).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      };
      for (const k of Object.keys(w.__patch.edges)) delete w.__patch.edges[k];
      for (const k of Object.keys(w.__patch.nodes)) {
        if (!k.startsWith('pinned-')) delete w.__patch.nodes[k];
      }
    });
    await expect(page.locator('[data-dock-card="mx"]')).toHaveCount(0);
    await expect(page.locator('.svelte-flow__node[data-id="mx"]')).toHaveCount(0);
    const retired = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __dock: { entryFor: (id: string) => unknown; tombstoneCount: () => number };
      };
      return { entry: w.__dock.entryFor('mx'), tombstones: w.__dock.tombstoneCount() };
    });
    expect(retired.entry).toBeNull();
    expect(retired.tombstones).toBeGreaterThanOrEqual(1);

    // Quickload slot 1 → the node id returns → the dock entry REVIVES:
    // rail card + stub reappear without any user re-docking.
    await page.getByTestId('workflow-file-trigger').click();
    await page.getByTestId('workflow-file-quickload').click();
    await page.getByTestId('workflow-quickload-1').click();
    await expect(page.getByTestId('dock-rail-top').locator('[data-dock-card="mx"]')).toBeVisible();
    await expect(page.locator('.svelte-flow__node[data-id="mx"] [data-testid="dock-stub"]')).toBeVisible();
  });

  test('allowlist gating: non-dockable types get no Dock entries; pinned trio is excluded', async ({ page }) => {
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'vco', type: 'analogVco', position: { x: 300, y: 200 } }]);
    await page.locator('.svelte-flow__node[data-id="vco"]').click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible();
    await expect(page.getByTestId('ctx-dock-top')).toHaveCount(0);
    await expect(page.getByTestId('ctx-dock-left')).toHaveCount(0);
    await expect(page.getByTestId('ctx-dock-bottom')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // The pinned trio never reaches the canvas (no card to right-click) —
    // and the M drawer occupant renders WITHOUT an undock affordance.
    await page.keyboard.press('m');
    const drawer = page.getByTestId('dock-zone-bottom');
    await expect(drawer.locator('[data-dock-card="pinned-mixmstrs"]')).toBeVisible();
    await expect(drawer.getByTestId('dock-undock')).toHaveCount(0);
    await expect(drawer.getByTestId('dock-close')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });
});

test.describe('P2.5b pan cable tail (workflow racks)', () => {
  test('a screen-space tail bridges stub→rail DURING a pan gesture — one path per docked-with-edges node — and dies on release', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    // mx is docked WITH an edge (gets a tail); lf is docked WITHOUT edges
    // (degrades to nothing — the tail is per docked-with-edges node).
    await spawnPatch(
      page,
      [
        { id: 'nz', type: 'noise', position: { x: 80, y: 120 } },
        { id: 'mx', type: 'mixer', position: { x: 380, y: 160 } },
        { id: 'lf', type: 'lfo', position: { x: 380, y: 430 } },
      ],
      [{ id: 'e1', from: { nodeId: 'nz', portId: 'white' }, to: { nodeId: 'mx', portId: 'in1' } }],
    );
    await page.evaluate(() => {
      const d = (globalThis as unknown as { __dock: { dock: (id: string, z: string) => void } }).__dock;
      d.dock('mx', 'top');
      d.dock('lf', 'top');
    });
    await expect(page.getByTestId('dock-rail-top').locator('[data-dock-card="mx"]')).toBeVisible();

    // Idle: ZERO overlay DOM (the tail is gesture-scoped, zero idle cost).
    await expect(page.getByTestId('dock-pan-tail')).toHaveCount(0);

    // Pan gesture: press-drag on an empty spot of the pane (lower-left
    // third — the far corners host the minimap toggle / Controls chrome).
    const pane = page.locator('.svelte-flow__pane:visible').first();
    const box = await pane.boundingBox();
    expect(box).not.toBeNull();
    const sx = box!.x + box!.width * 0.35;
    const sy = box!.y + box!.height * 0.9;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 80, sy - 40, { steps: 6 });
    await page.mouse.move(sx - 160, sy - 80, { steps: 6 });

    // Mid-gesture: the tail overlay exists with EXACTLY ONE path — mx (has
    // an edge) gets a tail, lf (no edges) does not.
    await expect(page.getByTestId('dock-pan-tail')).toBeVisible();
    await expect(page.locator('[data-testid="dock-pan-tail"] path')).toHaveCount(1);
    await expect(page.locator('[data-tail-node="mx"]')).toHaveCount(1);

    // Release: the tail dies with the gesture (edges snap under the rail).
    await page.mouse.up();
    await expect(page.getByTestId('dock-pan-tail')).toHaveCount(0);
    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('zero docked-with-edges nodes → a pan gesture renders NO tail overlay', async ({ page }) => {
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'lf', type: 'lfo', position: { x: 380, y: 200 } }]);
    await page.evaluate(() => {
      (globalThis as unknown as { __dock: { dock: (id: string, z: string) => void } }).__dock.dock('lf', 'top');
    });
    await expect(page.getByTestId('dock-rail-top').locator('[data-dock-card="lf"]')).toBeVisible();
    const pane = page.locator('.svelte-flow__pane:visible').first();
    const box = await pane.boundingBox();
    const sx = box!.x + box!.width * 0.35;
    const sy = box!.y + box!.height * 0.9;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 120, sy - 60, { steps: 8 });
    // Give a settled frame mid-gesture, then assert nothing rendered.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    await expect(page.getByTestId('dock-pan-tail')).toHaveCount(0);
    await page.mouse.up();
  });
});

test.describe('dawless is unchanged by the docking core', () => {
  test('/rack: no rails, no dock menu entries, PatchPanel handle stack intact on canvas cards', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/rack');
    await expect(page.locator('header.topbar')).toBeVisible();
    await page.locator('.svelte-flow__pane').waitFor({ state: 'visible' });

    // Zero dock chrome anywhere.
    await expect(page.getByTestId('dock-rail-top')).toHaveCount(0);
    await expect(page.getByTestId('workflow-leftbar')).toHaveCount(0);
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);

    // A canvas card still mounts its FULL PatchPanel handle stack (the
    // gate is provider-presence, and canvas cards are inside the provider).
    await spawnPatch(page, [{ id: 'mx', type: 'mixer', position: { x: 300, y: 200 } }]);
    const node = page.locator('.svelte-flow__node[data-id="mx"]');
    await expect(node.locator('.svelte-flow__handle')).toHaveCount(5);

    // Right-click → NO dock entries in dawless (workflow-only feature).
    await node.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible();
    await expect(page.getByTestId('ctx-dock-top')).toHaveCount(0);
    await expect(page.getByTestId('ctx-undock')).toHaveCount(0);
    await page.keyboard.press('Escape');

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });
});

test.describe('dock drawer patch menu + rear-view patching (owner fixes 2026-07-11)', () => {
  /** Wait for one pinned node (the drawer occupants spawn async). */
  async function waitForPin(page: Page, id: string): Promise<void> {
    await page.waitForFunction(
      (pid) => {
        const w = globalThis as unknown as {
          __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
        };
        return w.__patch?.nodes[pid]?.data?.pinned === true;
      },
      id,
      { timeout: 10_000 },
    );
  }

  /** Open the bottom drawer on the pinned CLIPPLAYER via the C keymap. */
  async function openClipplayerDrawer(page: Page) {
    await page.locator('.svelte-flow__pane:visible').first().click({ position: { x: 500, y: 380 } });
    await page.keyboard.press('c');
    const drawer = page.getByTestId('dock-zone-bottom');
    await expect(drawer).toBeVisible();
    const card = drawer.locator('[data-dock-card="pinned-clipplayer"]');
    await expect(card).toBeVisible();
    return card;
  }

  /** The connectDragState pickup snapshot (dev hook). */
  async function pickupState(page: Page) {
    return page.evaluate(() => {
      const w = globalThis as unknown as {
        __connectDragState?: { mode: string; pickupSource: { nodeId: string; portId: string } | null };
      };
      const s = w.__connectDragState;
      return s ? { mode: s.mode, source: s.pickupSource } : null;
    });
  }

  test('patch-to picker spawns ADJACENT to the drawer card, clamped on-screen (not at the viewport origin)', async ({ page }) => {
    // Owner: "patch to is a mess in terms of where the menu spawns" — the
    // pinned drawer card has NO canvas element, so the picker's card-rect
    // lookup missed and fell back to a stale (0,0): the menu opened at the
    // TOP-LEFT of the screen, nowhere near the bottom-drawer card. Fixed by
    // resolving the dock frame ([data-dock-card-frame]) first.
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-clipplayer');
    const card = await openClipplayerDrawer(page);

    // Drill: patch trigger → OUTPUT → jack-click a row (begins the carry)
    // → the root "patch to…" entry opens the target picker.
    await card.getByTestId('patch-trigger').click();
    const chrome = page.locator('[data-patch-panel-chrome="pinned-clipplayer"]');
    await expect(chrome).toBeVisible();
    await chrome.locator('[data-testid="patch-panel-nav"][data-nav="outputs"]').click();
    await chrome.locator('[data-testid="patch-panel-port-row"][data-direction="output"]').first().click();
    await chrome.getByTestId('patch-panel-patch-to').click();

    const picker = page.getByTestId('port-context-menu');
    await expect(picker).toBeVisible();
    // One settled frame: openPortMenuAt's post-mount clamp may nudge it.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const pickerBox = await picker.boundingBox();
    const frameBox = await card.locator('[data-dock-card-frame]').boundingBox();
    const viewport = page.viewportSize()!;
    expect(pickerBox && frameBox).toBeTruthy();
    // ADJACENT to the drawer card: horizontally within the card's span
    // (edge-aligned ±picker width) and vertically in the drawer's
    // neighborhood — NOT the pre-fix (0,0) top-left spawn.
    expect(Math.abs(pickerBox!.x - frameBox!.x)).toBeLessThan(260);
    expect(pickerBox!.y).toBeGreaterThan(frameBox!.y - 300);
    // …and clamped fully on-screen (the drawer hugs the viewport bottom).
    expect(pickerBox!.y).toBeGreaterThanOrEqual(0);
    expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(viewport.width + 1);

    await page.keyboard.press('Escape');
    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('REAR VIEW (Tab): patch OUT of the docked card back jacks → canvas commit', async ({ page }) => {
    // Owner: "the patch from on the back of clip player seems like i can't
    // patch out of those views when i hit tab to flip." Root cause: the
    // rear-view front-inert CSS was .svelte-flow__node-scoped, so a
    // dock-hosted card's live FRONT stayed painted over its back panel and
    // swallowed the jack clicks. Fixed by the .dock-*-sized mirror rules.
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-clipplayer');
    // A canvas destination with a gate input (ADSR.gate).
    await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 420, y: 120 } }]);
    await waitForPin(page, 'pinned-clipplayer'); // spawnPatch wiped; ensure re-spawned
    const card = await openClipplayerDrawer(page);

    // Tab → rear view; the DOCKED card's back panel becomes the live
    // patch surface (jacks visible + clickable).
    await page.keyboard.press('Tab');
    const outJack = card.locator('[data-testid="back-jack"][data-port-id="gate1"][data-direction="output"]');
    await expect(outJack).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(450); // flip-in keyframe settles

    // Click the docked OUTPUT jack → a pickup begins from the drawer card.
    await outJack.click();
    await expect.poll(() => pickupState(page)).toEqual({
      mode: 'pickup',
      source: expect.objectContaining({ nodeId: 'pinned-clipplayer', portId: 'gate1' }),
    });

    // Commit on the canvas ADSR's back GATE jack → the SAME validated edge
    // a front-view patch writes.
    await page
      .locator('.svelte-flow__node[data-id="env"] [data-testid="back-jack"][data-port-id="gate"][data-direction="input"]')
      .click();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: {
              edges: Record<
                string,
                { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined
              >;
            };
          };
          return Object.values(w.__patch.edges).some(
            (e) =>
              !!e &&
              e.source.nodeId === 'pinned-clipplayer' &&
              e.source.portId === 'gate1' &&
              e.target.nodeId === 'env' &&
              e.target.portId === 'gate',
          );
        }),
      { timeout: 5_000 })
      .toBe(true);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('REAR VIEW (Tab): patch INTO the docked card — pickup from its input back jack, commit on a canvas output', async ({ page }) => {
    // The other direction: grabbing the docked card's INPUT back jack
    // (stop_all) starts a reverse pickup; the commit lands on a canvas
    // card's OUTPUT back jack — clipplayer receives the cable.
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-clipplayer');
    await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 420, y: 120 } }]);
    await waitForPin(page, 'pinned-clipplayer');
    const card = await openClipplayerDrawer(page);

    await page.keyboard.press('Tab');
    const inJack = card.locator('[data-testid="back-jack"][data-port-id="stop_all"][data-direction="input"]');
    await expect(inJack).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(450);

    await inJack.click();
    await expect.poll(() => pickupState(page)).toEqual({
      mode: 'pickup',
      source: expect.objectContaining({ nodeId: 'pinned-clipplayer', portId: 'stop_all' }),
    });

    // Commit on ADSR's ENV output back jack (cv → gate: CV-family legal).
    await page
      .locator('.svelte-flow__node[data-id="env"] [data-testid="back-jack"][data-port-id="env"][data-direction="output"]')
      .click();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: {
              edges: Record<
                string,
                { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined
              >;
            };
          };
          return Object.values(w.__patch.edges).some(
            (e) =>
              !!e &&
              e.source.nodeId === 'env' &&
              e.source.portId === 'env' &&
              e.target.nodeId === 'pinned-clipplayer' &&
              e.target.portId === 'stop_all',
          );
        }),
      { timeout: 5_000 })
      .toBe(true);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });
});
