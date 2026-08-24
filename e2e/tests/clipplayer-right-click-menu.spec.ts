// e2e/tests/clipplayer-right-click-menu.spec.ts
//
// THE RIGHT-CLICK MENU, on BOTH surfaces a user can right-click (owner,
// 2026-08-24): "a list with sub lists 'note probability', 'pitch probability',
// 'skip every' and those expand into sub lists with their options. also on the
// front level list we need a 'copy', 'paste' … i also want a 'clear' which
// deletes the clip."
//
// ⚠ WHY THIS FILE REPLACES THE PREVIOUS MENU SPEC. The first restructure shipped
// with a spec that drove the real card through its real mount — and asserted the
// menu on the PIANO-ROLL NOTE CELL only. The owner right-clicks the LAUNCHER PAD,
// whose menu was a different code path and stayed a flat 40-row list. The spec was
// green the whole time. So the load-bearing property here is not "the menu has the
// owner's rows" — it is "BOTH surfaces have them", and the strongest form of that
// is DERIVED: read the top level off one surface, read it off the other, and
// assert the two are EQUAL. A future change that reaches one menu and not the
// other reddens on the comparison without anyone having to remember the second
// surface exists.
//
// Everything here is the real user path: a real card mounted on the canvas, real
// clicks to create the clip and draw the note, real right-clicks, and every
// assertion of effect read back off the SYNCED node data every peer sees.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type Page = import('@playwright/test').Page;
type NoteStep = { step: number; midi: number; prob?: number; pitchProb?: number; playEvery?: number };
type Clip = { steps?: NoteStep[]; defaultProb?: number };
type W = { __patch: { nodes: Record<string, { data?: { clips?: Record<string, Clip | undefined> } }> } };

/** THE OWNER'S LIST, in their order and their words. One definition, asserted
 *  against both surfaces — never re-typed per test. */
const TOP_LEVEL = ['note probability', 'pitch probability', 'skip every', 'copy', 'paste', 'clear'];

async function readClip(page: Page, idx: number): Promise<Clip | null> {
  return page.evaluate((i) => {
    const d = (globalThis as unknown as W).__patch.nodes['cp'].data ?? {};
    return JSON.parse(JSON.stringify(d.clips?.[String(i)] ?? null)) as Clip | null;
  }, idx);
}

async function spawn(page: Page) {
  await spawnPatch(page, [
    { id: 'tl', type: 'timelorde', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: 'cp', type: 'clipplayer', position: { x: 420, y: 40 }, domain: 'audio' },
  ]);
  await expect(page.locator('[data-clip="0"]')).toBeVisible();
}

/** Create clip `idx` and draw `count` notes in it, THE WAY A USER DOES:
 *  double-click the pad (which creates the clip and opens the editor), click
 *  cells to place notes, then return to the launch grid. */
async function drawClip(page: Page, idx: number, cells: Array<[row: number, step: number]>) {
  await page.locator(`[data-clip="${idx}"]`).dblclick();
  await expect(page.getByTestId('clipplayer-pianoroll')).toBeVisible();
  for (const [row, step] of cells) await page.getByTestId(`clipplayer-cell-${row}-${step}`).click();
  await expect.poll(async () => (await readClip(page, idx))?.steps?.length ?? 0).toBe(cells.length);
}

async function backToGrid(page: Page) {
  await page.getByTestId('clipplayer-strip-2-cp').click();
  await expect(page.locator('[data-clip="0"]')).toBeVisible();
}

/** Right-click a launcher PAD — the surface in the owner's screenshot. */
async function openPadMenu(page: Page, idx: number) {
  await page.locator(`[data-clip="${idx}"]`).click({ button: 'right' });
  const menu = page.getByTestId('clipplayer-clip-prob-menu-cp');
  await expect(menu).toBeVisible();
  return menu;
}

