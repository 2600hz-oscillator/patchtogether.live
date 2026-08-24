// e2e/tests/clipplayer-note-menu.spec.ts
//
// THE NOTE RIGHT-CLICK MENU, restructured (owner, 2026-08-24): "right now we
// have one long list — what i want is a list with sub lists 'gate probability',
// 'pitch probability', 'play every' and those expand into sub lists with their
// options … on the front level list we need a 'copy', 'paste' … i also want a
// 'clear' which deletes the clip."
//
// Three things only a browser can decide, and each is written so it FAILS on the
// pre-change UI rather than merely describing the new one:
//
//  1. THE REGROUP IS REAL — the option lists are not merely re-labelled but
//     absent until their parent row is opened. The old menu rendered all ~90
//     rows at once, so "level 40 is not in the DOM after a right-click" is
//     exactly the assertion the flat list could not satisfy.
//  2. COPY/PASTE ARE THE LAUNCHPAD'S, not a second implementation — a paste
//     REPLACES the target's notes and carries the clip's DEFAULT PROBABILITY
//     with it. That last clause is the end-to-end proof of the `copyClip` fix
//     that shipped with this menu: pre-fix, the pasted clip silently reverted to
//     100% and every note in it fired more often than the source's.
//  3. CLEAR DELETES THE CLIP — the owner's explicit semantic, distinct from the
//     editor's ⌫ (which empties notes and keeps the clip). Undoable, because
//     that is why neither has a confirm dialog.
//
// The per-note WRITE paths (probability / pitch / play-every levels) are already
// covered by clipplayer-pitch-probability.spec.ts and the pure menu unit tests;
// this file deliberately does not re-assert them.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type Page = import('@playwright/test').Page;
type NoteStep = { step: number; midi: number };
type Clip = { steps?: NoteStep[]; defaultProb?: number };
type ClipData = { clips?: Record<string, Clip | undefined> };
type W = { __patch: { nodes: Record<string, { data?: ClipData }> } };

/** Seed a clip at flat index `idx`. Mutates node.data IN PLACE — syncedStore
 *  rejects reassigning an object already in the tree. */
async function seedClip(page: Page, idx: number, step: number, midi: number, defaultProb?: number) {
  await page.evaluate(
    ({ i, s, m, dp }) => {
      const d = ((globalThis as unknown as W).__patch.nodes['cp'].data ?? {}) as ClipData;
      if (!d.clips) d.clips = {};
      const clip: Clip & { kind: string; lengthSteps: number; root: number; loop: boolean } = {
        kind: 'note',
        lengthSteps: 16,
        root: 60,
        loop: true,
        steps: [{ step: s, midi: m }],
      };
      if (typeof dp === 'number') clip.defaultProb = dp;
      d.clips[String(i)] = clip;
    },
    { i: idx, s: step, m: midi, dp: defaultProb },
  );
}

async function readClip(page: Page, idx: number): Promise<Clip | undefined> {
  return page.evaluate((i) => {
    const d = (globalThis as unknown as W).__patch.nodes['cp'].data ?? {};
    return JSON.parse(JSON.stringify(d.clips?.[String(i)] ?? null)) as Clip | undefined;
  }, idx);
}

async function spawn(page: Page) {
  await spawnPatch(page, [
    { id: 'tl', type: 'timelorde', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: 'cp', type: 'clipplayer', position: { x: 420, y: 40 }, domain: 'audio' },
  ]);
  await expect(page.locator('[data-clip="0"]')).toBeVisible();
}

/** Open clip `idx` in the piano-roll editor and right-click its ONE seeded note,
 *  which is what opens the per-note menu (the menu refuses to open on an empty
 *  cell — `setNoteProb` never creates a note). Returns the menu locator. */
async function openNoteMenu(page: Page, idx: number) {
  await page.locator(`[data-clip="${idx}"]`).dblclick();
  await expect(page.getByTestId('clipplayer-pianoroll')).toBeVisible();
  // The seeded note is the only painted cell in the roll.
  await page.locator('[data-testid="clipplayer-pianoroll"] .cell.note').first().click({ button: 'right' });
  const menu = page.getByTestId('clipplayer-prob-menu-cp');
  await expect(menu).toBeVisible();
  return menu;
}

