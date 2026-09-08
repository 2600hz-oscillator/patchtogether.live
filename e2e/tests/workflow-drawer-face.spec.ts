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
// "the pinned occupant renders IN FULL". ALL THREE were written against the
// PRE-INVERSION renderer, and the tray's own rule read the same flag, so all
// three exercised the OLD arm forever. They pass unchanged — and they would have
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
//   ⚠ * A USER-DOCKED promoted module WAS ON THIS LIST, phrased as
//     "deliberately still renders its pre-promotion surface (the tray rule
//     requires `pinned`)" — and that entry is the 2026-09-03 owner P0, written
//     down a fortnight before it was reported. A SCOPE NOTE IN A BLIND-SPOT
//     LIST IS STILL A BLIND SPOT: nothing in the repo could go red on it, so
//     when the owner docked a promoted CAMERA and got the pre-promotion card
//     back, every gate was green. Covered now — see the `a USER-DOCKED promoted
//     module renders its FACE in the rail` describe at the end of this file.
//   * The three affordances the promoted FACE has never carried on any surface
//     — the SECTIONED drill-down menu, in-card rename, and the card's compact
//     toggle. Measured and filed as #1762, not silently absorbed: this spec
//     asserts the menu OPENS and is frame-anchored, and deliberately does not
//     assert its grouping, because the grouping genuinely changed.

// ── ATTEST: THIS FILE COSTS NOTHING, AND THAT WAS MEASURED, NOT ASSUMED ────
//
// "adding an e2e spec moves the collab hash" was the folk rule, it was wrong,
// and as of 2026-08-17 there is no collab hash at all — `collab-attest` was
// deleted with the rest of the non-gating CI lanes. The measurement is kept
// because the SHAPE recurs: that attest put only FOUR named files from
// `e2e/tests/` in its basis wholesale (`_collab-helpers.ts`, `_helpers.ts`,
// `_drivers.ts`, `_registry.ts`) and every other spec entered by TAG, so most
// specs were never in it. Verified rather than reasoned, at the time, with
// `task collab:attest:check` + `task webgl:attest:check`. Only the WebGL attest
// remains; `task webgl:attest:check` still answers the question for it.
//
// ⚠ AND THE TAG TEST IS A GREP OVER THE WHOLE FILE, COMMENTS INCLUDED. An
// earlier draft of this very comment spelled the tag in its at-sign form to
// explain the rule, which enrolled the spec in the basis and moved the hash
// from bb867526… to a4dd1f78… — a prose edit buying a re-attest. Name the tags
// in prose only in the bare form, as here (collab / capacity).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// Per-test budget scaled on CI (#1904). Two tests here recovered `timedOut ->
// passed` flakes on the same SHA across the 31-run window to 2026-08-19,
// against the flat 30 s default — and they timed out on DIFFERENT subjects
// (`dock-height`, and a `boundingBox` on a `dock-zone-bottom` the log shows
// had ALREADY "resolved to visible"). A wait that times out on an element it
// has already found is not waiting for that element; the test ran out of
// budget. A bound, not an assertion: see ../_helpers/boot-budget.ts.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

