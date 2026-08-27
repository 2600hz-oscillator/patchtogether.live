// e2e/tests/score-face.spec.ts
//
// SCORE's FACEPLATE, on the DEFAULT shell.
//
// ⚠ WHY THIS FILE EXISTS ALONGSIDE `score.spec.ts`, WHICH DID NOT NEED TO
// CHANGE. `score.spec.ts` reaches the rack through the shared `rack` fixture,
// which navigates `/rack?shell=legacy&seed=none`. `laneRenderKind` returns
// `'legacy'` whenever `shellFaces` is false, so EVERY one of its tests renders
// the verbatim `ScoreCard.svelte` — promoted or not. It therefore
// stays GREEN through this promotion, which is the good outcome and the
// dangerous one at once: green on a surface no default user reaches any more.
// It is the module's LEGACY-CARD regression suite now, and it is still worth
// having (the card is a live escape hatch, and `midi-learn-note.spec.ts` binds
// its pad there). What it cannot see is everything below.
//
// ⚠ THREE OF THESE LEGS FAIL ON `main`, BY CONSTRUCTION. That is the difference
// between a face spec and a screenshot:
//
//   * DELETING A NOTE.  `deleteNote` had exactly one call site in the repo — a
//     Backspace/Delete keystroke on the FOCUSED note — and focusing one is close
//     to unreachable in ordinary use (Tab is consumed bare by the rack flip, and
//     the staff's own `pointerdown` calls `preventDefault()` before capturing
//     the pointer, which suppresses the compatibility mouse events Chromium sets
//     focus from). No e2e anywhere exercised note deletion.
//   * REMOVING A TIE.  `addTie` was the ONLY writer of `data.ties`; the only
//     deletion was collateral inside `deleteNote`, which per the above was
//     itself unreachable. A tie, once made, could not be removed.
//   * SHRINKING THE PIECE.  `addPage` only ever incremented and nothing
//     decremented, so one stray click made the piece sixteen bars longer with no
//     way back.
//
// ⚠ EVERY ASSERTION READS `node.data` OR AN ACCESSIBLE NAME, NEVER PAINTED
// TEXT. That is what let the resting readouts be deleted rather than hidden
// without weakening anything: the playhead position, the note count, the bar
// total and the page indicator all live in `aria-label` now, and the graph is
// the oracle for the rest.
//
// ⚠ A `pageerror` GUARD IS INSTALLED ON EVERY TEST. A TypeError inside a
// `$derived` does not fail an assertion — it takes the subtree's render down and
// the symptom lands somewhere else entirely, usually as a confusing timeout on
// an unrelated locator.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
// ⚠ IMPORTED, NEVER RE-TYPED — the same rule `score-data.ts`'s own scheduler-grid
// note states, applied to a test. A hand-typed 48 here would let this spec and
// the engine disagree about what a bar IS, which is precisely how the placement
// grid and the playback grid drifted apart for three months without anything
// going red. The module is pure (zero imports), so it loads in the Playwright
// runtime the same way `band-focus-model` does for the VRT harness.
import { TICKS_PER_BAR } from '../../packages/web/src/lib/audio/modules/score-data';

test.describe.configure({ mode: 'parallel' });

const NODE = 'score';

interface ScoreNoteRow {
  id: string;
  bar: number;
  tick: number;
  duration: string;
  midi: number;
  staffStep: number;
  accidental: string | null;
}

interface ScoreDataRow {
  notes?: ScoreNoteRow[];
  ties?: Array<{ id: string; fromNoteId: string; toNoteId: string }>;
  dynamics?: Array<{ id: string; bar: number; tick: number; level: string }>;
  pages?: number;
  loop?: boolean;
  keySignature?: number;
  stopBar?: { bar: number; tick: number };
  slots?: Record<string, unknown>;
  pendingMode?: string | null;
  selectedNoteId?: string | null;
  noteValue?: string;
  armedAccidental?: string | null;
  armedDynamic?: string | null;
  armedTie?: boolean;
}

/** A CRASH IN THE PAGE MUST FAIL THE TEST THAT CAUSED IT, not the next one. */
function guardPageErrors(page: Page): void {
  page.on('pageerror', (err) => {
    throw new Error(`uncaught page error (a throw inside a $derived takes the subtree down): ${err.message}`);
  });
}

/** The same 15 s FIRST-LOAD budget the other dock specs use for this route:
 *  SvelteKit dev compiles `/rack` on demand and only the first navigation of a
 *  run pays it. It bounds the failure; it is never the gate. */
