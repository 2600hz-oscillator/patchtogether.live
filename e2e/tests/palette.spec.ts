// e2e/tests/palette.spec.ts
//
// Module-add palette: opens via topbar button + right-click on canvas pane,
// filters by search, spawns the chosen module type into the patch graph.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

test('palette: + Add module button opens palette and spawns the chosen module', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add module' }).click();
  await expect(page.locator('.module-palette')).toBeVisible();
  // The palette has the search field focused — type to filter.
  await page.keyboard.type('Reverb');
  await page.getByRole('button', { name: 'Reverb', exact: true }).click();
  await expect(page.locator('.svelte-flow__node-reverb')).toHaveCount(1);
  await expect(page.locator('.module-palette')).not.toBeVisible();
});

test('palette: Escape closes without spawning', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add module' }).click();
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.module-palette')).not.toBeVisible();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(0);
});

test('palette: Enter picks the first filtered match', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add module' }).click();
  // Scope is alphabetically first among Sc-prefix modules (Scope, Score), so
  // "Scop" uniquely matches Scope.
  await page.keyboard.type('Scop');
  await page.keyboard.press('Enter');
  await expect(page.locator('.svelte-flow__node-scope')).toHaveCount(1);
});

test('palette: right-click on canvas pane opens at cursor', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Right-click somewhere on the empty pane.
  const pane = page.locator('.svelte-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane');
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  // Spawn a module — the palette stays positioned where it opened.
  await page.getByRole('button', { name: 'Mixer', exact: true }).click();
  await expect(page.locator('.svelte-flow__node-mixer')).toHaveCount(1);
});
