// e2e/tests/clipplayer-clip-view-grid.spec.ts
//
// CLIP PLAYER note-editor FULL-GRID rendering — the surviving half of the owner
// requirement: "we just always show the whole editable grid" (no Launchpad
// manipulation to reach a note/step). The dock full view's piano roll renders
// EVERY editable pitch row (57 for the default major/C3 clip — pinned in
// clip-types.test.ts `editableRowRange`) and EVERY step (16, then 128 after
// ×2 ×2 ×2) as real cells, so no note is unreachable.
//
// ⚠ WHAT DIED WITH THE CARD (S2 legacy-removal manifest): the card-GEOMETRY
// half — "the card grows taller/wider with the clip and returns to its compact
// tier on exit". The dock full view is a fixed surface the roll scrolls inside;
// there is no card tier to grow or restore. The row/step math is unit-tested;
// the cell-grid presence on the face is also pinned by face-clipplayer's
// editor-band leg.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

// Default clip = major scale from C3 → 57 editable scale-degree rows spanning
// MIN_MIDI..MAX_MIDI (editableRowRange, pinned in clip-types.test.ts). The roll
// renders ALL of them at once, so this is the exact rendered row count.
const EXPECTED_ROWS = 57;

async function gridShape(page: Page): Promise<{ rows: number; cols: number; cells: number }> {
  return await page.getByTestId('clipplayer-pianoroll').evaluate((roll) => {
    const rows = Array.from(roll.querySelectorAll('.pr-row'));
    const cols = rows.length ? rows[0].querySelectorAll('.cell').length : 0;
    const cells = roll.querySelectorAll('.cell').length;
    return { rows: rows.length, cols, cells };
  });
}

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body was re-pointed at the
// dock full view by the S2 legacy-removal inversion (the full-grid rendering
// claims survive; the card-tier sizing claims died with the card — see header).
// NONDETERMINISM: 5 recovered-on-retry observation(s) across 5 SHA(s) / 3 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: the owner requirement that the editor shows the WHOLE editable grid at once — a regression reintroduces the scroll-hunt for a note the feature was built to remove.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('note editor: whole editable grid is rendered at once and grows with clip length', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 5 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({
  page,
  rack,
}) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  const tile = page.locator('.svelte-flow__node[data-id="cp"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  await tile.getByTestId('shell-open-dock').click();
  const dock = page.getByTestId('dock-full-view');
  await expect(dock).toBeVisible();

  // Bind clip 0's note editor (double-click its launch pad).
  await dock.locator('[data-clip="0"]').dblclick();
  const roll = page.getByTestId('clipplayer-pianoroll');
  await expect(roll).toBeVisible();

  // ── SHORT clip (default 16 steps) ──────────────────────────────────────────
  const short = await gridShape(page);
  expect(short.rows, 'the editor renders the FULL editable pitch range').toBe(EXPECTED_ROWS);
  expect(short.cols, 'default clip = 16 steps, every step rendered').toBe(16);
  expect(short.cells, 'no missing cells (rows × cols)').toBe(EXPECTED_ROWS * 16);

  // ── LONG clip (×2 ×2 ×2 → 128 steps) ───────────────────────────────────────
  const dbl = dock.getByTestId('clipplayer-double-cp');
  await dbl.scrollIntoViewIfNeeded();
  for (let i = 0; i < 3; i++) await dbl.click();
  // Wait for the grid to re-render at the new length.
  await expect
    .poll(async () => (await gridShape(page)).cols, { timeout: 5000 })
    .toBe(128);

  const long = await gridShape(page);
  expect(long.rows, 'row count unchanged by length (full range)').toBe(EXPECTED_ROWS);
  expect(long.cols, 'all 128 steps rendered at once (cap)').toBe(128);
  expect(long.cells, 'no missing cells at 128 steps').toBe(EXPECTED_ROWS * 128);
});