async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open the node's dock full-view through the shipped hook the EXPAND button
 *  calls — the idiom every other dock spec in this directory uses. */
async function openFace(page: Page, nodeId: string) {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
  );
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
    nodeId,
  );
  const pane = page.locator(`[data-testid="dock-full-view"][data-fullview-node="${nodeId}"]`);
  await expect(pane).toBeVisible();
  return pane;
}

/** The node's whole `data` bag, off the live graph. */
function readData(page: Page, nodeId = NODE): Promise<ScoreDataRow> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: unknown }> } };
    return JSON.parse(JSON.stringify(w.__patch.nodes[id]?.data ?? {})) as Record<string, unknown>;
  }, nodeId);
}

/** Write notes straight into the graph — the seed path `_score-helpers.ts` uses.
 *  Used only where the SUBJECT is a mark cell rather than note placement. */
async function seedNotes(page: Page, notes: ScoreNoteRow[], nodeId = NODE): Promise<void> {
  await page.evaluate(
    ({ id, rows }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      const n = w.__patch.nodes[id];
      if (!n) throw new Error(`seedNotes: no node '${id}'; present: ${Object.keys(w.__patch.nodes).join(',')}`);
      if (!n.data) n.data = {};
      n.data.notes = rows;
    },
    { id: nodeId, rows: notes },
  );
  await expect
    .poll(async () => (await readData(page, nodeId)).notes?.length ?? 0, {
      message: 'the seed reached the live graph (a write that lands nowhere is unfalsifiable)',
    })
    .toBe(notes.length);
}

/**
 * Click the staff at a FRACTION of its own box.
 *
 * ⚠ `locator.click({ position })` RATHER THAN `page.mouse.click(x, y)`, and the
 * difference is not style. Raw mouse coordinates skip Playwright's actionability
 * checks, so a portaled popover still lying over the plate silently eats the
 * press and the test reports the DOWNSTREAM symptom — measured here as "the
 * armed accidental did not apply at placement", which reads exactly like a
 * product bug and is not one. Routing through the locator makes an intercepted
 * click say so.
 */
async function clickStaff(staff: ReturnType<Page['locator']>, fx: number, fy: number) {
  const box = (await staff.boundingBox())!;
  await staff.click({ position: { x: box.width * fx, y: box.height * fy } });
}

function noteRow(over: Partial<ScoreNoteRow> & { id: string }): ScoreNoteRow {
  return { bar: 0, tick: 0, duration: 'quarter', midi: 72, staffStep: 3, accidental: null, ...over };
}

/**
 * Pick a face SELECTOR cell by its family id, and choose an option by label.
 *
 * ⚠ IT WAITS FOR THE ROSTER TO CLOSE, and that is a correctness requirement
 * rather than tidiness. The listbox is PORTALED over the plate, so a click on
 * the staff issued before it detaches lands on the popover instead — which
 * showed up as "the armed accidental did not apply at placement", i.e. a
 * product bug that was not one. Waiting on the observable state (the roster is
 * gone) rather than on a duration keeps it renderer-independent.
 */
async function pickOption(pane: ReturnType<Page['locator']>, family: string, label: string) {
  const chip = pane.locator(`[data-cell-key="${family}-{n}"] [role="button"][aria-haspopup="listbox"]`);
  await expect(chip, `the ${family} cell paints a selector on the FACE`).toBeVisible();
  await chip.click();
  const page = chip.page();
  const option = page.locator('[role="listbox"] [role="option"]', { hasText: label }).first();
  await option.click();
  await expect(
    page.locator('[role="listbox"]'),
    `${family}: the roster closes before anything else is clicked`,
  ).toHaveCount(0);
  await expect(chip.locator('.val'), `${family}: the pick is committed`).toHaveText(label);
}

// ── 1 · IT PAINTS, AND BOTH PANELS ARE ALIVE ────────────────────────────────

