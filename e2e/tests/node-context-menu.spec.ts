// e2e/tests/node-context-menu.spec.ts
//
// Right-click on a module card opens a context menu. Two actions:
//   - Delete: removes node + every edge touching it
//   - Unpatch all: keeps node, removes every edge touching it

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

test('node context menu: right-click opens, Escape closes', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Spawn voice demo' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  // Right-click on the VCO card.
  const vco = page.locator('.svelte-flow__node-analogVco').first();
  await vco.click({ button: 'right' });

  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toHaveCount(0);
});

test('node context menu: Delete removes the node + all edges touching it', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Spawn voice demo' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(6);

  // Right-click on the VCA card. VCA touches 3 edges:
  //   vco.sine → vca.audio
  //   adsr.env → vca.cv
  //   vca.audio → out.L
  //   vca.audio → out.R   (so 4 actually — vd-vca is the hub)
  const vca = page.locator('.svelte-flow__node-vca').first();
  await vca.click({ button: 'right' });

  await page.locator('[role="menuitem"]', { hasText: 'Delete' }).click();

  await expect(page.locator('.svelte-flow__node-vca')).toHaveCount(0);
  await expect(page.locator('.svelte-flow__node')).toHaveCount(4);
  // 6 starting edges − 4 touching VCA = 2 remaining (seq.pitch→vco, seq.gate→adsr)
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);
});

test('node context menu: Unpatch all keeps the node, removes only edges touching it', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Spawn voice demo' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(6);

  const vca = page.locator('.svelte-flow__node-vca').first();
  await vca.click({ button: 'right' });

  await page.locator('[role="menuitem"]', { hasText: 'Unpatch all' }).click();

  // Node count unchanged
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5);
  await expect(page.locator('.svelte-flow__node-vca')).toHaveCount(1);
  // 6 starting edges − 4 touching VCA = 2 remaining
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);
});
