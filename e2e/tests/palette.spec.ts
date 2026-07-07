// e2e/tests/palette.spec.ts
//
// Module-add palette: opens via right-click on an empty spot of the canvas
// pane (the production entry point — the topbar "+ Add module" button was
// removed by the 1024px topbar-overflow fix), filters by search, spawns the
// chosen module type into the patch graph.

import { test, expect } from './_fixtures';
import { openModulePalette } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('palette: pane right-click opens palette and spawns the chosen module', async ({ page, rack }) => {
  await openModulePalette(page);
  await expect(page.locator('.module-palette')).toBeVisible();
  // The palette has the search field focused — type to filter.
  await page.keyboard.type('Reverb');
  await page.getByRole('button', { name: 'reverb', exact: true }).click();
  await expect(page.locator('.svelte-flow__node-reverb')).toHaveCount(1);
  await expect(page.locator('.module-palette')).not.toBeVisible();
});

test('palette: Escape closes without spawning', async ({ page, rack }) => {
  await openModulePalette(page);
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.module-palette')).not.toBeVisible();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(0);
});

test('palette: Enter picks the first filtered match', async ({ page, rack }) => {
  await openModulePalette(page);
  // Scope is alphabetically first among Sc-prefix modules (Scope, Score), so
  // "Scop" uniquely matches Scope.
  await page.keyboard.type('Scop');
  await page.keyboard.press('Enter');
  await expect(page.locator('.svelte-flow__node-scope')).toHaveCount(1);
});

test('palette: right-click on canvas pane opens at cursor', async ({ page, rack }) => {
  // Right-click somewhere on the empty pane.
  const pane = page.locator('.svelte-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane');
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  // Spawn a module by drilling into the nested menu — the palette stays
  // positioned where it opened.
  await page.getByTestId('palette-top-audio-modules').click();
  await page.getByTestId('palette-sub-mixing').click();
  await page.getByTestId('palette-item-mixer').click();
  await expect(page.locator('.svelte-flow__node-mixer')).toHaveCount(1);
});