test('score face: the DEFAULT shell paints the staff, the bands and BOTH panels', async ({ page }) => {
  guardPageErrors(page);
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: NODE, type: 'score', position: { x: 460, y: 240 } }]);
  const pane = await openFace(page, NODE);

  // ⚠ THE STAFF, ON THE FACE — not the legacy card's `<svg>`. The panel's own
  // testid is node-agnostic (a static registry probe cannot interpolate a node
  // id), so it is located inside the PANE.
  const staff = pane.locator('[data-testid="score-staff-panel"]');
  await expect(staff, 'the staff panel renders as the dock hero').toBeVisible();

  // The QUICKSAVE panel — the second picture, and the one four declared CV
  // inputs depend on existing at all.
  await expect(
    pane.locator('[data-testid="score-slots-mode-save"]'),
    'the quicksave panel renders; without it queue1..4_cv resolve into an empty map forever',
  ).toBeVisible();

  // Every ranked non-param cell paints. ⚠ PRESENCE, not "the face resolves":
  // the joystick shape is a face that ranks controls and renders ZERO of them.
  for (const family of [
    'score-value', 'score-accidental', 'score-dyn', 'score-tie',
    'score-stop', 'score-loop', 'score-key', 'score-pages',
  ]) {
    await expect(
      pane.locator(`[data-cell-key="${family}-{n}"]`),
      `${family} paints a cell on the dock faceplate`,
    ).toBeVisible();
  }

  // ⚠ THE FIVE SECTION BANDS, ASSERTED AS AN EXACT SET RATHER THAN FIVE
  // PRESENCE CHECKS. A face that dropped a band and grew a different one would
  // pass five `toBeVisible`s; this fails on either direction, and it is the same
  // number `_shell-faces.ts` pins as `pages: 5` — the VRT dock scene is nearly
  // blind to the bands (the staff alone fills its capture box), so this is where
  // the band structure is actually gated.
  await expect
    .poll(async () => (await pane.locator('[data-testid="face-page"]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-face-page') ?? '?'),
    )), { message: 'the dock renders exactly the five declared bands, in order' })
    .toEqual(['score', 'marks', 'transport', 'envelope', 'slots']);

  // ⚠ NEGATIVE CONTROL — A FRESH SCORE WRITES NOTHING TO `node.data`. Opening a
  // face that seeded its own defaults would dirty every saved patch on open and
  // push a Y.Doc update to every collaborator for doing nothing.
  const data = await readData(page);
  expect(
    data.noteValue,
    'an absent noteValue reads as "quarter" — the face must not SEED it',
  ).toBeUndefined();
  expect(data.selectedNoteId, 'nor a selection').toBeUndefined();
  expect(data.armedAccidental, 'nor an armed accidental').toBeUndefined();
  expect(data.armedDynamic, 'nor an armed dynamic').toBeUndefined();
  expect(data.armedTie, 'nor an armed tie').toBeUndefined();
  expect(data.notes ?? [], 'nor an empty notes array').toEqual([]);
});

// ── 2 · THE STAFF PLACES, SELECTS, AND DELETES ──────────────────────────────

test('score face: a click writes a note, a second click on it SELECTS, a third DELETES', async ({ page }) => {
  guardPageErrors(page);
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: NODE, type: 'score', position: { x: 460, y: 240 } }]);
  const pane = await openFace(page, NODE);
  const staff = pane.locator('[data-testid="score-staff-panel"]');
  await expect(staff).toBeVisible();

  // ── PLACE. No tool to arm: `data.noteValue` is absent, which reads as the
  // card's own default of `quarter`, so ONE click writes a quarter note.
  await clickStaff(staff, 0.45, 0.3);

  await expect
    .poll(async () => (await readData(page)).notes?.length ?? 0, {
      message: 'clicking empty staff on the FACE writes a note into node.data.notes',
    })
    .toBe(1);
  const placed = (await readData(page)).notes![0];
  expect(placed.duration, 'and it is the value the VALUE cell shows').toBe('quarter');

  // ── SELECT. Clicking the note itself selects it — the card starts a DRAG
  // here and has no selection at all.
  const noteEl = pane.locator(`[data-testid="score-note-${NODE}-${placed.id}"]`);
  await expect(noteEl).toBeVisible();
  await noteEl.click({ force: true });
  await expect
    .poll(async () => (await readData(page)).selectedNoteId ?? null, {
      message: 'clicking a note selects it',
    })
    .toBe(placed.id);
  await expect(noteEl).toHaveAttribute('data-selected', 'true');

  // …and the selection reaches the mark cells, which is the whole point of it
  // living on the node: a cell's `value(node)` receives the node and nothing
  // else, so a component-local selection would leave every one of them inert.
  await expect(
    pane.locator('[data-cell-key="score-accidental-{n}"] [role="button"][aria-haspopup="listbox"]'),
  ).toBeVisible();

  // ── DELETE. ⚠ THIS LEG FAILS ON `main`. Before this face the only route to
  // `deleteNote` was a Backspace on a focused note, and the rack flip owns Tab.
  await noteEl.click({ force: true });
  await expect
    .poll(async () => (await readData(page)).notes?.length ?? 0, {
      message: 'clicking the SELECTED note again deletes it — the pointer route deleteNote never had',
    })
    .toBe(0);
  await expect
    .poll(async () => (await readData(page)).selectedNoteId ?? null, {
      message: 'and the selection does not dangle on a note that no longer exists',
    })
    .toBeNull();
});

