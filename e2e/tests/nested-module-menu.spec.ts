// e2e/tests/nested-module-menu.spec.ts
//
// Nested "Add module" palette — verifies the 2-level hierarchy renders,
// drilling into each top category surfaces its sub-categories, and
// clicking an item spawns the corresponding module. One pass per top
// category (Audio modules / Video modules / Hybrid) so the basic shape
// of the menu is covered end-to-end.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

test('nested palette: top-level rows render and are collapsed by default', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add module' }).click();
  await expect(page.locator('.module-palette')).toBeVisible();

  // All three top categories are visible.
  await expect(page.getByTestId('palette-top-audio-modules')).toBeVisible();
  await expect(page.getByTestId('palette-top-video-modules')).toBeVisible();
  await expect(page.getByTestId('palette-top-hybrid')).toBeVisible();

  // Sub-categories aren't visible until the top is expanded.
  await expect(page.getByTestId('palette-sub-vcos')).toHaveCount(0);
  await expect(page.getByTestId('palette-item-analogVco')).toHaveCount(0);
});

test('nested palette: Audio modules → VCOs → spawn Analog VCO', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add module' }).click();

  await page.getByTestId('palette-top-audio-modules').click();
  await expect(page.getByTestId('palette-sub-vcos')).toBeVisible();
  await page.getByTestId('palette-sub-vcos').click();
  await page.getByTestId('palette-item-analogVco').click();

  await expect(page.locator('.svelte-flow__node-analogVco')).toHaveCount(1);
  await expect(page.locator('.module-palette')).not.toBeVisible();
});

test('nested palette: Video modules → Sources → spawn LINES', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add module' }).click();

  await page.getByTestId('palette-top-video-modules').click();
  await expect(page.getByTestId('palette-sub-sources')).toBeVisible();
  await page.getByTestId('palette-sub-sources').click();
  await page.getByTestId('palette-item-lines').click();

  await expect(page.locator('.svelte-flow__node-lines')).toHaveCount(1);
});

test('nested palette: Hybrid → SCOPE spawns directly (flat sub-list)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add module' }).click();

  await page.getByTestId('palette-top-hybrid').click();
  // Hybrid is flat — the item shows up without an intermediate sub click.
  await page.getByTestId('palette-item-scope').click();

  await expect(page.locator('.svelte-flow__node-scope')).toHaveCount(1);
});

test('nested palette: typing flattens to search-mode results', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add module' }).click();

  // Drill in first to ensure search clears the drill-down state.
  await page.getByTestId('palette-top-audio-modules').click();

  // Re-focus the search input — clicking the top-row button moved focus.
  await page.locator('.module-palette input').click();
  // Typing should collapse the nested view and show flat filtered results.
  await page.keyboard.type('Reverb');
  await expect(page.getByTestId('palette-top-audio-modules')).toHaveCount(0);

  // Enter picks the first match — preserving the original keyboard flow.
  await page.keyboard.press('Enter');
  await expect(page.locator('.svelte-flow__node-reverb')).toHaveCount(1);
});