/** Right-click the note in the piano roll — the editor surface. */
async function openNoteMenu(page: Page, idx: number) {
  await page.locator(`[data-clip="${idx}"]`).dblclick();
  await expect(page.getByTestId('clipplayer-pianoroll')).toBeVisible();
  await page.locator('[data-testid="clipplayer-pianoroll"] .cell.note').first().click({ button: 'right' });
  const menu = page.getByTestId('clipplayer-prob-menu-cp');
  await expect(menu).toBeVisible();
  return menu;
}

async function closeMenu(page: Page) {
  await page.locator('.prob-menu-backdrop').click();
  await expect(page.locator('.prob-menu')).toHaveCount(0);
}

type Menu = import('@playwright/test').Locator;
/** The menu's TOP-LEVEL rows, in DOM order — the flyout's options are
 *  `menuitemcheckbox`, so this reads the six parent rows and nothing else. */
function topLevel(menu: Menu) {
  return menu.locator('[role="menuitem"]');
}

test('the LAUNCHER PAD menu — the surface the owner right-clicks — is the ordered list with working sub lists', async ({
  page,
  rack,
}) => {
  await spawn(page);
  await drawClip(page, 0, [[6, 4]]);
  await backToGrid(page);
  const menu = await openPadMenu(page, 0);

  // THE OWNER'S LIST, in order, and NOTHING else at the top level.
  expect(await topLevel(menu).allInnerTexts()).toEqual(TOP_LEVEL);

  // THE LOAD-BEARING NEGATIVE: the old menu on THIS surface rendered all 40
  // percentages the instant it opened. "Not in the DOM until its parent row is
  // opened" is exactly what a flat list cannot satisfy.
  await expect(page.getByTestId('clipplayer-clip-prob-item-40')).toHaveCount(0);
  await expect(page.getByTestId('clipplayer-pitch-prob-item-20')).toHaveCount(0);
  await expect(page.getByTestId('clipplayer-play-every-item-3')).toHaveCount(0);

  // Each row expands ITS list, and switching parents SWAPS the flyout rather
  // than stacking a second one.
  await menu.getByTestId('clipplayer-sub-note-cp').click();
  await expect(page.getByTestId('clipplayer-submenu-note-cp')).toBeVisible();
  await expect(page.getByTestId('clipplayer-clip-prob-item-40')).toBeVisible();
  await expect(page.getByTestId('clipplayer-pitch-prob-item-20')).toHaveCount(0);

  await menu.getByTestId('clipplayer-sub-pitch-cp').click();
  await expect(page.getByTestId('clipplayer-submenu-pitch-cp')).toBeVisible();
  await expect(page.getByTestId('clipplayer-submenu-note-cp')).toHaveCount(0);
  await expect(page.getByTestId('clipplayer-pitch-prob-item-20')).toBeVisible();

  await menu.getByTestId('clipplayer-sub-skip-cp').click();
  await expect(page.getByTestId('clipplayer-submenu-skip-cp')).toBeVisible();
  await expect(page.getByTestId('clipplayer-submenu-pitch-cp')).toHaveCount(0);
  await expect(page.getByTestId('clipplayer-play-every-item-3')).toBeVisible();
});

test('BOTH surfaces show the SAME top level — the property the wrong-surface restructure broke', async ({
  page,
  rack,
}) => {
  await spawn(page);
  await drawClip(page, 0, [[6, 4]]);

  // The NOTE cell, in the editor.
  const noteMenu = await openNoteMenu(page, 0);
  const fromNote = await topLevel(noteMenu).allInnerTexts();
  await closeMenu(page);
  await backToGrid(page);

  // The launcher PAD.
  const padMenu = await openPadMenu(page, 0);
  const fromPad = await topLevel(padMenu).allInnerTexts();

  // DERIVED, not two hand-typed lists: whatever the top level is, the two
  // surfaces must agree on it. This is the assertion that reddens if a future
  // change reaches one menu and not the other — the exact defect this file
  // replaces a spec for.
  expect(fromPad, 'the pad menu and the note menu are ONE menu').toEqual(fromNote);
  expect(fromPad, "…and it is the owner's list, in the owner's order").toEqual(TOP_LEVEL);
});

