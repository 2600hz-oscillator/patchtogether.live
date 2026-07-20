// e2e/tests/clipplayer-clip-view-grid.spec.ts
//
// CLIP PLAYER clip-view (note editor) FULL-GRID sizing — the owner requirement:
// "when in clip-view mode the card should be tall enough to see the whole range
// of notes at once, and expand horizontally based on the clip length … up to
// 128 steps … we just always show the whole editable grid" (no Launchpad
// manipulation to reach a note/step).
//
// This is the deterministic DOM/layout gate for that behaviour (the pixel look
// is reviewed via VRT; the pure pitch-row math is unit-tested in
// clip-types.test.ts `editableRowRange`). It asserts, on the real card:
//   * clip-view shows EVERY editable pitch row (full range) — 57 rows for the
//     default major/C3 clip — and EVERY step (16, then 128 after ×2 ×2 ×2),
//   * the note grid has NO clipped/scrolled region (the card sizes to fit it),
//   * the card GROWS WIDER with the clip length (128-step ≫ 16-step), and grows
//     TALL enough to show the whole pitch range (far taller than its compact
//     3u session tier),
//   * leaving clip-view returns the card to its normal (compact) tier size.

import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

// Default clip = major scale from C3 → 57 editable scale-degree rows spanning
// MIN_MIDI..MAX_MIDI (editableRowRange, pinned in clip-types.test.ts). The card
// shows ALL of them at once, so this is the exact rendered row count.
const EXPECTED_ROWS = 57;
// Sub-pixel tolerance for the "no internal scroll" (grid fits the card) checks.
const SCROLL_TOL = 2;

const CARD = '.svelte-flow__node-clipplayer';

async function gridShape(page: Page): Promise<{ rows: number; cols: number; cells: number }> {
  return await page.getByTestId('clipplayer-pianoroll').evaluate((roll) => {
    const rows = Array.from(roll.querySelectorAll('.pr-row'));
    const cols = rows.length ? rows[0].querySelectorAll('.cell').length : 0;
    const cells = roll.querySelectorAll('.cell').length;
    return { rows: rows.length, cols, cells };
  });
}

/** scrollWidth/Height − clientWidth/Height: > 0 means content is clipped and a
 *  scroll region exists (which the whole feature exists to AVOID). */
async function overflow(loc: Locator): Promise<{ x: number; y: number }> {
  return await loc.evaluate((el) => ({
    x: el.scrollWidth - el.clientWidth,
    y: el.scrollHeight - el.clientHeight,
  }));
}

/** How far the note grid (piano-roll) spills PAST the card's right/bottom edges.
 *  The requirement is that the card sizes to fit the grid — the GRID must not
 *  exceed the card bounds. (The card's own scrollWidth is deliberately NOT
 *  asserted here: the always-shown title/transport chrome runs past the right
 *  edge on the narrow floor width — a PRE-EXISTING debt for which clipplayer is
 *  exempt in card-control-overflow.spec.ts — and is unrelated to the grid.) */
async function gridSpillPastCard(page: Page): Promise<{ right: number; bottom: number }> {
  return await page.evaluate(() => {
    const roll = document.querySelector('[data-testid="clipplayer-pianoroll"]');
    const card = document.querySelector('[data-testid="clipplayer-card"]');
    if (!roll || !card) return { right: 9999, bottom: 9999 };
    const r = roll.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return { right: r.right - c.right, bottom: r.bottom - c.bottom };
  });
}

async function cardBox(page: Page): Promise<{ w: number; h: number }> {
  const box = await page.getByTestId('clipplayer-card').boundingBox();
  if (!box) throw new Error('clipplayer card has no bounding box');
  return { w: box.width, h: box.height };
}

test('clip-view: whole editable grid is shown at once, card grows with clip length, no scroll', async ({
  page,
  rack,
}) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  const card = page.locator(CARD);
  await expect(card).toHaveCount(1);

  // Compact (session/grid) view = the normal fixed 3u/hp-2 tier (~540 tall).
  const compact = await cardBox(page);
  expect(compact.h, 'compact card is the normal 3u tier height').toBeLessThan(620);

  // Open clip 0's note editor (double-click its launch pad) → clip-view.
  await card.locator('[data-clip="0"]').dblclick();
  const roll = page.getByTestId('clipplayer-pianoroll');
  await expect(roll).toBeVisible();

  // ── SHORT clip (default 16 steps) ──────────────────────────────────────────
  const short = await gridShape(page);
  expect(short.rows, 'clip-view shows the FULL editable pitch range').toBe(EXPECTED_ROWS);
  expect(short.cols, 'default clip = 16 steps, every step shown').toBe(16);
  expect(short.cells, 'no missing cells (rows × cols)').toBe(EXPECTED_ROWS * 16);

  const rollShort = await overflow(roll);
  expect(rollShort.x, 'note grid: no horizontal clip/scroll (short)').toBeLessThanOrEqual(SCROLL_TOL);
  expect(rollShort.y, 'note grid: no vertical clip/scroll (short)').toBeLessThanOrEqual(SCROLL_TOL);
  const spillShort = await gridSpillPastCard(page);
  expect(spillShort.right, 'note grid fits within the card (short)').toBeLessThanOrEqual(SCROLL_TOL);
  expect(spillShort.bottom, 'note grid fits within the card (short)').toBeLessThanOrEqual(SCROLL_TOL);

  const shortBox = await cardBox(page);
  // Full pitch range → far taller than the compact 3u tier.
  expect(shortBox.h, 'clip-view card is tall enough for the whole pitch range').toBeGreaterThan(700);

  // ── LONG clip (×2 ×2 ×2 → 128 steps) ───────────────────────────────────────
  const dbl = page.getByTestId('clipplayer-double-cp');
  for (let i = 0; i < 3; i++) await dbl.click();
  // Wait for the grid to re-render at the new length.
  await expect
    .poll(async () => (await gridShape(page)).cols, { timeout: 5000 })
    .toBe(128);

  const long = await gridShape(page);
  expect(long.rows, 'row count unchanged by length (full range)').toBe(EXPECTED_ROWS);
  expect(long.cols, 'all 128 steps shown at once (cap)').toBe(128);
  expect(long.cells, 'no missing cells at 128 steps').toBe(EXPECTED_ROWS * 128);

  const rollLong = await overflow(roll);
  expect(rollLong.x, 'note grid: no horizontal clip/scroll (long)').toBeLessThanOrEqual(SCROLL_TOL);
  expect(rollLong.y, 'note grid: no vertical clip/scroll (long)').toBeLessThanOrEqual(SCROLL_TOL);
  const spillLong = await gridSpillPastCard(page);
  expect(spillLong.right, 'note grid fits within the card (long)').toBeLessThanOrEqual(SCROLL_TOL);
  expect(spillLong.bottom, 'note grid fits within the card (long)').toBeLessThanOrEqual(SCROLL_TOL);

  const longBox = await cardBox(page);
  // The card WIDENS with the clip length: a 128-step clip is much wider than a
  // 16-step one (the owner pans the canvas — the point is no board navigation).
  expect(longBox.w, '128-step card is much wider than the 16-step card').toBeGreaterThan(
    shortBox.w + 200,
  );

  // ── Leaving clip-view restores the compact tier ────────────────────────────
  await page.getByTestId('clipplayer-back').click();
  await expect(roll).toBeHidden();
  const restored = await cardBox(page);
  expect(restored.h, 'card returns to the compact tier height').toBeLessThan(620);
  expect(Math.abs(restored.w - compact.w)).toBeLessThan(4);
});