// ── 3 · A TIE CAN BE REMOVED ────────────────────────────────────────────────

test('score face: the TIE cell adds a tie AND removes one', async ({ page }) => {
  guardPageErrors(page);
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: NODE, type: 'score', position: { x: 460, y: 240 } }]);
  const pane = await openFace(page, NODE);

  // Two notes in score order. The SUBJECT is the tie cell, so the notes are
  // seeded rather than clicked — a placement failure here would read as a tie
  // failure, which is the instrument confusing itself for the code.
  await seedNotes(page, [
    noteRow({ id: 'n-a', bar: 0, tick: 0 }),
    noteRow({ id: 'n-b', bar: 0, tick: 12, midi: 74, staffStep: 2 }),
  ]);

  const first = pane.locator(`[data-testid="score-note-${NODE}-n-a"]`);
  await expect(first).toBeVisible();
  await first.click({ force: true });
  await expect.poll(async () => (await readData(page)).selectedNoteId ?? null).toBe('n-a');

  const tie = pane.locator('[data-cell-key="score-tie-{n}"] [role="switch"], [data-cell-key="score-tie-{n}"] button').first();
  await expect(tie, 'the TIE cell paints a toggle').toBeVisible();

  // ── ON
  await tie.click();
  await expect
    .poll(async () => (await readData(page)).ties?.length ?? 0, {
      message: 'the TIE toggle ties the selection to the next note in score order',
    })
    .toBe(1);
  const tied = (await readData(page)).ties![0];
  expect(tied.fromNoteId).toBe('n-a');
  expect(tied.toNoteId, 'to the NEXT note, by absolute position').toBe('n-b');
  await expect(
    pane.locator(`[data-testid="score-tie-${NODE}-${tied.id}"]`),
    'and the arc is drawn on the staff',
  ).toBeVisible();

  // ── OFF. ⚠ THIS LEG FAILS ON `main`: `addTie` was the only writer of
  // `data.ties` anywhere in the repo, so a tie could not be removed at all.
  await tie.click();
  await expect
    .poll(async () => (await readData(page)).ties?.length ?? 0, {
      message: 'turning the TIE toggle off REMOVES the tie — there was no remover before this face',
    })
    .toBe(0);
  await expect(
    pane.locator(`[data-testid="score-tie-${NODE}-${tied.id}"]`),
    'and the arc goes with it',
  ).toHaveCount(0);
  // The notes themselves are untouched: untying is not deleting.
  expect((await readData(page)).notes?.map((n) => n.id)).toEqual(['n-a', 'n-b']);
});

// ── 4 · THE PIECE CAN SHRINK, AND SHRINKING KEEPS THE MUSIC ─────────────────

test('score face: PAGES grows and SHRINKS, and a shrink never deletes notes', async ({ page }) => {
  guardPageErrors(page);
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: NODE, type: 'score', position: { x: 460, y: 240 } }]);
  const pane = await openFace(page, NODE);

  // A note on what will become page 3 (bar 33 — pages are 16 bars each).
  await seedNotes(page, [noteRow({ id: 'far', bar: 33, tick: 0 })]);

  // ── GROW to four pages.
  await pickOption(pane, 'score-pages', '4');
  await expect
    .poll(async () => (await readData(page)).pages ?? 1, { message: 'PAGES writes node.data.pages' })
    .toBe(4);

  // ── SHRINK back to one. ⚠ THIS DIRECTION DOES NOT EXIST ON `main`: `addPage`
  // only incremented, so an unwanted page permanently lengthened the piece by
  // sixteen bars of silence on every pass.
  await pickOption(pane, 'score-pages', '1');
  const after = await readData(page);
  expect(after.pages, 'the piece can be made shorter again').toBe(1);
  expect(
    after.notes?.map((n) => n.id),
    'and shrinking is NON-DESTRUCTIVE — a mis-click must not be permanent data loss',
  ).toEqual(['far']);

  // Grow again and the music is exactly where it was.
  await pickOption(pane, 'score-pages', '4');
  const regrown = await readData(page);
  expect(regrown.pages).toBe(4);
  expect(regrown.notes?.[0]).toMatchObject({ id: 'far', bar: 33 });
});

