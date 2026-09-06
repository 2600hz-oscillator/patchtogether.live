// e2e/tests/clipplayer-custom-scale.spec.ts
//
// CUSTOM SCALE — the per-lane note-ROW FILTER for the clip editor (owner spec,
// 2026-08-06). The rig it exists for: a device listening on MIDI ch 10 for FOUR
// notes, converted to drum triggers in the modular rack — so the sequencer must
// show only those four rows.
//
// This is the DOM gate on the real editor, driven in the DOCK FULL VIEW (the
// default shell's home for the piano roll). The pure row math is unit-tested
// (clip-types.test.ts `visibleNoteRows`) and the hardware side is pinned in
// clip-surface-map / launchpad-map / monome-map specs. What only an e2e can
// prove is asserted here:
//   * the picker reveals a checkbox per row WITHOUT filtering yet (so rows can
//     be ADDED — a filtered picker could only ever remove),
//   * APPLY hides every unchecked row and leaves EXACTLY the checked ones,
//   * D1 — a note on a HIDDEN row is NOT deleted and is still in the clip
//     (hiding a row must never be data loss by UI state),
//   * REMOVE unhides them and the note is still there, and the membership set
//     SURVIVES the remove (re-applying is one click),
//   * the filter is PER LANE — a second lane's editor is unaffected.
//
// ⚠ The legacy card needed `revealInPane` here (SvelteFlow undoes browser
// scrolls of the canvas pane). The dock full view is an ordinary scroll
// container — Playwright's own auto-scroll is safe, so that machinery left
// with the card.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

// Default clip = major from C3 → 57 editable rows (pinned in clip-types.test.ts).
const FULL_ROWS = 57;

interface CPData {
  customScale?: (number[] | null)[];
  customScaleOn?: boolean[];
  clips?: Record<string, { steps?: Array<{ step: number; midi: number }> } | null>;
}
type W = { __patch: { nodes: Record<string, { data?: CPData }> } };

const nodeData = (page: Page, id: string) =>
  page.evaluate((nid) => (globalThis as unknown as W).__patch.nodes[nid]?.data ?? null, id);

/** MIDI note of each rendered row, top→bottom, read off the checkbox testids
 *  (`clipplayer-scalerow-<id>-<midi>`) — only available while picking. */
async function pickerRowMidis(page: Page): Promise<number[]> {
  return await page.getByTestId('clipplayer-pianoroll').evaluate((roll) =>
    Array.from(roll.querySelectorAll('input[data-testid^="clipplayer-scalerow-"]')).map((el) =>
      Number((el as HTMLElement).dataset.testid!.split('-').pop()),
    ),
  );
}

async function rowCount(page: Page): Promise<number> {
  return await page
    .getByTestId('clipplayer-pianoroll')
    .evaluate((roll) => roll.querySelectorAll('.pr-row').length);
}

/** The MIDI notes currently in clip `slot` of the node's data. */
async function clipNotes(page: Page, id: string, slot = '0'): Promise<number[]> {
  const d = await nodeData(page, id);
  return (d?.clips?.[slot]?.steps ?? []).map((s) => s.midi).sort((a, b) => a - b);
}

/** Open the clip player's dock full view (grid + roll + deck in one surface). */
/** Bind a clip by double-clicking its PAD, returning to the grid band first.
 *
 *  The pad dblclick is what moves the railed face to `editor`, so a second bind
 *  has to come back to `session` before the pads exist to click. */
async function bindPad(page: Page, dock: import('@playwright/test').Locator, idx: number) {
  const tab = dock.getByTestId('faceplate-tab-session');
  await tab.click();
  await expect(tab, 'the session page opens').toHaveAttribute('aria-selected', 'true');
  await dock.locator(`[data-clip="${idx}"]`).dblclick();
  await expect(page.getByTestId('clipplayer-pianoroll')).toBeVisible();
}

