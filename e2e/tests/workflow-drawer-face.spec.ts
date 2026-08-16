// e2e/tests/workflow-drawer-face.spec.ts
//
// #1739 — THE PINNED `m` TRAY RENDERS THE PROMOTED FACE, AND KEEPS EVERY
// AFFORDANCE IT SHIPPED WITH. Owner ruling: *"the `m` key tray view needs to
// show the new card and not the old one"*, and then: *"functional parity and no
// degradation is a hard requirement for all of this."* Both, or neither.
//
// ── WHY THIS FILE EXISTS AT ALL, WHICH IS THE FINDING ──────────────────────
//
// The drawer already had three shipped specs — `workflow-dock.spec.ts`'s
// `masterL`-out and `ch1L`-in rear-view patches, and `workflow-mode.spec.ts`'s
// "the pinned card renders IN FULL". ALL THREE DRIVE `/rack?shell=legacy`, and
// `dockRailRendersFace` reads `shellFaces`, so all three exercise the LEGACY
// arm forever. They pass unchanged across this change — and they would have
// passed unchanged if the tray had been left completely broken. A suite that
// cannot fail on the surface under test is not coverage of it.
//
// So this file is the same drawer on the DEFAULT shell: same node
// (`pinned-mixmstrs`), same key (`m`), same anchors, same two port ids the
// owner's ES-9 send/return rack uses.
//
// ── THE PARITY ASSERTIONS ARE DERIVED, NEVER TYPED ────────────────────────
//
// "The face renders here" is asserted by comparing the tray against the DOCK
// FULL VIEW of the SAME node: identical `control-<paramId>` set, identical
// band id set, both directions. No control count, no band count and no width
// appears in this file — a number here would be stale the next time a page is
// added, and would say nothing about whether the two hosts agree.
//
// ── WHAT THIS SPEC STRUCTURALLY CANNOT SEE ────────────────────────────────
//
//   * PIXELS. No VRT baseline captures the pinned bottom drawer (grep
//     `dock-zone-bottom` under `e2e/vrt/` → zero hits), before or after.
//   * The `?shell=legacy` arm — that is the three specs named above.
//   * A USER-DOCKED promoted module, which deliberately still renders its
//     legacy card (`dockRailRendersFace` requires `pinned`).
//   * The three affordances the promoted FACE has never carried on any surface
//     — the SECTIONED drill-down menu, in-card rename, and the card's compact
//     toggle. Measured and filed as #1762, not silently absorbed: this spec
//     asserts the menu OPENS and is frame-anchored, and deliberately does not
//     assert its grouping, because the grouping genuinely changed.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';

/** Collect page errors + console errors for the zero-pageerror asserts. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** The DEFAULT shell — no `?shell=legacy`. That is the whole point of the file. */
async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

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

/** Open the pinned MIXMSTRS drawer via the M keymap; return the card host. */
async function openTray(page: Page) {
  await page.locator('.svelte-flow__pane:visible').first().click({ position: { x: 500, y: 380 } });
  await page.keyboard.press('m');
  const drawer = page.getByTestId('dock-zone-bottom');
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('data-dock-type', 'mixmstrs');
  const card = drawer.locator('[data-dock-card="pinned-mixmstrs"]');
  await expect(card).toBeVisible();
  return card;
}

/**
 * Settle the rear-view flip WITHOUT a wall-clock wait.
 *
 * `card-back-flip-in` is a 360 ms CSS keyframe the app itself defines, and the
 * shipped legacy specs pause 450 ms for it. `getAnimations({subtree:true})`
 * waits for the ACTUAL animation objects to finish, so this is renderer- and
 * machine-independent and needs no budget: on a fast machine it resolves in one
 * animation frame, on a loaded one it resolves when the paint really settled.
 */
async function settleFlip(card: ReturnType<Page['locator']>): Promise<void> {
  await card.evaluate(async (el: Element) => {
    await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined)));
  });
}

/** The `control-<paramId>` testids and `face-page` band ids under a root. */
async function faceInventory(root: ReturnType<Page['locator']>) {
  return root.evaluate((el: Element) => ({
    controls: [...el.querySelectorAll('[data-testid^="control-"]')]
      .map((n) => n.getAttribute('data-testid') ?? '')
      .sort(),
    bands: [...el.querySelectorAll('[data-testid="face-page"]')]
      .map((n) => n.getAttribute('data-face-page') ?? '')
      .sort(),
    hiddenBands: [...el.querySelectorAll('[data-testid="face-page"][hidden]')]
      .map((n) => n.getAttribute('data-face-page') ?? '')
      .sort(),
  }));
}

/** The connectDragState pickup snapshot (dev hook) — verbatim from
 *  `workflow-dock.spec.ts`, so the two surfaces read the same instrument. */
