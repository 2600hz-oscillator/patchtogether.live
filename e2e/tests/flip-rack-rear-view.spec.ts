// e2e/tests/flip-rack-rear-view.spec.ts
//
// Rack Phase 3 — "Flip rack" (rear view).
//
// The Flip rack toggle (top of the SvelteFlow Controls panel) flips EVERY card
// over its own Y axis IN PLACE to reveal a back panel of patch jacks, so the
// user can trace wiring from behind. It's LOCAL view state (a $state boolean in
// Canvas) — not synced, not per-node, one global toggle.
//
// This spec asserts the observable contract:
//   1. The button exists with the right aria-label and starts un-pressed.
//   2. Toggling ON adds the `.rear-view` class to the flow container and reveals
//      a visible back-panel jack element for a card.
//   3. The card does NOT move (the node stays at the same canvas position — the
//      flip is "in place", not a whole-rack mirror).
//   4. Toggling OFF removes the class and hides the back panel again.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('flip-rack: toggle reveals per-card back panels in place, then hides them', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // A tiny 2-card patch is enough — the toggle is global.
  await spawnPatch(
    page,
    [
      { id: 'adsr', type: 'adsr', position: { x: 120, y: 120 } },
      { id: 'vca', type: 'vca', position: { x: 460, y: 120 } },
    ],
    [],
  );
  await expect(page.locator('.svelte-flow__node')).toHaveCount(2);

  const flow = page.locator('.flow');
  const flipBtn = page.getByRole('button', { name: 'Flip rack (rear view)' });
  await expect(flipBtn).toBeVisible();
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');

  // Back panels exist in the DOM at all times (so the CSS 3D flip can reveal
  // them) but are display:none until rear view → not visible yet.
  const adsrBack = page
    .locator('.svelte-flow__node[data-id="adsr"]')
    .getByTestId('card-back-panel');
  await expect(adsrBack).toHaveCount(1);
  await expect(adsrBack).toBeHidden();

  // Record the node's canvas position before flipping — "in place" means it must
  // not change when we flip.
  const beforeBox = await page.locator('.svelte-flow__node[data-id="adsr"]').boundingBox();
  expect(beforeBox).not.toBeNull();

  // Toggle ON.
  await flipBtn.click();
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(flow).toHaveClass(/rear-view/);

  // The back panel is now visible and shows the module name + jack labels.
  await expect(adsrBack).toBeVisible();
  await expect(
    page.locator('.svelte-flow__node[data-id="adsr"]').getByTestId('card-back-title'),
  ).toBeVisible();
  // ADSR declares a GATE input + ENV output → at least one jack hole renders.
  await expect(adsrBack.locator('.back-jack .jack-hole').first()).toBeVisible();
  // The verbose jack label for the gate input shows on the back.
  await expect(adsrBack.getByText('GATE', { exact: true })).toBeVisible();

  // The node did NOT move (flip is in place, not a whole-rack mirror). Allow a
  // sub-pixel tolerance for layout rounding.
  const afterBox = await page.locator('.svelte-flow__node[data-id="adsr"]').boundingBox();
  expect(afterBox).not.toBeNull();
  expect(Math.abs(afterBox!.x - beforeBox!.x)).toBeLessThan(2);
  expect(Math.abs(afterBox!.y - beforeBox!.y)).toBeLessThan(2);

  // Both cards flip (global toggle) — the VCA back panel is visible too.
  await expect(
    page.locator('.svelte-flow__node[data-id="vca"]').getByTestId('card-back-panel'),
  ).toBeVisible();

  // Toggle OFF → back to front.
  await flipBtn.click();
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(flow).not.toHaveClass(/rear-view/);
  await expect(adsrBack).toBeHidden();
});

test('flip-rack: the Tab key flips the rack front↔rear', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 120, y: 120 } }], []);
  await expect(page.locator('.svelte-flow__node')).toHaveCount(1);

  const flow = page.locator('.flow');
  const flipBtn = page.getByRole('button', { name: 'Flip rack (rear view)' });
  await expect(flow).not.toHaveClass(/rear-view/);

  // Tab on the canvas (nothing text-editable focused) → rear view ON.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Tab');
  await expect(flow).toHaveClass(/rear-view/);
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'true');

  // Tab again → back to front.
  await page.keyboard.press('Tab');
  await expect(flow).not.toHaveClass(/rear-view/);
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');
});