// ── 5 · THE FOUR QUEUE CV INPUTS HAVE SOMETHING TO RESOLVE ──────────────────

test('score face: QUICKSAVE writes data.slots from the FACE, and a LOAD restores it', async ({ page }) => {
  guardPageErrors(page);
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: NODE, type: 'score', position: { x: 460, y: 240 } }]);
  const pane = await openFace(page, NODE);

  await seedNotes(page, [noteRow({ id: 'orig', bar: 0, tick: 0 })]);

  // ── SAVE slot 1 through the FACE's panel.
  //
  // ⚠ THE MODE COMES FIRST AND THAT IS NOT CEREMONY: `coercePendingMode` returns
  // null for anything that is not save/load/queue, so a fresh node has NO
  // pending mode and `resolveSlotClick(null, slot)` is a documented `noop`. A
  // bare slot click here would be red on a perfectly live widget.
  await pane.locator('[data-testid="score-slots-mode-save"]').click();
  await expect
    .poll(async () => (await readData(page)).pendingMode ?? null, {
      message: 'arming SAVE writes node.data.pendingMode',
    })
    .toBe('save');
  await pane.locator('[data-testid="score-slots-slot-1"]').click();

  // ⚠ `data.slots` IS THE EXACT KEY THE ENGINE'S QUEUE PATH READS
  // (`pollTransportCv → pickQueuedSlotFromEvents → data.queuedSlot →
  // maybeApplyQueuedSlot → data.slots[queued]`), and until this face it was
  // written by exactly one widget in the repo — one mounted only by the legacy
  // card. Four declared, documented CV inputs depended on that.
  await expect
    .poll(
      async () => {
        const slots = (await readData(page)).slots ?? {};
        return Object.entries(slots)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k]) => k)
          .sort();
      },
      { message: 'SAVE on the FACE populates node.data.slots — what queue1..4_cv resolve against' },
    )
    .toEqual(['1']);

  // ── Change the live piece, then LOAD the slot back.
  await seedNotes(page, [noteRow({ id: 'edited', bar: 2, tick: 24, midi: 76, staffStep: 1 })]);
  await pane.locator('[data-testid="score-slots-mode-load"]').click();
  await expect.poll(async () => (await readData(page)).pendingMode ?? null).toBe('load');
  await pane.locator('[data-testid="score-slots-slot-1"]').click();

  await expect
    .poll(async () => (await readData(page)).notes?.map((n) => n.id) ?? [], {
      message: 'LOAD on the FACE restores the saved snapshot — the whole round trip, on the default shell',
    })
    .toEqual(['orig']);

  // ⚠ SCOPE, STATED: this proves the FACE can write and read `data.slots`. That
  // the ENGINE swaps patterns when a queue_cv edge arrives is a separate claim
  // with its own gate — `transport-card.test.ts` + `transport-helpers.test.ts`
  // in the pure lane, which drive `resolveSlotClick`/`maybeApplyQueuedSlot`
  // directly. Neither half proves the other.
});

// ── 6 · THE REMOVED NUMBERS ARE READABLE, JUST NOT PAINTED ──────────────────

test('score face: the staff paints no readout, and every removed number is in its accessible name', async ({ page }) => {
  guardPageErrors(page);
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: NODE, type: 'score', position: { x: 460, y: 240 } }]);
  const pane = await openFace(page, NODE);
  const staff = pane.locator('[data-testid="score-staff-panel"]');
  await expect(staff).toBeVisible();

  await seedNotes(page, [
    noteRow({ id: 'n1', bar: 0, tick: 24 }),
    noteRow({ id: 'n2', bar: 1, tick: 0, midi: 74, staffStep: 2 }),
  ]);

  await expect
    .poll(() => staff.getAttribute('aria-label'), {
      message: 'the note count, the bar total, the key and the playhead all live in the accessible name',
    })
    .toContain('2 notes over 16 bars');
  const label = (await staff.getAttribute('aria-label')) ?? '';
  expect(label).toContain('showing page 1 of 1');
  expect(label).toContain('key of C major');
  expect(label).toContain('not playing');

  // ⚠ AND THE PAGE NUMERAL IS NOT PAINTED. The legacy card prints `1 / 4` in a
  // `.page-counter` span; on the face the piece's length is named ONCE, by the
  // PAGES selector, and the panel's own nav is two arrows with no numeral.
  await expect(
    pane.locator('[data-testid="score-page-counter-score"]'),
    'the card\'s resting page counter has no faceplate equivalent',
  ).toHaveCount(0);

  // The DYN cell distinguishes "marked here" from "sounding like this" — two
  // different facts, and the control only shows one of them.
  await pane.locator(`[data-testid="score-note-${NODE}-n1"]`).click({ force: true });
  await expect.poll(async () => (await readData(page)).selectedNoteId ?? null).toBe('n1');
  await pickOption(pane, 'score-dyn', 'ff');
  await expect
    .poll(async () => (await readData(page)).dynamics?.[0]?.level ?? null, {
      message: 'the DYN cell places a marking at the SELECTED note',
    })
    .toBe('ff');
  const dyn = (await readData(page)).dynamics![0];
  expect(dyn, 'at the selection\'s own position, not at bar 0').toMatchObject({ bar: 0, tick: 24 });
});


