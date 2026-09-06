// e2e/tests/cloudseed.spec.ts
//
// CLOUDSEED end-to-end smoke on the shell the user gets. The card's 4-slot
// preset strip + name/DECAY readouts became: the dock ladder's
// `control-preset_index` radiogroup (selection), the TILE's preset knob
// whose aria-valuetext speaks the preset NAME, and the decay slider whose
// aria-valuetext is the same def-formatted seconds the card readout printed.
// The card's prev/next wrap-around arrows were a card-only affordance and
// died with it (S2 ledger manifest); selection itself is covered here.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('CLOUDSEED presets drive the name + DECAY the def prints (dock radiogroup → tile aria)', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [{ id: 'a-cs', type: 'cloudseed', position: { x: 100, y: 100 } }],
    [],
  );

  const tile = page.locator('.svelte-flow__node[data-id="a-cs"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();

  const name = tile.getByTestId('control-preset_index');
  const decay = tile.getByTestId('control-late_line_decay');
  await expect(name).toHaveAttribute('aria-valuetext', /divine inspiration/i);
  const startDecay = await decay.getAttribute('aria-valuetext');

  await tile.getByTestId('shell-open-dock').click();
  const dock = page.getByTestId('dock-full-view');
  await expect(dock).toBeVisible();
  const slots = dock.getByTestId('control-preset_index').locator('[role="radio"]');
  await expect(slots).toHaveCount(4);

  // Slot 1 (SHORT ROOM): name follows, decay moves.
  await slots.nth(1).click();
  await expect(name).toHaveAttribute('aria-valuetext', /short room/i);
  const shortDecay = await decay.getAttribute('aria-valuetext');
  expect(shortDecay).not.toBe(startDecay);

  // Slot 3 (INFINITE PAD) — longest tail; decay moves again.
  await slots.nth(3).click();
  await expect(name).toHaveAttribute('aria-valuetext', /infinite pad/i);
  const infDecay = await decay.getAttribute('aria-valuetext');
  expect(infDecay).not.toBe(shortDecay);

  // Back to slot 0: the full cycle lands where it started.
  await slots.nth(0).click();
  await expect(name).toHaveAttribute('aria-valuetext', /divine inspiration/i);
});