test('PAD menu: each sub list applies to the CLIP, read back off the synced data', async ({ page, rack }) => {
  await spawn(page);
  // TWO notes, so a clip-level write is visibly a write to EVERY note and not
  // just to the one the menu happened to be over.
  await drawClip(page, 0, [[6, 4], [5, 8]]);
  await backToGrid(page);

  // note probability → the clip DEFAULT (level 20 of 40 = 50%).
  let menu = await openPadMenu(page, 0);
  await menu.getByTestId('clipplayer-sub-note-cp').click();
  await page.getByTestId('clipplayer-clip-prob-item-20').click();
  await expect.poll(async () => (await readClip(page, 0))?.defaultProb, { timeout: 5000 }).toBeCloseTo(0.5, 5);

  // pitch probability → every note's pitchProb.
  menu = await openPadMenu(page, 0);
  await menu.getByTestId('clipplayer-sub-pitch-cp').click();
  await page.getByTestId('clipplayer-pitch-prob-item-20').click();
  await expect
    .poll(async () => (await readClip(page, 0))?.steps?.map((s) => s.pitchProb), { timeout: 5000 })
    .toEqual([0.5, 0.5]);

  // skip every → every note's playEvery. (The model DELETES the key at the
  // default, so "3 then back to 1" round-trips to the key being absent.)
  menu = await openPadMenu(page, 0);
  await menu.getByTestId('clipplayer-sub-skip-cp').click();
  await page.getByTestId('clipplayer-play-every-item-3').click();
  await expect
    .poll(async () => (await readClip(page, 0))?.steps?.map((s) => s.playEvery), { timeout: 5000 })
    .toEqual([3, 3]);

  menu = await openPadMenu(page, 0);
  await menu.getByTestId('clipplayer-sub-skip-cp').click();
  await page.getByTestId('clipplayer-play-every-item-1').click();
  await expect
    .poll(async () => (await readClip(page, 0))?.steps?.map((s) => s.playEvery ?? 1), { timeout: 5000 })
    .toEqual([1, 1]);
});

test('NOTE menu: the same sub lists apply to the ONE note they were opened on', async ({ page, rack }) => {
  await spawn(page);
  await drawClip(page, 0, [[6, 4], [5, 8]]);

  // The FIRST painted cell in the roll is the note the menu opens on; the other
  // note is the control that must NOT move.
  const menu = await openNoteMenu(page, 0);
  await menu.getByTestId('clipplayer-sub-note-cp').click();
  await page.getByTestId('clipplayer-prob-item-20').click();
  await expect
    .poll(async () => (await readClip(page, 0))?.steps?.filter((s) => s.prob !== undefined).length, { timeout: 5000 })
    .toBe(1);
  const clip = await readClip(page, 0);
  const withProb = clip?.steps?.find((s) => s.prob !== undefined);
  expect(withProb?.prob, 'the note carries its OWN probability').toBeCloseTo(0.5, 5);
  expect(clip?.defaultProb, 'a NOTE pick must not touch the clip default').toBeUndefined();
});