async function pickupState(page: Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __connectDragState?: { mode: string; pickupSource: { nodeId: string; portId: string } | null };
    };
    const s = w.__connectDragState;
    return s ? { mode: s.mode, source: s.pickupSource } : null;
  });
}

/** A node's stored param value (`null` when it is still on the def default). */
function readParam(page: Page, nodeId: string, pid: string): Promise<number | null> {
  return page.evaluate(
    ({ nodeId, pid }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch.nodes[nodeId]?.params?.[pid] ?? null;
    },
    { nodeId, pid },
  );
}

/** Does an edge `src.srcPort → dst.dstPort` exist in the live patch? */
async function hasEdge(page: Page, src: string, srcPort: string, dst: string, dstPort: string) {
  return page.evaluate(
    ([s, sp, d, dp]) => {
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
          !!e && e.source.nodeId === s && e.source.portId === sp && e.target.nodeId === d && e.target.portId === dp,
      );
    },
    [src, srcPort, dst, dstPort] as const,
  );
}

/** Answer the WIDTH CHOOSER a stereo/mono commit raises. Asserted VISIBLE
 *  first, so a caller that keeps this line after the dialog stops appearing
 *  goes red instead of silently clicking nothing. */
async function answerWidthChooser(page: Page, mode: 'left' | 'right' | 'both'): Promise<void> {
  const chooser = page.getByTestId('stereo-drop-choice');
  await expect(chooser, 'a width-mismatched commit must ask which channel').toBeVisible();
  await chooser.locator(`[data-testid="stereo-drop-choice-option"][data-mode="${mode}"]`).click();
  await expect(chooser).toHaveCount(0);
}

