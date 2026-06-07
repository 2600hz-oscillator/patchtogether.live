// e2e/tests/node-context-menu.spec.ts
//
// Right-click on a module card opens a context menu. Two actions:
//   - Delete: removes node + every edge touching it
//   - Unpatch all: keeps node, removes every edge touching it

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('node context menu: right-click opens, Escape closes', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  // Right-click on the VCO card BACKGROUND (its title bar). Right-clicking a
  // knob/fader now opens the per-control MIDI menu instead, so we target a
  // non-control region to reach the module menu.
  const vco = page.locator('.svelte-flow__node-analogVco').first();
  await vco.locator('.title').click({ button: 'right' });

  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toHaveCount(0);
});

test('node context menu: Delete removes the node + all edges touching it', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
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
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
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

test('node context menu: TOYBOX hides "Unpatch all" (node-map module) but keeps Docs/Duplicate/Delete', async ({ page }) => {
  // TOYBOX is a node-map module — its in-card combine editor owns disconnects,
  // so the generic card menu's "Unpatch all" is hidden for type==='toybox'.
  //
  // TOYBOX is itself a WebGL-heavy card (live video layers + combine editor).
  // On CI's SwiftShader software renderer at 1024×768 (#662, 2.56× the pixels
  // of 640×480) its first-paint + menu interaction overruns the default 30s
  // test budget: the menu DOES open + render correctly (the Unpatch-absent /
  // Docs / Duplicate assertions pass), but the slow heavy page burns the clock
  // before the final assertion settles. Give the heavy card headroom.
  test.setTimeout(90_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  const card = page.locator('.svelte-flow__node-toybox').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Right-click the card title (a non-control region) to open the module menu.
  await card.locator('.title').click({ button: 'right' });
  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await expect(menu).toBeVisible();

  // Unpatch all is ABSENT; Docs / Duplicate / Delete are present.
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Unpatch all' })).toHaveCount(0);
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Docs' })).toHaveCount(1);
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Duplicate' })).toHaveCount(1);
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Delete' })).toHaveCount(1);
});