test('copy on one pad → paste on ANOTHER pad moves the clip content (the shared Launchpad clipboard)', async ({
  page,
  rack,
}) => {
  await spawn(page);
  await drawClip(page, 0, [[6, 4]]);
  await backToGrid(page);
  // Give the source a clip DEFAULT so the paste is observable in two independent
  // channels, not just "some notes arrived".
  let menu = await openPadMenu(page, 0);
  await menu.getByTestId('clipplayer-sub-note-cp').click();
  await page.getByTestId('clipplayer-clip-prob-item-20').click();
  await expect.poll(async () => (await readClip(page, 0))?.defaultProb, { timeout: 5000 }).toBeCloseTo(0.5, 5);

  // PASTE starts disabled — an empty clipboard is a fact the menu shows rather
  // than a silent no-op, and it proves the row is wired to the real buffer.
  menu = await openPadMenu(page, 0);
  await expect(menu.getByTestId('clipplayer-menu-paste-cp')).toBeDisabled();
  await menu.getByTestId('clipplayer-menu-copy-cp').click();
  await expect(menu).toHaveCount(0);

  // …onto an EMPTY pad in another lane: this is the Launchpad's duplicate
  // gesture, and it is why the menu opens on empty pads at all.
  expect(await readClip(page, 9), 'the target starts empty').toBeNull();
  const target = await openPadMenu(page, 9);
  const paste = target.getByTestId('clipplayer-menu-paste-cp');
  await expect(paste, 'a loaded CLIP buffer enables paste, even on an empty slot').toBeEnabled();
  await paste.click();

  await expect.poll(async () => (await readClip(page, 9))?.steps?.length, { timeout: 5000 }).toBe(1);
  const pasted = await readClip(page, 9);
  const source = await readClip(page, 0);
  expect(pasted?.steps?.[0]?.midi, 'the source note arrived').toBe(source?.steps?.[0]?.midi);
  expect(pasted?.defaultProb, 'the clip DEFAULT travels with the clip').toBeCloseTo(0.5, 5);
  await expect(page.locator('[data-clip="9"]')).toHaveAttribute('data-state', 'loaded');

  // A paste is a COPY, not a move.
  expect(source?.steps).toHaveLength(1);
});

test('clear DELETES the clip from the pad menu, and ↶ brings it back with its notes', async ({ page, rack }) => {
  await spawn(page);
  await drawClip(page, 0, [[6, 4]]);
  await backToGrid(page);
  const before = await readClip(page, 0);

  const menu = await openPadMenu(page, 0);
  const clear = menu.getByTestId('clipplayer-menu-clear-cp');
  await expect(clear, 'clear targets the RIGHT-CLICKED pad, not the selected editor clip').toHaveAttribute(
    'data-clip-idx',
    '0',
  );
  // The menu row must not also answer to `[data-clip="0"]` — that is the grid PAD
  // selector, and a second match would make every pad locator ambiguous.
  await expect(page.locator('[data-clip="0"]')).toHaveCount(1);
  await clear.click();
  await expect(menu, 'picking clear closes the menu').toHaveCount(0);

  // The whole clip RECORD is gone — the owner's wording, and the distinction
  // from the editor's ⌫ (which empties the notes and keeps the record). An
  // emptied clip would read as `{ steps: [] }`, so asserting the notes alone
  // could not tell the two apart.
  await expect.poll(() => readClip(page, 0), { timeout: 5000 }).toBeNull();
  await expect(page.locator('[data-clip="0"]')).toHaveAttribute('data-state', 'empty');

  // Undoable — the reason clear has no confirm dialog. ↶ is control-strip 6.
  await page.getByTestId('clipplayer-strip-6-cp').click();
  await expect.poll(async () => (await readClip(page, 0))?.steps?.length, { timeout: 5000 }).toBe(1);
  expect((await readClip(page, 0))?.steps?.[0]?.midi).toBe(before?.steps?.[0]?.midi);
});

test('an EMPTY pad opens the SAME menu with only paste live — the rows are disabled, never missing', async ({
  page,
  rack,
}) => {
  await spawn(page);
  const menu = await openPadMenu(page, 3);

  // Same shape everywhere: the owner's six rows, so the menu never looks like a
  // different feature depending on which pad you hit.
  expect(await topLevel(menu).allInnerTexts()).toEqual(TOP_LEVEL);
  for (const id of ['sub-note', 'sub-pitch', 'sub-skip', 'menu-copy', 'menu-clear']) {
    await expect(menu.getByTestId(`clipplayer-${id}-cp`), `${id} needs a clip`).toBeDisabled();
  }
  await expect(menu.getByTestId('clipplayer-menu-paste-cp'), 'nothing copied yet').toBeDisabled();

  // A disabled parent row opens no flyout — the disabled state is real, not
  // cosmetic.
  await menu.getByTestId('clipplayer-sub-note-cp').click({ force: true });
  await expect(page.getByTestId('clipplayer-submenu-note-cp')).toHaveCount(0);
});