test.describe('workflow · the pinned `m` tray renders the promoted face (#1739)', () => {
  test('the tray mounts the FACE, and its control/band inventory EQUALS the dock full view', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-mixmstrs');
    const card = await openTray(page);

    // ── THE FACE IS ACTUALLY HERE ────────────────────────────────────────
    const shell = card.locator('[data-testid="module-shell"]');
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-shell-type', 'mixmstrs');
    // The DRAWER view, not the lane one — a shell that fell back to 'lane'
    // would still be "a module-shell" while painting a fraction of the face.
    await expect(shell).toHaveAttribute('data-shell-view', 'drawer');
    await expect(shell).toHaveAttribute('data-shell-tier', 'dock');
    // …and the legacy card is GONE from this host (the owner's actual report).
    await expect(card.locator('.mod-card, .moog-panel')).toHaveCount(0);
    // The face's own furniture, by its own testids — not "something painted".
    await expect(card.getByTestId('face-pages')).toBeVisible();
    await expect(card.getByTestId('face-hero')).toBeVisible();
    await expect(card.getByTestId('face-hero-readouts')).toBeVisible();

    const trayFace = await faceInventory(card);
    expect(trayFace.controls.length, 'the tray face must render control cells at all').toBeGreaterThan(0);
    expect(trayFace.bands.length, 'the tray face must render section bands at all').toBeGreaterThan(0);
    // NO TAB RAIL IN THIS HOST ⇒ NO HIDDEN BANDS. `DockCardHost` paints no rail,
    // so `dockTabPlan` must answer "untabbed" here however many bands the face
    // grows: a hide with no rail is a blank faceplate.
    expect(trayFace.hiddenBands, 'a drawer face must never hide a band').toEqual([]);
    await expect(card.locator('[data-face-tab]')).toHaveCount(0);

    // ── DERIVED PARITY: the same node's DOCK FULL VIEW, same inventory ───
    // The strongest available statement that "the promoted face renders in the
    // tray", and it carries no number: if the two hosts ever disagree about a
    // single control or band, this is red — in either direction.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);
    await page.evaluate(() => {
      (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(
        'pinned-mixmstrs',
      );
    });
    const pane = page.locator('[data-pane-node="pinned-mixmstrs"]');
    await expect(pane.locator('[data-testid="module-shell"]')).toBeVisible();
    const fullFace = await faceInventory(pane);
    expect(trayFace.controls, 'tray vs full-view control cells').toEqual(fullFace.controls);
    expect(trayFace.bands, 'tray vs full-view section bands').toEqual(fullFace.bands);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('every tray AFFORDANCE survives: jack rail, back jacks, zoom ladder, close, no undock', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-mixmstrs');
    const card = await openTray(page);

    // ── PATCH SURFACE (rear): the back panel is IN THE DOM with the two ports
    //    the owner's ES-9 rack uses. (Clicking them is the next two tests.)
    await expect(card.getByTestId('card-back-panel')).toHaveCount(1);
    await expect(
      card.locator('[data-testid="back-jack"][data-port-id="masterL"][data-direction="output"]'),
    ).toHaveCount(1);
    await expect(
      card.locator('[data-testid="back-jack"][data-port-id="ch1L"][data-direction="input"]'),
    ).toHaveCount(1);

    // ── PATCH SURFACE (front): the jack rail + its drill-down trigger. The
    //    legacy card offered the two CORNER triggers; the face offers the lane
    //    rail's. Both open the SAME portaled patch menu, and it must be
    //    EDGE-ALIGNED TO THE DOCK FRAME rather than the viewport origin —
    //    `PatchPanel.cardRectOf` resolves that through `[data-dock-card-frame]`,
    //    an anchor this change deliberately left on the same element.
    await expect(card.getByTestId('lane-jack-rail')).toBeVisible();
    const trigger = card.getByTestId('patch-trigger');
    await expect(trigger).toHaveCount(1);
    await trigger.click();
    const chrome = page.locator('[data-patch-panel-chrome="pinned-mixmstrs"]');
    await expect(chrome).toBeVisible();
    const chromeBox = (await chrome.boundingBox())!;
    expect(chromeBox.x + chromeBox.y, 'the patch menu must not spawn at the viewport origin').toBeGreaterThan(0);
    // Close it by re-clicking the trigger — NOT with Escape, which is the
    // DRAWER's own close key (asserted at the end of this test).
    await trigger.click();
    await expect(chrome).toHaveCount(0);
    // ⚠ NO EXPAND PILL: `expand()` opens the full view, and the store keeps
    // pinned XOR full-view — the pill would close the tray it lives in.
    await expect(card.locator('[data-testid="shell-open-dock"]')).toHaveCount(0);

    // ── HOST CHROME: the zoom trio, the ✕, and NO undock (pinned occupants
    //    are drawer-only forever — owner Q2).
    await expect(card.getByTestId('dock-zoom-out')).toBeVisible();
    await expect(card.getByTestId('dock-zoom-reset')).toBeVisible();
    await expect(card.getByTestId('dock-zoom-in')).toBeVisible();
    await expect(card.getByTestId('dock-close')).toBeVisible();
    await expect(card.getByTestId('dock-undock')).toHaveCount(0);
    await expect(page.getByTestId('dock-grabber-bottom')).toHaveCount(1);

    // ZOOM ACTUALLY ZOOMS. Not "the button exists": the measured frame must
    // GROW, and by the ratio the store stepped — the shell has no intrinsic
    // size outside a flow node, so a collapsed measure would read as a frame
    // that never moves. Measured in CSS px.
    const frame = card.locator('[data-dock-card-frame]');
    const before = await frame.boundingBox();
    const scaleBefore = Number(await card.getAttribute('data-dock-scale'));
    expect(before?.width ?? 0, 'the drawer face must have a real measured width in CSS px').toBeGreaterThan(0);
    await card.getByTestId('dock-zoom-in').click();
    await expect
      .poll(async () => Number(await card.getAttribute('data-dock-scale')))
      .toBeGreaterThan(scaleBefore);
    const scaleAfter = Number(await card.getAttribute('data-dock-scale'));
    await expect
      .poll(async () => Math.round(((await frame.boundingBox())?.width ?? 0) * 10) / 10)
      .toBeCloseTo(((before?.width ?? 0) / scaleBefore) * scaleAfter, 0);
    // …and the reset pill puts it back.
    await card.getByTestId('dock-zoom-reset').click();
    await expect.poll(async () => Number(await card.getAttribute('data-dock-scale'))).toBe(1);

    // ── CLOSE (✕), REOPEN (m), CLOSE (Esc) — the three ways the tray opens and
    //    shuts, all still wired.
    await card.getByTestId('dock-close').click();
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);
    await page.keyboard.press('m');
    await expect(page.getByTestId('dock-zone-bottom')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('a control edit and its MIDI-learn menu both reach the graph FROM THE TRAY', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-mixmstrs');
    const card = await openTray(page);

    // A PARAM EDIT from the tray lands in the GRAPH — the same drag gesture and
    // the same `__patch` read every other face spec uses.
    const knob = card.locator('[data-testid="control-ch1_low"]');
    await expect(knob).toBeVisible();
    // ⚠ SCROLL IT IN FIRST. The drawer is a ~430px window onto a ~1450px
    // faceplate (`.dock-rail-cards` is `overflow:auto`), so a cell's
    // boundingBox can be real while the pixels are outside the rail's clip —
    // and a mouse gesture at those coordinates lands on whatever is painted
    // there instead, which reads as "the control is dead".
    await knob.scrollIntoViewIfNeeded();
    const before = await readParam(page, 'pinned-mixmstrs', 'ch1_low');
    const box = (await knob.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() => readParam(page, 'pinned-mixmstrs', 'ch1_low'), {
        message: 'dragging a tray face cell must commit into __patch',
      })
      .not.toBe(before);

    // ── THE OWNER'S NEON FADERS SURVIVE THE HOST CHANGE. `console.css` is keyed
    //    on the SHELL root's `data-shell-type`, so it paints wherever the face
    //    paints — asserted as the resolved CHAIN (`--domain`, i.e. the module's
    //    own spine colour), never a literal hex, exactly as the stylesheet
    //    argues it should be.
    const fader = card.locator('[data-testid="control-ch1_volume"]');
    await expect(fader).toBeVisible();
    const neon = await fader.evaluate((el: Element) => {
      const cs = getComputedStyle(el);
      return {
        thumb: cs.getPropertyValue('--fader-thumb-bg').trim(),
        domain: cs.getPropertyValue('--domain').trim(),
      };
    });
    expect(neon.domain, 'the shell must publish a domain colour in the tray').not.toBe('');
    expect(neon.thumb, 'the fader accent must BE the domain chain, not a grey default').toBe(neon.domain);

    // ── MIDI-LEARN. A face cell is the same live, MIDI-assignable control a
    //    hand-built card carries (`cardParams` closures + KnobConic's
    //    `makeMidiAssignable`), so the shared menu opens on it here too. LAST,
    //    deliberately: the portaled menu covers the tray while it is up, and
    //    Escape — the obvious dismissal — is the DRAWER's own close key.
    await knob.click({ button: 'right' });
    const menu = page.getByTestId('control-context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('ctx-midi-learn')).toBeVisible();

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('REAR VIEW (Tab) from the FACE tray: patch OUT of masterL → canvas commit', async ({ page }) => {
    // The default-shell mirror of `workflow-dock.spec.ts`'s masterL test. Same
    // node, same port, same anchors — the ONE difference is that here the
    // drawer is rendering `<ModuleShell view='drawer'>`, so the back panel is
    // the one the shell's own PatchPanel puts in the tile.
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-mixmstrs');
    await spawnPatch(page, [{ id: 'amp', type: 'vca', position: { x: 420, y: 120 } }]);
    await waitForPin(page, 'pinned-mixmstrs'); // spawnPatch wiped; ensure re-spawned
    const card = await openTray(page);
    // Proves this test is looking at the FACE, not the legacy card — without
    // it the assertions below would be green on either.
    await expect(card.locator('[data-testid="module-shell"]')).toHaveAttribute('data-shell-view', 'drawer');

    await pressFlipKey(page);
    const outJack = card.locator('[data-testid="back-jack"][data-port-id="masterL"][data-direction="output"]');
    await expect(outJack).toBeVisible({ timeout: 5_000 });
    await settleFlip(card);

    await outJack.click();
    await expect.poll(() => pickupState(page)).toEqual({
      mode: 'pickup',
      source: expect.objectContaining({ nodeId: 'pinned-mixmstrs', portId: 'masterL' }),
    });

    await page
      .locator('.svelte-flow__node[data-id="amp"] [data-testid="back-jack"][data-port-id="audio"][data-direction="input"]')
      .click();
    // MASTER is a stereo pair and VCA.audio is one mono input, so the commit
    // asks which channel first.
    await answerWidthChooser(page, 'left');
    await expect
      .poll(() => hasEdge(page, 'pinned-mixmstrs', 'masterL', 'amp', 'audio'), { timeout: 5_000 })
      .toBe(true);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('REAR VIEW (Tab) from the FACE tray: patch INTO ch1L ← canvas output', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-mixmstrs');
    await spawnPatch(page, [{ id: 'amp', type: 'vca', position: { x: 420, y: 120 } }]);
    await waitForPin(page, 'pinned-mixmstrs');
    const card = await openTray(page);
    await expect(card.locator('[data-testid="module-shell"]')).toHaveAttribute('data-shell-view', 'drawer');

    await pressFlipKey(page);
    const inJack = card.locator('[data-testid="back-jack"][data-port-id="ch1L"][data-direction="input"]');
    await expect(inJack).toBeVisible({ timeout: 5_000 });
    await settleFlip(card);

    await inJack.click();
    await expect.poll(() => pickupState(page)).toEqual({
      mode: 'pickup',
      source: expect.objectContaining({ nodeId: 'pinned-mixmstrs', portId: 'ch1L' }),
    });

    await page
      .locator('.svelte-flow__node[data-id="amp"] [data-testid="back-jack"][data-port-id="audio"][data-direction="output"]')
      .click();
    await answerWidthChooser(page, 'left');
    await expect
      .poll(() => hasEdge(page, 'amp', 'audio', 'pinned-mixmstrs', 'ch1L'), { timeout: 5_000 })
      .toBe(true);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });
});