test('the note menu is SUB LISTS: options are absent until their parent row is opened', async ({ page, rack }) => {
  await spawn(page);
  await seedClip(page, 0, 3, 64);
  const menu = await openNoteMenu(page, 0);

  // TOP LEVEL — the owner's six entries, and nothing else.
  for (const id of ['sub-gate', 'sub-pitch', 'sub-every', 'note-copy', 'note-paste', 'note-clear']) {
    await expect(menu.getByTestId(`clipplayer-${id}-cp`)).toBeVisible();
  }

  // THE LOAD-BEARING NEGATIVE: on the old flat menu every one of these was in
  // the DOM the instant the menu opened. If the submenus ever collapse back into
  // one column, this is what reddens.
  await expect(page.getByTestId('clipplayer-prob-item-40')).toHaveCount(0);
  await expect(page.getByTestId('clipplayer-pitch-prob-item-20')).toHaveCount(0);
  await expect(page.getByTestId('clipplayer-play-every-item-3')).toHaveCount(0);

  // Opening `gate probability` reveals ITS list only.
  await menu.getByTestId('clipplayer-sub-gate-cp').click();
  await expect(page.getByTestId('clipplayer-submenu-gate-cp')).toBeVisible();
  await expect(page.getByTestId('clipplayer-prob-item-40')).toBeVisible();
  await expect(page.getByTestId('clipplayer-pitch-prob-item-20')).toHaveCount(0);

  // Switching parents SWAPS the flyout rather than stacking a second one.
  await menu.getByTestId('clipplayer-sub-pitch-cp').click();
  await expect(page.getByTestId('clipplayer-submenu-pitch-cp')).toBeVisible();
  await expect(page.getByTestId('clipplayer-submenu-gate-cp')).toHaveCount(0);
  await expect(page.getByTestId('clipplayer-prob-item-40')).toHaveCount(0);
  await expect(page.getByTestId('clipplayer-pitch-prob-item-20')).toBeVisible();

  // `play every` is the third, and its levels are the 1..8 the model declares.
  await menu.getByTestId('clipplayer-sub-every-cp').click();
  await expect(page.getByTestId('clipplayer-play-every-item-3')).toBeVisible();
  await expect(page.getByTestId('clipplayer-submenu-pitch-cp')).toHaveCount(0);
});

test('copy → paste REPLACES the target clip and carries its default probability', async ({ page, rack }) => {
  await spawn(page);
  // Source: a note at step 3 and a CLIP DEFAULT of 50%. Target: a different note
  // and no default — so both halves of the paste are observable.
  await seedClip(page, 0, 3, 64, 0.5);
  await seedClip(page, 1, 7, 67);

  // PASTE starts disabled: an empty clipboard is a fact worth showing, not a
  // silent no-op. (This also proves the item is wired to the real buffer.)
  const menu0 = await openNoteMenu(page, 0);
  await expect(menu0.getByTestId('clipplayer-note-paste-cp')).toBeDisabled();
  await menu0.getByTestId('clipplayer-note-copy-cp').click();
  await expect(menu0).toBeHidden();

  // Back to the grid, open the OTHER clip, paste over it.
  await page.getByTestId('clipplayer-strip-2-cp').click();
  const menu1 = await openNoteMenu(page, 1);
  const paste = menu1.getByTestId('clipplayer-note-paste-cp');
  await expect(paste, 'a loaded CLIP buffer enables paste').toBeEnabled();
  await paste.click();

  await expect
    .poll(async () => (await readClip(page, 1))?.steps?.[0]?.step, { timeout: 5000 })
    .toBe(3);
  const pasted = await readClip(page, 1);
  expect(pasted?.steps?.[0]?.midi, 'the source note replaced the target note').toBe(64);
  expect(pasted?.steps).toHaveLength(1);
  expect(
    pasted?.defaultProb,
    'defaultProb travels with the clip — pre-fix this was undefined (i.e. 100%) and every note fired more often than the source',
  ).toBe(0.5);

  // The SOURCE is untouched — a paste is a copy, not a move.
  const src = await readClip(page, 0);
  expect(src?.steps?.[0]?.step).toBe(3);
  expect(src?.defaultProb).toBe(0.5);
});

test('clear DELETES the clip (not just its notes) and ↶ brings it back', async ({ page, rack }) => {
  await spawn(page);
  await seedClip(page, 0, 3, 64);
  const menu = await openNoteMenu(page, 0);
  await menu.getByTestId('clipplayer-note-clear-cp').click();

  // The whole clip RECORD is gone — the distinction from the editor's ⌫, which
  // empties `steps` and keeps the record. An emptied clip would read as an
  // object with `steps: []`, so asserting the notes alone could not tell the two
  // apart; asserting the record is what pins the owner's wording.
  await expect.poll(() => readClip(page, 0), { timeout: 5000 }).toBeNull();
  // …and the pad reflects it, so the card is not left showing a deleted clip.
  await expect(page.locator('[data-clip="0"]')).toHaveAttribute('data-state', 'empty');

  // Undoable — the reason clear has no confirm dialog, exactly like the grid
  // pad's Delete it shares `deleteClipAt` with. ↶ is control-strip 6.
  await page.getByTestId('clipplayer-strip-6-cp').click();
  await expect.poll(async () => (await readClip(page, 0))?.steps?.[0]?.midi, { timeout: 5000 }).toBe(64);
});