async function openDock(page: Page) {
  const tile = page.locator('.svelte-flow__node[data-id="cp"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  await tile.getByTestId('shell-open-dock').click();
  const dock = page.getByTestId('dock-full-view');
  await expect(dock).toBeVisible();
  // ⚠ SELECT THE BAND THE PADS ARE ON. The face is RAILED (`face.tabbed`, owner
  // P0 2026-09-04) and renders exactly ONE band: the launch grid is `session`,
  // the piano roll is `editor`. An unselected band is `display:none`, so a
  // `[data-clip]` locator resolves a real element with a 0×0 box and the
  // dblclick every caller starts with times out instead of failing on a missing
  // selector. Every test in this file opens with a pad, so the page is selected
  // here rather than repeated per test; the pad dblclick then moves the face to
  // `editor` itself, which is the product's own gesture.
  const tab = dock.getByTestId('faceplate-tab-session');
  await tab.click();
  await expect(tab, 'the session page opens').toHaveAttribute('aria-selected', 'true');
  return dock;
}

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body was re-pointed at the
// dock full view by the S2 legacy-removal inversion (same assertions, shell
// surface). NONDETERMINISM: 1 recovered-on-retry observation(s) across 1 SHA(s)
// / 1 branch(es) in the 96 h CI census to 2026-08-18 — never a hard failure, so
// every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: the per-lane note-row filter's non-destructive contract — hidden rows keep their notes and REMOVE restores them; a filter that eats data silently destroys the user's pattern.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('custom scale: pick rows → APPLY hides the rest → hidden notes SURVIVE → REMOVE restores', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 1 recovered-on-retry observation in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({
  page,
  rack,
}) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
  ]);
  const dock = await openDock(page);

  // Bind clip 0 (lane 0) into the editor band.
  await dock.locator('[data-clip="0"]').dblclick();
  const roll = page.getByTestId('clipplayer-pianoroll');
  await expect(roll).toBeVisible();
  expect(await rowCount(page), 'starts on the full editable range').toBe(FULL_ROWS);

  // A note is placed FIRST, on a row we are about to hide (row 10 of the full
  // list) — that is what makes the D1 assertion below meaningful.
  await dock.getByTestId('clipplayer-cell-10-0').click();
  await expect.poll(async () => (await clipNotes(page, 'cp')).length).toBe(1);
  const [hiddenNote] = await clipNotes(page, 'cp');

  // APPLY is disabled with no membership yet (never let the grid go to 0 rows).
  const apply = dock.getByTestId('clipplayer-customscale-apply-cp');
  await apply.scrollIntoViewIfNeeded();
  await expect(apply).toBeDisabled();
  await expect(apply).toHaveText('APPLY SCALE');

  // ── Open the picker: checkboxes appear, and the row list is still UNFILTERED
  // so rows can be ADDED (not just removed). ────────────────────────────────
  await dock.getByTestId('clipplayer-customscale-cp').click();
  await expect
    .poll(async () => (await pickerRowMidis(page)).length, { timeout: 5000 })
    .toBe(FULL_ROWS);
  expect(await rowCount(page), 'picking does not filter — every row is offered').toBe(FULL_ROWS);

  // Check four rows spread through the list (the owner's 4 drum rows).
  const allMidis = await pickerRowMidis(page);
  const chosen = [allMidis[8], allMidis[12], allMidis[20], allMidis[33]];
  expect(new Set(chosen).size, 'four distinct rows').toBe(4);
  expect(chosen, 'the note we placed is NOT one of them').not.toContain(hiddenNote);
  for (const m of chosen) {
    const row = dock.getByTestId(`clipplayer-scalerow-cp-${m}`);
    await row.scrollIntoViewIfNeeded();
    await row.check();
  }

  await expect
    .poll(async () => (await nodeData(page, 'cp'))?.customScale?.[0]?.length ?? 0)
    .toBe(4);
  await apply.scrollIntoViewIfNeeded();
  await expect(apply, 'APPLY enables once rows are checked').toBeEnabled();

  // ── APPLY: exactly the four checked rows remain. ──────────────────────────
  await apply.click();
  await expect.poll(async () => rowCount(page), { timeout: 5000 }).toBe(4);
  await expect(apply).toHaveText('REMOVE SCALE');
  // Applying closes the picker — the point of APPLY is to see the filtered grid.
  await expect(dock.getByTestId(`clipplayer-scalerow-cp-${chosen[0]}`)).toHaveCount(0);
  await expect
    .poll(async () => (await nodeData(page, 'cp'))?.customScaleOn?.[0] ?? false)
    .toBe(true);

  // D1 — the note on the now-HIDDEN row is still in the clip. A view filter must
  // never delete notes; the scheduler reads clip.steps and knows nothing about
  // customScale, so it also still plays.
  expect(await clipNotes(page, 'cp'), 'hidden row keeps its note (no data loss)').toEqual([
    hiddenNote,
  ]);

  // ── REMOVE: rows come back, note intact, membership KEPT. ─────────────────
  await apply.click();
  await expect.poll(async () => rowCount(page), { timeout: 5000 }).toBe(FULL_ROWS);
  await expect(apply).toHaveText('APPLY SCALE');
  expect(await clipNotes(page, 'cp'), 'note survived the whole round trip').toEqual([hiddenNote]);
  const after = await nodeData(page, 'cp');
  expect(after?.customScale?.[0]?.length, 'REMOVE keeps the set — re-apply is one click').toBe(4);
  expect(after?.customScaleOn?.[0]).toBe(false);
  await expect(apply, 'still enabled because the set is kept').toBeEnabled();
});

test('custom scale is PER LANE — applying it on lane 0 leaves lane 1 on the full range', async ({
  page,
  rack,
}) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
  ]);
  const dock = await openDock(page);

  // Lane 0, slot 0 → clip index 0. Apply a 3-row scale.
  await dock.locator('[data-clip="0"]').dblclick();
  await expect(page.getByTestId('clipplayer-pianoroll')).toBeVisible();
  await dock.getByTestId('clipplayer-customscale-cp').scrollIntoViewIfNeeded();
  await dock.getByTestId('clipplayer-customscale-cp').click();
  const midis = await pickerRowMidis(page);
  for (const m of [midis[5], midis[9], midis[14]]) {
    const row = dock.getByTestId(`clipplayer-scalerow-cp-${m}`);
    await row.scrollIntoViewIfNeeded();
    await row.check();
  }
  await dock.getByTestId('clipplayer-customscale-apply-cp').click();
  await expect.poll(async () => rowCount(page), { timeout: 5000 }).toBe(3);

  // Bind LANE 1's clip (index = lane*SCENE_STRIDE). Switching lanes means
  // returning to the GRID band first: the pad dblclick above moved the face to
  // `editor`, which is the product's own gesture, so the pads are no longer
  // rendered. (This comment used to read "on the face the grid is always on
  // screen" — true of the card, not of the railed face.)
  await bindPad(page, dock, 64);
  await expect
    .poll(async () => rowCount(page), { timeout: 5000 })
    .toBe(FULL_ROWS);
  await expect(dock.getByTestId('clipplayer-customscale-apply-cp')).toHaveText('APPLY SCALE');

  // …and lane 0 still has its own filter when we go back to it.
  await bindPad(page, dock, 0);
  await expect.poll(async () => rowCount(page), { timeout: 5000 }).toBe(3);
});
