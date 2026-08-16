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

// ── ATTEST: THIS FILE COSTS NOTHING, AND THAT WAS MEASURED, NOT ASSUMED ────
//
// "adding an e2e spec moves the collab hash" is the folk rule and it is wrong.
// `collab-attest-lib.ts` puts only FOUR named files from `e2e/tests/` in the
// basis wholesale (`_collab-helpers.ts`, `_helpers.ts`, `_drivers.ts`,
// `_registry.ts`); every other spec enters by TAG. This spec carries no
// multiplayer tag and edits none of those four, so it is out of the basis.
// Verified rather than reasoned: `task collab:attest:check` and `task
// webgl:attest:check` both report an existing attestation on this tree.
//
// ⚠ AND THE TAG TEST IS A GREP OVER THE WHOLE FILE, COMMENTS INCLUDED. An
// earlier draft of this very comment spelled the tag in its at-sign form to
// explain the rule, which enrolled the spec in the basis and moved the hash
// from bb867526… to a4dd1f78… — a prose edit buying a re-attest. Name the tags
// in prose only in the bare form, as here (collab / capacity).

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

  // ── THE OWNER'S FOUR REVIEW ITEMS, MEASURED ─────────────────────────────
  //
  // "the level settings need to be above the rows of dials perfectly" is a
  // GEOMETRY claim, so it gets a geometry assertion. A screenshot comparison
  // cannot express "perfectly" and a VRT baseline would go green on any drift
  // that was captured — this reads the centres.
  test('OWNER ITEM 2: every LEVEL fader is centred EXACTLY over its own dial column', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-mixmstrs');
    const card = await openTray(page);
    await expect(card.locator('[data-testid="module-shell"]')).toBeVisible();

    // The channels band must BE a console grid — the mechanism the alignment
    // comes from. Asserting the outcome without the mechanism would pass on a
    // coincidence at one viewport.
    const band = card.locator('[data-face-page="channels"]');
    await expect(band, 'the channels band lays out as a console grid').toHaveAttribute(
      'data-console-cols',
      /^[0-9]+$/,
    );

    // Column centres, read off the live boxes. Every fader against every dial
    // in its own strip — level over LOW over MID over HIGH.
    const drift = await card.evaluate((host: Element) => {
      const cell = (id: string) => {
        const el = host.querySelector(`[data-testid="control-${id}"]`);
        return el ? (el.closest('[data-cell-key]') ?? el) : null;
      };
      const cx = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.x + r.width / 2;
      };
      const out: { ch: number; row: string; dx: number }[] = [];
      // Channel count is READ off the rendered band, never typed here.
      const faders = [...host.querySelectorAll('[data-face-cluster="level"] [data-cell-key]')].length;
      for (let ch = 1; ch <= faders; ch++) {
        const f = cell(`ch${ch}_volume`);
        if (!f) continue;
        for (const row of ['low', 'mid', 'high']) {
          const k = cell(`ch${ch}_${row}`);
          if (!k) continue;
          out.push({ ch, row, dx: +(cx(f) - cx(k)).toFixed(2) });
        }
      }
      return out;
    });

    expect(drift.length, 'the sweep must actually have found columns to compare').toBeGreaterThan(0);
    const offenders = drift.filter((d) => Math.abs(d.dx) > 0.5);
    expect(
      offenders,
      `fader/dial centre drift in CSS px — a column whose fader is not over its own dials is ` +
        `not a console strip. Measured before the console grid: ch1 -9.9, ch2 -29.6, ch3 -49.3, ` +
        `accumulating to about -138 by ch8.`,
    ).toEqual([]);

    // ── OWNER ITEM 1: the send PRE/POST echoes are OUT of the header …
    const labels = await card
      .getByTestId('face-hero-readouts')
      .evaluate((el: Element) => [...el.querySelectorAll('dt')].map((n) => (n.textContent ?? '').trim()));
    expect(labels, 'the header keeps only what is NOT visible elsewhere on the face').toEqual([
      'bus',
      'asleep',
    ]);
    // … and the CONTROLS they echoed are still on the face, still reachable.
    // Removing a readout must not have removed a switch.
    await expect(card.locator('[data-testid="control-send1Pre"]')).toHaveCount(1);
    await expect(card.locator('[data-testid="control-send2Pre"]')).toHaveCount(1);

    // ── OWNER ITEM 3: the levels are the NEON control, and it prints a value
    //    at rest the way the dials beside it do.
    await expect(
      card.locator('[data-cell-control="neon-fader"][data-cell-key="ch1_volume"]'),
      'a level renders as the neon throw, not the shipped grey one',
    ).toHaveCount(1);
    await expect(card.locator('[data-testid="readout-ch1_volume"]')).toBeVisible();

    // ── OWNER ITEM 4: no band is WIDER than the face — i.e. nothing is being
    //    stretched to a width nothing needs. That is the whole negative-space
    //    defect, stated as an invariant rather than as a pixel count that would
    //    go stale the next time a control is added.
    const stretch = await card.evaluate((host: Element) => {
      const shell = host.querySelector('.module-shell')!;
      const sw = shell.getBoundingClientRect().width;
      return [...host.querySelectorAll('[data-console-cols]')].map((b) => ({
        id: b.getAttribute('data-face-page'),
        // A console band is content-sized, so it must be STRICTLY narrower than
        // the face that contains it (which also holds the hero and the rail).
        slackPx: +(sw - b.getBoundingClientRect().width).toFixed(1),
      }));
    });
    expect(stretch.length).toBeGreaterThan(0);
    expect(
      stretch.filter((b) => b.slackPx < 0),
      'a console band wider than the face it sits in means it is stretching, not content-sized',
    ).toEqual([]);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  // ── #1767 — THE DRAWER HEIGHT CONTROL ───────────────────────────────────
  test('#1767: ONE control in the drawer top-right sizes the WHOLE drawer, and it persists', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-mixmstrs');
    await openTray(page);

    const drawer = page.getByTestId('dock-zone-bottom');
    const height = page.getByTestId('dock-height');
    await expect(height, 'exactly ONE height control, as asked').toHaveCount(1);

    // TOP-RIGHT of the DRAWER — not of a card. Asserted as geometry so a move
    // into a card header (which is what "beside the zoom trio" would have
    // meant) is red.
    const dBox = (await drawer.boundingBox())!;
    const hBox = (await height.boundingBox())!;
    expect(hBox.x + hBox.width, 'hugs the drawer right edge').toBeGreaterThan(dBox.x + dBox.width - 80);
    expect(hBox.y, 'sits in the drawer top').toBeLessThan(dBox.y + 60);

    // IT CYCLES, AND EVERY STEP IS A REAL, DIFFERENT HEIGHT. Walking the whole
    // ladder proves ONE control reaches every size — the thing that makes a
    // single control acceptable instead of a trap.
    const seen: { step: string; h: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const step = (await height.getAttribute('data-height-step'))!;
      const h = (await drawer.boundingBox())!.height;
      seen.push({ step, h });
      await height.click();
      await expect
        .poll(async () => await height.getAttribute('data-height-step'))
        .not.toBe(step);
    }
    const steps = [...new Set(seen.map((s) => s.step))];
    expect(steps.length, 'the cycle must visit more than one step').toBeGreaterThan(1);
    // The label describes the drawer: two different steps must be two different
    // heights, or the control is decoration.
    const byStep = new Map(seen.map((s) => [s.step, s.h]));
    expect(new Set(byStep.values()).size, 'each step is a distinct drawer height').toBe(byStep.size);
    // …and it WRAPPED: the walk returned to a step it had already visited.
    expect(seen.length).toBeGreaterThan(steps.length);

    // FUNCTIONAL PARITY AT EVERY SIZE. At the SMALLEST step the drawer must
    // still be usable: the card header (and this control) visible, and the
    // content scrollable rather than truncated.
    while ((await height.getAttribute('data-height-step')) !== 'S') await height.click();
    const smallH = (await drawer.boundingBox())!.height;
    expect(smallH, 'the smallest step must not collapse the drawer').toBeGreaterThan(80);
    await expect(height, 'the control is still reachable at the smallest size').toBeVisible();
    await expect(page.getByTestId('dock-close'), 'so is the close button').toBeVisible();
    const scrollable = await page
      .locator('[data-testid="dock-zone-bottom"] .dock-rail-cards')
      .evaluate((el: Element) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible');
    expect(scrollable, 'the rest of the module must be reachable by SCROLL, not lost').toBe(true);

    // PERSISTS across a reload — a size you re-set every load is worse than no
    // control. (LOCAL, per rackspace: it rides the same `railSize` the grabber
    // writes, never the Y.Doc, so a rack-mate's drawer is untouched.)
    await page.reload();
    await expect(page.getByTestId('workflow-topbar')).toBeVisible();
    await waitForPin(page, 'pinned-mixmstrs');
    await page.keyboard.press('m');
    await expect(page.getByTestId('dock-zone-bottom')).toBeVisible();
    await expect
      .poll(async () => await page.getByTestId('dock-height').getAttribute('data-height-step'))
      .toBe('S');

    // ZOOM STILL WORKS AND COMPOSES: height sizes the window, zoom sizes the
    // content inside it. Neither may have eaten the other.
    const card = page.locator('[data-dock-card="pinned-mixmstrs"]');
    const before = Number(await card.getAttribute('data-dock-scale'));
    await card.getByTestId('dock-zoom-in').click();
    await expect.poll(async () => Number(await card.getAttribute('data-dock-scale'))).toBeGreaterThan(before);
    await expect(page.getByTestId('dock-height')).toHaveAttribute('data-height-step', 'S');

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