/** Collect page errors + console errors for the zero-pageerror asserts. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** The shipping shell. That is the whole point of the file. */
async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
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
  // Focus ritual only — but (500,380) stopped being empty pane when the
  // reserved output slots repacked the purple zone: it became SYNESTHESIA's
  // patch-trigger, and the click silently opened a PatchPanel that then sat
  // over the drawer's own controls (#1767 timed out on exactly that). (500,560)
  // is BELOW the video-zone tile row in both worlds.
  await page.locator('.svelte-flow__pane:visible').first().click({ position: { x: 500, y: 560 } });
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
    // ⚠ A `.mod-card, .moog-panel` ABSENCE LEG RAN HERE AND IS DELETED. It was
    // scoped to THIS tray, and nothing a mixmstrs drawer face can render
    // carries either class, so `toHaveCount(0)` could not fail. (`.mod-card`
    // is not a dead name tree-wide — `CvBuddyBody.svelte` still uses it as its
    // root class — but no cvBuddy is in this tray, and a leg that can only
    // pass is not an assertion.) The four attribute assertions above are the
    // ones with content: they say WHICH surface this is, not which it is not.
    // The face's own furniture, by its own testids — not "something painted".
    await expect(card.getByTestId('face-pages')).toBeVisible();
    await expect(card.getByTestId('face-hero')).toBeVisible();
    // ⚠ NO `face-hero-readouts` — the strip was asserted VISIBLE here until the
    // owner removed it (2026-08-17, see OWNER ITEM 1 below). The hero itself is
    // still the right furniture check: it carries the promoted MASTER throw,
    // which is what "the tray mounts the FACE" is about. Replaced rather than
    // deleted, so this stays a two-sided check on the hero rather than
    // quietly dropping to one assertion.
    await expect(
      card.getByTestId('face-hero').locator('[data-testid="control-master_volume"]'),
      'the hero still promotes the master throw — the strip went, the control did not',
    ).toHaveCount(1);

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
    //    face offers the lane rail's, in place of the two CORNER triggers that
    //    preceded it. Both open the SAME portaled patch menu, and it must be
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

    // ── THE OWNER'S NEON FADERS SURVIVE THE HOST CHANGE — asserted as the
    //    resolved CHAIN (`--domain`, i.e. the module's own spine colour), never
    //    a literal hex.
    //
    // ⚠ THIS READ `--fader-thumb-bg` UNTIL #1794, AND THAT WAS ALREADY THE
    // WRONG TOKEN. That property was set by `console.css` and consumed only by
    // the old `Fader.svelte`; this cell has rendered `NeonFader` since #1738,
    // which reads none of it. The assertion passed purely because custom
    // properties INHERIT — it was reading a token that reached the element and
    // painted nothing on it, i.e. a green assertion about a dead variable.
    // `--_ka` is the chain `NeonFader` actually resolves, so this now measures
    // the control under test.
    const fader = card.locator('[data-testid="control-ch1_volume"]');
    await expect(fader).toBeVisible();
    const neon = await fader.evaluate((el: Element) => {
      const cs = getComputedStyle(el);
      return {
        accent: cs.getPropertyValue('--_ka').trim(),
        domain: cs.getPropertyValue('--domain').trim(),
      };
    });
    expect(neon.domain, 'the shell must publish a domain colour in the tray').not.toBe('');
    expect(neon.accent, "the fader's own accent chain must resolve, not fall back to empty").not.toBe('');
    expect(neon.accent, 'the accent must be a RESOLVED colour, not a grey default').toMatch(
      /^#[0-9a-f]{3,8}$|^rgb/i,
    );

    // ⚠ THIS CELL NO LONGER ENDS AT `--domain`, AND THAT IS THE POINT (#1825).
    // `ch1_volume` is CHANNEL-scoped, and the owner's rule for mixmstrs is that
    // channel N wears rack LANE N's colour: `face.channelAccent` puts lane 1's
    // hex on the cell's `--ka`, which is the documented head of the same chain.
    // This clause used to read `accent === domain` — it was the strongest
    // available statement of "the chain resolves" when every cell ended at the
    // domain, and it is now FALSE for exactly the cells the feature is about.
    //
    // Restated as the two-sided property, which is strictly stronger AND makes
    // the tray a second witness for #1825 (the mixmstrs-face-console spec drives
    // the DOCK FULL VIEW; nothing else measures the pinned `m` tray):
    //   a CHANNEL cell resolves its lane colour, NOT the domain…
    expect(
      neon.accent,
      'ch1_volume is channel-scoped: it must take lane 1s colour, not the domain accent (#1825)',
    ).not.toBe(neon.domain);
    //   …and a BUS-scoped cell in the SAME tray still ends at the domain, which
    //   is what keeps this an assertion about the CHAIN rather than about one
    //   colour. Without it, a bug that painted the whole tray any single
    //   non-domain colour would pass the clause above.
    const busAccent = await card
      .locator('[data-testid="control-ret1_volume"]')
      .evaluate((el: Element) => getComputedStyle(el).getPropertyValue('--_ka').trim());
    expect(
      busAccent,
      'ret1_volume is BUS-scoped (the wet back from send 1, not channel 1) and must keep the domain accent',
    ).toBe(neon.domain);

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

    // ── OWNER ITEM 1: the header readouts are gone ENTIRELY …
    //
    // ⚠ THIS ASSERTION HAS BEEN NARROWED TWICE BY THE SAME OWNER, and the
    // history is the point. #1738 removed the two `send N` echoes and this line
    // then pinned the survivors to `['bus', 'asleep']` — "the header keeps only
    // what is NOT visible elsewhere on the face", which was a real argument:
    // BUS was the summed headroom (TWO correlated hot channels clip at the
    // shipped defaults) and ASLEEP counted the bit-exactly inert faders.
    // 2026-08-17: *"[MASTER 1.00 / BUS ≤ 8.60× · +18.7 dB / ASLEEP 16 asleep]
    // these numbers and text should go away"*, and generally *"we don't want
    // text like that in our faceplates"*. The strip is not narrowed again, it
    // is removed — so this asserts the ELEMENT is absent rather than pinning a
    // shorter list that a future readout could quietly rejoin.
    await expect(
      card.getByTestId('face-hero-readouts'),
      'the hero readout strip is REMOVED — a narrowed list would let the next summary value ' +
        'back in without anyone deciding',
    ).toHaveCount(0);
    // … and the CONTROLS they echoed are still on the face, still reachable.
    // Removing a readout must not have removed a switch.
    await expect(card.locator('[data-testid="control-send1Pre"]')).toHaveCount(1);
    await expect(card.locator('[data-testid="control-send2Pre"]')).toHaveCount(1);

    // ── OWNER ITEM 3: the levels are the NEON control.
    await expect(
      card.locator('[data-cell-control="fader"][data-cell-key="ch1_volume"]'),
      'a level renders as the neon throw, not the shipped grey one',
    ).toHaveCount(1);
    // ⚠ THE SECOND HALF OF THIS ITEM WAS REVERSED BY A LATER REVIEW, and it is
    // recorded rather than quietly dropped. It read `readout-ch1_volume` must
    // be VISIBLE — "it prints a value at rest the way the dials beside it do",
    // which was the right parity argument while the dials printed. Owner,
    // 2026-08-17: *"all of our white decimely representatons of fader state ...
    // should be removed"* and *"i want the data gone, not there but hidden or
    // something"*. Parity is now restored by neither printing, and the value
    // moved to `aria-valuetext` — so this asserts BOTH halves: gone from the
    // page, still readable by anything that reads a slider.
    await expect(
      card.locator('[data-testid="readout-ch1_volume"]'),
      'the resting decimal is REMOVED, not hidden — there is no element to reveal',
    ).toHaveCount(0);
    await expect(
      card.locator('[data-testid="control-ch1_volume"]'),
      'and the value is still on the slider, so nothing lost the ability to READ it',
    ).toHaveAttribute('aria-valuetext', /\d/);

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

  // ── #1796 — THE DECLUTTER, AND WHAT IT IS NOT ALLOWED TO COST ───────────
  //
  // Owner review of the mixmstrs faceplate, 2026-08-17:
  //
  //   *"the DB numbers here we should lose entirely, it's cluttered and i don't
  //   like it. the 1lo 1md 1hi etc labels should also go away because the
  //   low/mid/high labels above the knob rows convey that fine."*
  //   *"the "enable" label shoud say "enable compressor" and we do not need a
  //   1cp etc label under it."*
  //   *"return 1 and return 2 can sit next to each other, too, saving on
  //   vertical space and reducing unused horizontal space"*
  //
  // ⚠ EVERY ASSERTION BELOW IS PAIRED WITH ITS PARITY LEG, because "the label
  // is gone" and "the control is gone" look identical in a screenshot and very
  // different to a player. The GESTURE half — drag reaches the graph,
  // right-click reaches MIDI-learn — is asserted in the `a control edit and its
  // MIDI-learn menu` test above, which drives `control-ch1_low`; that param is
  // in `face.bareCells`, so that test is not merely unaffected by this change,
  // it is the proof the change costs nothing.
  test('#1796: the face loses its RESTING NUMBERS and its redundant CAPTIONS, and nothing else', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, 'pinned-mixmstrs');
    const card = await openTray(page);
    await expect(card.locator('[data-testid="module-shell"]')).toBeVisible();

    // ── 1. NOT ONE RESTING NUMBER ON THE WHOLE FACE ─────────────────────
    // Unconditional, not a ceiling: mixmstrs declares no `options` and no
    // `landmarks` on any param, so every cell resolves to "paints nothing" and
    // the correct answer is zero. A ceiling would go stale; this cannot.
    await expect(
      card.locator('[data-testid^="readout-"]'),
      'a resting readout on a face whose params declare no NAME vocabulary — either the ' +
        'decimal is back, or something new started painting one',
    ).toHaveCount(0);

    // ── 2. THE CAPTIONS THAT WENT, AND THE ONES THAT DID NOT ────────────
    //
    // Swept over the RENDERED cells rather than a list here, so a ninth channel
    // or a new per-channel control is covered without editing this test.
    // `face.bareCells` is "every declared param except the ones no heading
    // names", and there are exactly two kinds of exception.
    const captions = await card.evaluate((host: Element) => {
      const out: { key: string; captioned: boolean; named: boolean }[] = [];
      for (const cell of Array.from(host.querySelectorAll('[data-cell-key]'))) {
        const key = cell.getAttribute('data-cell-key') ?? '?';
        // The painted caption, in either primitive's vocabulary.
        const captioned = !!cell.querySelector('.label, .sw-lab');
        // The ACCESSIBLE name, which must survive either way.
        const slider = cell.querySelector('[data-testid^="control-"]');
        const named = !!(slider?.getAttribute('aria-label') ?? '').trim();
        out.push({ key, captioned, named });
      }
      return out;
    });
    expect(captions.length, 'the sweep must have found cells to classify').toBeGreaterThan(0);

    // ⚠ MASTER IS NOT ON THIS LIST, and it was until the same review round.
    // It heads the hero with no cluster heading above it, which is a good
    // reason to keep a caption and is why it survived the first pass — the
    // owner then named it explicitly (*"[MASTER 1.00 ...] these numbers and
    // text should go away"*). What is left is S1PRE/S2PRE, at the tail of a
    // cluster whose heading names the send AMOUNT row rather than the tap
    // point, and whose header echo was already removed in #1738.
    const KEEP_CAPTION = new Set(['send1Pre', 'send2Pre']);
    expect(
      captions
        .filter((c) => c.captioned && !KEEP_CAPTION.has(c.key))
        .map((c) => c.key)
        .sort(),
      'a per-control caption survived under a section heading that already says it — the ' +
        '`1LO`/`1CM`/`1TH`/`1S1` class the owner removed',
    ).toEqual([]);
    expect(
      captions
        .filter((c) => KEEP_CAPTION.has(c.key) && !c.captioned)
        .map((c) => c.key)
        .sort(),
      'a caption that is the ONLY thing naming its control went with the redundant ones',
    ).toEqual([]);

    // ⚠ THE PARITY LEG. Hiding TEXT must never hide the NAME — `aria-label`,
    // the annotate menu's title and MIDI-learn's address all read it. A
    // `label={undefined}` "fix" would pass the clause above and fail this one,
    // which is exactly why the primitives take a separate `hideCaption` prop.
    expect(
      captions
        .filter((c) => !c.named)
        .map((c) => c.key)
        .sort(),
      'a cell lost its accessible name along with its caption',
    ).toEqual([]);

    // ── 3. THE ENABLE HEADING SAYS WHAT IT ENABLES ──────────────────────
    // With `1CP…8CP` gone this heading is the only text naming the row.
    // Lowercase in the def per the repo convention (`.cluster-label` uppercases
    // it in CSS), so the DOM attribute carries the authored case.
    await expect(
      card.locator('[data-face-cluster="enable compressor"]'),
      'the compressor ENABLE row must say what it enables',
    ).toHaveCount(1);

    // ── 4. RETURN 1 AND RETURN 2 SIT SIDE BY SIDE ───────────────────────
    // Geometry, because "next to each other" is a geometry claim and a
    // baseline cannot express it — a screenshot goes green on any drift it
    // happens to capture. Units: CSS px; the drawer is a sibling of xyflow's
    // zoom transform, not inside it, so no zoom division is involved.
    const returns = await card.evaluate((host: Element) => {
      const box = (sel: string) => {
        const el = host.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      return {
        one: box('[data-face-cluster="return 1"]'),
        two: box('[data-face-cluster="return 2"]'),
      };
    });
    expect(returns.one, 'return 1 must be on the face').toBeTruthy();
    expect(returns.two, 'return 2 must be on the face').toBeTruthy();
    const one = returns.one!;
    const two = returns.two!;
    expect(
      Math.round(two.y - one.y),
      `the two return strips must share a row (return 1 at y=${one.y.toFixed(1)}, return 2 at ` +
        `y=${two.y.toFixed(1)} CSS px). Stacked, return 2 sat a whole strip lower and the ` +
        `space to the right of both was blank — which is the thing the owner asked to reclaim.`,
    ).toBe(0);
    expect(
      two.x,
      `return 2 must start to the RIGHT of return 1 (return 1 ends at ` +
        `${(one.x + one.w).toFixed(1)}, return 2 starts at ${two.x.toFixed(1)} CSS px)`,
    ).toBeGreaterThanOrEqual(one.x + one.w);

    // …and the row they now share must FIT, or side-by-side bought nothing.
    // `.dock-page.cluster-row` wraps by design, so a pane too narrow degrades
    // to the stacked layout rather than overflowing — which surfaces as the
    // y-delta above being non-zero, not as a clip. This is the other half.
    const overflow = await card.evaluate((host: Element) => {
      const band = host.querySelector('[data-face-page="returns"]') as HTMLElement | null;
      if (!band) return null;
      return { hiddenX: Math.max(0, band.scrollWidth - band.clientWidth) };
    });
    expect(overflow, 'the returns band must be on the face').toBeTruthy();
    expect(
      overflow!.hiddenX,
      'the side-by-side returns band overflows its own box — a control is clipped',
    ).toBe(0);

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
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
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
    // Proves this test is looking at the DRAWER face specifically — without it
    // the assertions below would be green on any shell view.
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

// ── THE `e` TRAY — ELECTRA CONTROL ─────────────────────────────────────────
//
// The SECOND drawer pin to be promoted, and the one where the tray is not
// merely the surface the owner asked about but the ONLY surface the module has.
// `electraControl` is `surface: 'drawer'` and canvas-hidden, so before this
// promotion its entire 6×6 board — thirty-six proxies, the rename, the flash —
// was reachable only by opening the `e` drawer onto a bespoke surface.
// Promotion swaps that for `<ModuleShell view='drawer'>`, so if the extension
// body did not paint here the module would simply be GONE for every workflow
// user.
//
// ⚠ THIS IS THE ONLY PLACE THAT IS ASSERTED, which is why the block exists.
// `electra-control.spec.ts` drove the same testids against the PRE-PROMOTION
// surface — an arm promotion could not reach — and the face's two VRT scenes
// photograph a canvas instance's
// EMPTY board, so they cannot see a proxy, a colour, a name or the flash button
// at all. Without this, the promotion's actual subject has no coverage on its
// actual surface: exactly the gap this file's own header describes for mixmstrs.
test.describe('workflow · the pinned `e` tray renders the ELECTRA board', () => {
  const EC = 'pinned-electraControl';

  /** Open the pinned ELECTRA drawer via the E keymap; return the card host. */
  async function openElectraTray(page: Page) {
    // (500,560): see openTray — the old (500,380) lands on slot-repacked
    // zone chrome and opens a PatchPanel as a side effect.
    await page.locator('.svelte-flow__pane:visible').first().click({ position: { x: 500, y: 560 } });
    await page.keyboard.press('e');
    const drawer = page.getByTestId('dock-zone-bottom');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-dock-type', 'electraControl');
    const card = drawer.locator(`[data-dock-card="${EC}"]`);
    await expect(card).toBeVisible();
    return card;
  }

  test('the tray mounts the FACE and its BOARD', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, EC);
    const card = await openElectraTray(page);

    // The promoted shell, at the drawer view — the `true` arm of
    // `dockRailRendersFace`, which the three legacy-shell drawer specs can never
    // reach.
    await expect(card.locator('[data-testid="module-shell"]')).toHaveAttribute('data-shell-view', 'drawer');
    // …and the verbatim card is NOT mounted anywhere on the page.
    await expect(page.locator('[data-testid="electra-control-card"]')).toHaveCount(0);

    // THE BOARD. All three banks, and every one of its places.
    const grid = card.locator('[data-testid="electra-control-grid"]');
    await expect(grid).toBeVisible();
    for (const bank of ['TOP', 'MID', 'BOT']) {
      await expect(grid.locator(`[data-testid="electra-control-bank-${bank}"]`)).toBeVisible();
    }
    // The cell count is the PRODUCT of the structure actually on screen (banks ×
    // 2 rows × 6 knobs), not a typed 36 — so a geometry change moves both sides
    // of the assertion together instead of leaving a stale literal behind.
    const bankCount = await grid.locator('[data-testid^="electra-control-bank-"]').count();
    await expect(grid.locator('[data-testid^="electra-control-slot-"]')).toHaveCount(bankCount * 2 * 6);

    // A fresh rack's board is EMPTY, and every empty place is SPEAKABLE — the
    // one behaviour the port deliberately changed (the card marked all
    // thirty-six `aria-hidden`, so a board whose whole premise is that an empty
    // slot is a visible PLACE had thirty-six unspeakable ones). Row 3 is an ODD
    // row, so it is the TOP sub-row of control set 2 and its pots are 1-6 — the
    // firmware walk the module's own header warns not to derive naively.
    await expect(grid.locator('[data-testid^="electra-control-slot-"][data-filled="true"]')).toHaveCount(0);
    await expect(grid.getByLabel('Row 3 knob 4, control set 2 pot 4 — empty')).toBeVisible();
    // The container names the shape and its DERIVED assigned count.
    await expect(grid).toHaveAttribute('aria-label', 'Electra One board — 6 rows of 6, 0 assigned');

    // THE RANKED CELL — the one gesture that leaves the browser. It is a face
    // cell now, not markup inside the body, so its testid is the SHELL's
    // (`shell-cell-<familyId>`) rather than the button's own
    // (`electra-connect-button`, which `ElectraConnectButton.svelte` still
    // emits). Both spellings exist on purpose and neither matches the other,
    // which is what keeps the two assertions honest.
    await expect(card.getByTestId('shell-cell-electra-connect-button')).toBeVisible();
    await expect(card.getByTestId('shell-cell-electra-connect-button')).toBeEnabled();
    await expect(
      card.getByTestId('electra-connect-button'),
      'the legacy button belongs to the card, which is not mounted here',
    ).toHaveCount(0);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the full assign → rename → proxy-writes-source lifecycle works FROM THE TRAY', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);
    await waitForPin(page, EC);
    await spawnPatch(page, [{ id: 'adsr-1', type: 'adsr', position: { x: 60, y: 60 } }]);
    await waitForPin(page, EC);
    const card = await openElectraTray(page);
    const grid = card.locator('[data-testid="electra-control-grid"]');

    // ASSIGN — the real three-level cascade on the SOURCE control, which is the
    // ONLY way a slot is ever filled (the board itself has no assign affordance;
    // that gap is recorded in the promotion note, not closed here).
    // ⚠ THE SOURCE CONTROL IS ADDRESSED BY ITS SHELL TESTID, NOT BY AN ARIA
    // LABEL. This file drives the DEFAULT shell, so `adsr` is itself a promoted
    // face: its lane tile is a `ModuleShell` emitting `control-<paramId>`, not
    // the pre-promotion surface whose knob carried `aria-label="Attack"`. That
    // is the difference between this block and `electra-control.spec.ts`.
    const attack = page
      .locator('.svelte-flow__node[data-id="adsr-1"]')
      .getByTestId('control-attack');
    await expect(attack).toBeVisible();
    await attack.click({ button: 'right' });
    const menu = page.locator('[data-testid="control-context-menu"]');
    await expect(menu).toBeVisible();
    await menu.locator(`[data-testid="ctx-electra-${EC}"]`).click();
    await menu.locator(`[data-testid="ctx-electra-${EC}-row-2"]`).click();
    await menu.locator(`[data-testid="ctx-electra-${EC}-row-2-knob-2"]`).click();

    // slotIndex(2,2) = 7. The BODY paints the proxy — this is the assertion that
    // would have failed if `fullViewBody` did not reach `view='drawer'`.
    const slot22 = grid.locator('[data-testid="electra-control-slot-2-2"]');
    await expect(slot22).toHaveAttribute('data-filled', 'true');
    await expect(slot22.locator('[role="slider"]')).toBeVisible();
    // The live source-colour stripe is a passthrough read of the SOURCE module.
    await expect(slot22.locator('[data-testid="electra-control-stripe-2-2"]')).toBeVisible();
    // The derived count in the accessible name moved with it.
    await expect(grid).toHaveAttribute('aria-label', 'Electra One board — 6 rows of 6, 1 assigned');

    // RENAME — the affordance most at risk in this promotion, because thirty-six
    // per-slot typed fields are NOT addressable as face cells at any rank
    // (#1509: a family template renders ONE cell however many members it names).
    // It survives as body markup, exactly as on the card.
    await slot22.locator('[data-testid="electra-control-rename-2-2"]').click();
    const renameInput = slot22.locator('[data-testid="electra-control-rename-input-2-2"]');
    await expect(renameInput).toBeVisible();
    await renameInput.fill('Punch');
    await renameInput.press('Enter');
    await expect
      .poll(async () =>
        page.evaluate((id) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { data?: { slots?: Record<string, unknown> } } | undefined> };
          };
          return w.__patch.nodes[id]?.data?.slots ?? null;
        }, EC),
      )
      .toEqual({ '7': { moduleId: 'adsr-1', paramId: 'attack', name: 'Punch' } });
    await expect(slot22).toContainText('Punch');

    // ⚠ A SECOND ASSIGN TO A DIFFERENT SLOT MUST NOT THROW. This is the shipped
    // Yjs crash ("Type already integrated") that already broke send-to-surface
    // once: the mutators write the slot map IN PLACE inside one transact, and a
    // body that rebuilt it would die here. The zero-pageerror assert at the end
    // is what makes this leg real rather than decorative.
    const decay = page
      .locator('.svelte-flow__node[data-id="adsr-1"]')
      .getByTestId('control-decay');
    await expect(decay).toBeVisible();
    await decay.click({ button: 'right' });
    await expect(page.locator('[data-testid="control-context-menu"]')).toBeVisible();
    await page.locator(`[data-testid="ctx-electra-${EC}"]`).click();
    await page.locator(`[data-testid="ctx-electra-${EC}-row-6"]`).click();
    await page.locator(`[data-testid="ctx-electra-${EC}-row-6-knob-6"]`).click();
    await expect(grid.locator('[data-testid="electra-control-slot-6-6"]')).toHaveAttribute('data-filled', 'true');

    // PROXY PROOF — the proxied knob writes the SOURCE node's param, which is
    // the entire mechanism the module exists for.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      w.__patch.nodes['adsr-1']!.params.attack = 0.9;
    });
    await slot22.locator('[role="slider"]').dblclick();
    await expect.poll(() => readParam(page, 'adsr-1', 'attack')).not.toBe(0.9);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE USER-DOCKED RAIL OCCUPANT — the 2026-09-03 owner P0's second half.