// ── 7 · ARMED MARKS APPLY TO THE NOTE YOU WRITE NEXT ────────────────────────

test('score face: with NOTHING selected the mark cells ARM the next note, and legato ties to the note BEFORE it', async ({ page }) => {
  guardPageErrors(page);
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: NODE, type: 'score', position: { x: 460, y: 240 } }]);
  const pane = await openFace(page, NODE);
  const staff = pane.locator('[data-testid="score-staff-panel"]');
  await expect(staff).toBeVisible();

  // ⚠ NOTHING IS SELECTED — a fresh score has no notes, so there is nothing to
  // select. The mark cells must still be live, and this is the leg that says so.
  expect((await readData(page)).selectedNoteId).toBeUndefined();
  await pickOption(pane, 'score-accidental', 'sharp');
  await expect
    .poll(async () => (await readData(page)).armedAccidental ?? null, {
      message: 'ACC with nothing selected ARMS the accidental rather than doing nothing',
    })
    .toBe('sharp');

  // Place a note: it arrives already spelled. The card could not do this at all
  // — its ♯ was a mode that could only retouch a note after the fact.
  await clickStaff(staff, 0.45, 0.3);
  await expect
    .poll(async () => (await readData(page)).notes?.[0]?.accidental ?? null, {
      message: 'the armed accidental applies at PLACEMENT',
    })
    .toBe('sharp');
  const first = (await readData(page)).notes![0];

  // ── LEGATO. Placing a note does NOT select it, so nothing is selected here
  // either and this is still the armed path.
  const tie = pane.locator('[data-cell-key="score-tie-{n}"] [role="switch"]').first();
  await tie.click();
  await expect
    .poll(async () => (await readData(page)).armedTie ?? false, {
      message: 'TIE with nothing selected arms LEGATO',
    })
    .toBe(true);

  // Write a note to the RIGHT of the first, then one BETWEEN them.
  await clickStaff(staff, 0.8, 0.3);
  await expect.poll(async () => (await readData(page)).notes?.length ?? 0).toBe(2);
  await clickStaff(staff, 0.62, 0.3);
  await expect.poll(async () => (await readData(page)).notes?.length ?? 0).toBe(3);

  // ⚠ THE DISCRIMINATING ASSERTION, and it took two attempts to find the right
  // instrument. The first version asserted that every tie joins ADJACENT notes
  // in the FINAL order — which is not the property, and it failed on correct
  // code: `right` was legitimately tied to `first` when it was written, and
  // inserting `middle` between them afterwards separates them without either
  // write having been wrong. What the fix actually decides is WHICH note a
  // legato tie reaches for AT PLACEMENT TIME: the one immediately before it in
  // SCORE ORDER, or "whichever note was written last". Those differ on exactly
  // this sequence, and only on it — so the pair ids are the assertion.
  const data = await readData(page);
  const pos = (n: ScoreNoteRow) => n.bar * TICKS_PER_BAR + n.tick;
  const byPos = [...(data.notes ?? [])].sort((a, b) => pos(a) - pos(b));
  const [left, middle, right] = byPos;
  expect(left.id, 'the first note placed is still leftmost').toBe(first.id);

  const pairs = (data.ties ?? [])
    .map((t) => `${t.fromNoteId}->${t.toNoteId}`)
    .sort();
  expect(
    pairs,
    `a legato tie reaches the note immediately BEFORE it in score order. ` +
      `The middle note must be tied to the one on its LEFT (${left.id}), not to the ` +
      `note written most recently (${right.id}) — the pre-fix code produced the latter.`,
  ).toEqual([`${left.id}->${middle.id}`, `${left.id}->${right.id}`].sort());
});
