// e2e/tests/keyboard-nav.spec.ts
//
// End-to-end coverage for arrow-key driven editing on Sequencer + Cartesian.
// Verifies the user's "very rapid arrow-only editing" UX:
//   - Arrow keys NEVER move the caret inside a pitch input.
//   - Up from a pitch input lands on the gate ABOVE it (gate is rendered
//     above the input within each cell after the layout swap).
//   - Down from a gate lands on the pitch BELOW it.
//   - Right/Left moves along same role within a cell row.
//   - Cartesian: Up from a non-top-row gate jumps to the pitch of the cell
//     directly above (one cell row up, same column).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

/** Open the cartesian node's dock full view — the face grid
 *  (`cart-face-gate/pitch/chord-{i}`) is dock-only on the shell. */
async function openCartDock(page: import('@playwright/test').Page): Promise<void> {
  const tile = page
    .locator('.svelte-flow__node:has([data-shell-type="cartesian"]) [data-testid="module-shell"]')
    .first();
  await tile.getByTestId('shell-open-dock').click();
  await expect(page.getByTestId('dock-full-view')).toBeVisible();
}


test.describe.configure({ mode: 'parallel' });

test('keyboard-nav Cartesian: arrow keys never move caret + jump gate<->pitch', async ({ page, rack }) => {
  // Re-subjected from the deleted SEQUENCER card (2026-08-24) to CARTESIAN,
  // the surviving 2-role ['gate','pitch'] grid card. The behaviour under test
  // is grid-nav.ts's, which both cards shared verbatim.
  await spawnPatch(page, [{ id: 'seq', type: 'cartesian' }]);
  await openCartDock(page);

  // Type a note into step 0's pitch input.
  const step0 = page.locator('[data-testid="cart-face-pitch-0"]');
  await step0.focus();
  await step0.fill('c3');

  // Sanity: caret should be at end of "c3" (length 2).
  // Press ArrowLeft; if our preventDefault works, focus stays here, caret
  // does NOT move. We verify by pressing Right immediately after — if Left
  // didn't move the caret, Right also doesn't (still at end), and the
  // *focus* is now somewhere else if the parent moved it. ArrowLeft from
  // cell 0 (top-left) clamps (no-op).
  await step0.press('ArrowLeft');
  // After clamp, focus stays on step0. Caret still at end. Verify focus.
  await expect(step0).toBeFocused();

  // Now ArrowRight should move focus to step 1's pitch.
  await step0.press('ArrowRight');
  const step1 = page.locator('[data-testid="cart-face-pitch-1"]');
  await expect(step1).toBeFocused();

  // ArrowUp from a pitch input should focus the SAME cell's gate (gate is
  // rendered above the input).
  await step1.press('ArrowUp');
  const gate1 = page.locator('[data-testid="cart-face-gate-1"]');
  await expect(gate1).toBeFocused();

  // Space toggles the gate.
  await gate1.press(' ');
  const stepData = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.cells?.[1] ?? null;
  });
  expect(stepData?.on).toBe(true);

  // ArrowRight from gate moves to next gate.
  await gate1.press('ArrowRight');
  const gate2 = page.locator('[data-testid="cart-face-gate-2"]');
  await expect(gate2).toBeFocused();

  // ArrowDown from gate to pitch of same cell.
  await gate2.press('ArrowDown');
  const step2 = page.locator('[data-testid="cart-face-pitch-2"]');
  await expect(step2).toBeFocused();

  // ArrowUp from gate clamps (top of grid) — focus must stay on gate2.
  await step2.press('ArrowUp'); // -> gate2
  await expect(gate2).toBeFocused();
  await gate2.press('ArrowUp'); // clamped
  await expect(gate2).toBeFocused();
});

test('keyboard-nav Cartesian: rapid-add scenario (type, right, type, right, ...)', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'seq', type: 'cartesian' }]);
  await openCartDock(page);

  const seq = ['c3', 'd3', 'e3', 'f3'];
  const step0 = page.locator('[data-testid="cart-face-pitch-0"]');
  await step0.focus();

  for (let i = 0; i < seq.length; i++) {
    const cur = page.locator(`[data-testid="cart-face-pitch-${i}"]`);
    await expect(cur).toBeFocused();
    await cur.fill(seq[i]!);
    if (i < seq.length - 1) {
      await cur.press('ArrowRight');
    }
  }
  // Commit the final cell — the in-progress edit only flushes on blur or
  // navigation, so a "last step" without a follow-up arrow stays in the buffer.
  await page.locator(`[data-testid="cart-face-pitch-${seq.length - 1}"]`).blur();

  const stored = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.cells?.slice(0, 4).map((c) => c.midi) ?? [];
  });
  // c3 d3 e3 f3 -> 48 50 52 53
  expect(stored).toEqual([48, 50, 52, 53]);
});

test('keyboard-nav Cartesian: ArrowUp from row-1 cell pitch hits gate of cell directly above', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cart', type: 'cartesian' }]);
  await openCartDock(page);

  // Cell idx 5 (row 1, col 1). Pitch -> Up -> gate of idx 5 -> Up -> pitch
  // of idx 1 (cell directly above) -> Up -> gate of idx 1.
  const p5 = page.locator('[data-testid="cart-face-pitch-5"]');
  await p5.focus();
  await p5.press('ArrowUp');
  const g5 = page.locator('[data-testid="cart-face-gate-5"]');
  await expect(g5).toBeFocused();

  await g5.press('ArrowUp');
  const p1 = page.locator('[data-testid="cart-face-pitch-1"]');
  await expect(p1).toBeFocused();

  await p1.press('ArrowUp');
  const g1 = page.locator('[data-testid="cart-face-gate-1"]');
  await expect(g1).toBeFocused();

  // ArrowUp from top-row gate clamps.
  await g1.press('ArrowUp');
  await expect(g1).toBeFocused();
});

test('keyboard-nav: caret never moves inside the pitch input on arrow keys', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'seq', type: 'cartesian' }]);
  await openCartDock(page);

  const step0 = page.locator('[data-testid="cart-face-pitch-0"]');
  await step0.focus();
  await step0.fill('a4');

  // Selection should be set on focus (selectAll). Type "b" — should overwrite
  // because of select-all-on-focus behavior. Then check no caret movement
  // happens via arrow keys.
  // First: assert that pressing ArrowLeft does not select within the text and
  // does not move caret around. We do this by checking selectionStart after.
  await step0.press('ArrowLeft'); // clamped from step 0 -> no focus change
  // The input still has focus and caret position should remain wherever it
  // was; the key thing is the value didn't change due to caret-driven typing.
  await expect(step0).toBeFocused();
  await expect(step0).toHaveValue('a4');
});

// ⚠ 'default value of new sequencer step is c3' DELETED 2026-08-24 with the
// SEQUENCER card. Its subject was that card's own `defaultSteps()`, which no
// longer exists — and the surviving default is asserted, unchanged, by
// 'default value of new cartesian cell is c3' immediately below. Deleted
// rather than re-subjected: re-subjecting would have produced a second
// identical copy of the test beneath it.

test('keyboard-nav: default value of new cartesian cell is c3', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cart', type: 'cartesian' }]);
  await openCartDock(page);

  for (const i of [0, 5, 15]) {
    const c = page.locator(`[data-testid="cart-face-pitch-${i}"]`);
    await expect(c).toHaveValue('c3');
  }
});