//
// This file's own header listed "A USER-DOCKED promoted module, which
// deliberately still renders its PRE-FACE surface" as a thing it structurally
// could not see, and named `dockRailRendersFace requires pinned` as the reason.
// That was true, it was written as a scope note rather than a gap, and it is
// exactly what shipped: the owner docked a CAMERA and got the old chrome back —
// a bespoke device dropdown, "streaming" lamp, Pause / Mirror / Fit:Fill, GAIN
// slider — on the default shell, and said so.
//
// ⚠ A DOCUMENTED BLIND SPOT IS STILL A BLIND SPOT. Nothing in the repo could
// fail on this: `workflow-dock.spec.ts` docked `mixer` and asserted on the
// PRE-PROMOTION root, so it asserted the old arm and would have passed just as
// well with the shipping shell completely broken. This case
// is the same gesture on the DEFAULT shell, which is the only place the bug
// lives.
//
// ⚠ THE SUBJECT IS `mixer`, NOT `cameraInput`, AND THAT IS ITSELF A FINDING.
// `cameraInput` is not in `DOCKABLE_TYPES`, so the camera the owner reported can
// never take a rail slot at all — its "top camera area" is the topbar's 📷
// CAMERA MANAGER (`CameraSurface.svelte`), a host that is not a `DockCardHost`
// and mounts the verbatim card by design, because for a `hiddenCard` camera it
// is the module's ONLY mount and therefore the sole owner of getUserMedia. That
// surface is recorded in `legacy-fallback.ts` and is NOT fixed here. What IS
// fixed here is the same class on the rail, which `mixer` exercises: the old
// rule's own note named it ("`workflow-dock.spec.ts` docks `mixer`") as the
// thing widening would move, and it did not — that spec asserted the arm
// promotion never touched.
test.describe('workflow · a USER-DOCKED promoted module renders its FACE in the rail', () => {
  test('docking a migrated module mounts ModuleShell in the rail', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoWorkflow(page);

    await spawnPatch(page, [{ id: 'dock-mix', type: 'mixer', position: { x: 300, y: 200 } }]);

    // PRECONDITION, ASSERTED RATHER THAN ASSUMED: the lane already paints the
    // face. Without this the test could pass on a demoted module by rendering
    // nothing anywhere.
    const laneShell = page.locator('.svelte-flow__node[data-id="dock-mix"] [data-testid="module-shell"]');
    await expect(laneShell, 'the lane paints the promoted face before we dock it').toBeVisible({
      timeout: BOOT_MS,
    });

    // The real dock action, through the same function the node context menu
    // calls (`__dock.dock` → `Canvas.dockNode`).
    await page.evaluate(() => {
      (globalThis as unknown as { __dock: { dock: (id: string, zone: string) => void } }).__dock.dock(
        'dock-mix',
        'top',
      );
    });

    const railCard = page.locator('[data-dock-card="dock-mix"]');
    await expect(railCard, 'the docked node takes a rail slot').toBeVisible({ timeout: BOOT_MS });

    // ── THE ASSERTION THE DEFECT FAILS ───────────────────────────────────
    const railShell = railCard.locator('[data-testid="module-shell"]');
    await expect(railShell, 'the rail occupant mounts the FACE').toBeVisible();
    await expect(railShell).toHaveAttribute('data-shell-type', 'mixer');
    // `view='drawer'`, not `'lane'` — a shell that fell back to the lane view
    // would still be "a module-shell" while painting a fraction of the face.
    await expect(railShell).toHaveAttribute('data-shell-view', 'drawer');
    // ⚠ THE SAME `.mod-card, .moog-panel` ABSENCE LEG RAN HERE AND IS DELETED
    // for the same reason: nothing the docked mixmstrs can render carries
    // either class. The `data-shell-view` assertion above is what says the
    // rail mounts the DRAWER face rather than something else.

    // The canvas side is unchanged: docking still swaps the lane to the STUB,
    // so this is not "the face leaked onto both surfaces".
    await expect(page.locator('[data-testid="dock-stub"][data-stub-node="dock-mix"]')).toBeVisible();

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  /* ⚠ A LEG STOOD HERE ASSERTING THAT THE SECOND RENDERER DOCKED TO THE
   * PRE-PROMOTION SURFACE, and it is retired because THIS BRANCH IS THE CHANGE
   * IT WAS WATCHING FOR. Its own words: *"the reason the rule keeps its
   * [renderer] term. Without this leg the fix above would be indistinguishable
   * from deleting the old arm outright, which is a different (owner-gated)
   * change."* That gated
   * change is exactly what happened — the escape hatch, the cards and
   * `dockRailRendersFace`'s three terms are all gone — so the leg is deleted
   * with its subject rather than re-pointed at a surface it was written to
   * contrast against.
   *
   * COVERAGE, NAMED: the POSITIVE half it paired with is the test directly
   * above (a user-docked promoted module renders its FACE in the rail), which
   * is unchanged and still runs. What that pair proved between them — that the
   * rail's choice was a CHOICE — is no longer a property the product has: the
   * rail renders the faceplate because it is the only surface a module has. */
});
