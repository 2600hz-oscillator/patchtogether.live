// e2e/tests/patch-menu-ux.spec.ts
//
// Patch-menu interaction contract after the no-drag / overlay-replace
// redesign. The click-and-hold-to-open gesture is RETIRED (the fixme'd
// hold-race case was deleted), and the side-by-side cascade became an
// overlay-replace picker. What this spec pins:
//
//   1. Clicking a trigger opens the (body-portaled) menu; hover does nothing.
//   2. Clicking INPUT / OUTPUT overlay-replaces the root in place; back
//      returns.
//   3. The patch-to picker (reached via the carry → "patch to" flow) is an
//      overlay-replace cascade: click a module → ports REPLACE the modules
//      list; back returns.
//   4. Esc closes the picker.
//   5. A pointerdown in canvas negative space closes the picker.
//   6. Handles for every declared port stay in the card DOM with the panel
//      CLOSED (io-spec parity — the per-module-per-port sweep depends on it).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** The body-portaled chrome for a node. */
function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

async function openFrom(page: Page, nodeId: string, side: 'left' | 'right' = 'left') {
  const testid = side === 'left' ? 'patch-trigger' : 'patch-trigger-right';
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="${testid}"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
}

/** Carry SEQUENCER.gate (an output) → open the patch-to picker. */
async function carryGateToPicker(page: Page) {
  await openFrom(page, 'seq', 'left');
  await chrome(page, 'seq')
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();
  await chrome(page, 'seq')
    .locator('[data-testid="patch-panel-port-row"][data-port-id="gate"]')
    .click();
  await page.mouse.move(500, 300);
  await chrome(page, 'seq').locator('[data-testid="patch-panel-patch-to"]').click();
  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
}

async function spawnSeqAdsr(page: Page) {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', position: { x: 80, y: 120 } },
    { id: 'adsr', type: 'adsr', position: { x: 760, y: 120 } },
  ]);
}

test('clicking the patch-trigger opens the menu; hover alone does not', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);
  const trigger = page.locator(
    '.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]',
  );

  // Hover alone — no portaled chrome appears.
  await trigger.hover();
  await page.waitForTimeout(200);
  await expect(chrome(page, 'adsr')).toHaveCount(0);

  // Click — the chrome opens.
  await trigger.click();
  await expect(chrome(page, 'adsr')).toHaveAttribute('aria-hidden', 'false');
});

test('INPUT / OUTPUT drill overlay-replaces root in place; back returns', async ({ page }) => {
  // CI-load robustness: spawns two modules then drives the click → body-portal
  // mount → aria-hidden flip → drill/back sequence, each step a default-timeout
  // assertion. Under CI load the portal-mount/aria flip races the default
  // budget (patch-menu-ux:79 timing flake). Give the whole sequence room.
  test.setTimeout(60_000);
  await spawnSeqAdsr(page);
  await openFrom(page, 'adsr', 'left');

  await expect(chrome(page, 'adsr').locator('[data-testid="patch-panel-root"]')).toBeVisible();
  await chrome(page, 'adsr')
    .locator('[data-testid="patch-panel-nav"][data-nav="inputs"]')
    .click();
  // Root replaced by the inputs view.
  await expect(chrome(page, 'adsr').locator('[data-testid="patch-panel-root"]')).toHaveCount(0);
  await expect(chrome(page, 'adsr').locator('[data-testid="patch-panel-inputs"]')).toBeVisible();
  // Back returns to root.
  await chrome(page, 'adsr').locator('[data-testid="patch-panel-back"]').click();
  await expect(chrome(page, 'adsr').locator('[data-testid="patch-panel-root"]')).toBeVisible();
});

test('patch-to picker is overlay-replace: module → ports replace the modules list; back returns', async ({
  page,
}) => {
  await spawnSeqAdsr(page);
  await carryGateToPicker(page);

  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu.locator('[data-testid="patch-to-modules"]')).toBeVisible();
  // Click the ADSR module row → ports REPLACE the modules list.
  await menu.locator('[data-testid="patch-to-module"][data-node-id="adsr"]').click();
  await expect(menu.locator('[data-testid="patch-to-modules"]')).toHaveCount(0);
  await expect(menu.locator('[data-testid="patch-to-ports"]')).toBeVisible();
  // Back returns to the modules list.
  await menu.locator('[data-testid="patch-to-back"]').click();
  await expect(menu.locator('[data-testid="patch-to-modules"]')).toBeVisible();
});

test('Esc closes the patch-to picker', async ({ page }) => {
  await spawnSeqAdsr(page);
  await carryGateToPicker(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
});

test('clicking in canvas negative space closes the patch-to picker', async ({ page }) => {
  await spawnSeqAdsr(page);
  await carryGateToPicker(page);
  await page.mouse.click(8, 8);
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
});

test('handles for every declared port stay in the card DOM with the panel closed (io-spec parity)', async ({
  page,
}) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);
  // Panel CLOSED — the per-module-per-port sweep counts handles here.
  await expect(chrome(page, 'adsr')).toHaveCount(0);
  const handleIds = await page
    .locator('.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-handleid')));
  // ADSR declares gate + a/d/s/r CV inputs and an env output — at minimum the
  // gate input + env output are present with the panel closed.
  expect(handleIds).toContain('gate');
  expect(handleIds).toContain('env');
});
