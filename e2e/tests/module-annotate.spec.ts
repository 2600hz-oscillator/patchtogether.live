// e2e/tests/module-annotate.spec.ts
//
// On-canvas "Annotate" mode (living-docs). Proves the REAL flow on a LIVE module:
//   1. A module WITH authored docs (adsr) surfaces an "Annotate" entry in its
//      right-click menu; a module WITHOUT docs (analogVco) does NOT.
//   2. Toggling Annotate ON arms a hover lens: hovering a faceplate CONTROL pops
//      an anchored popover with that control's authored "what it does".
//   3. Opening the yellow patch panel + hovering a PORT pops the port's authored
//      doc — including the CV→param DUAL context ("modulates A …") for a CV input.
//   4. Toggling Annotate OFF makes the popover stop appearing (back to normal).
//
// It exercises the REAL module on the canvas (not a re-render / copy / modal):
// the same card, the same patch panel, just an extra personal hover lens.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

/** Spawn one module by type via the Add-module palette search. */
async function spawnModule(page: import('@playwright/test').Page, type: string, label: string) {
  await page.getByRole('button', { name: '+ Add module' }).click();
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.keyboard.type(label);
  await page.getByTestId(`palette-item-${type}`).click();
  await expect(page.locator(`.svelte-flow__node-${type}`)).toHaveCount(1);
}

/** Open the module right-click menu by right-clicking the card title bar. */
async function openModuleMenu(page: import('@playwright/test').Page, type: string) {
  await page.locator(`.svelte-flow__node-${type}`).first().locator('.title').click({ button: 'right' });
  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await expect(menu).toBeVisible();
  return menu;
}

test('documented module (adsr): Annotate entry toggles a hover popover over a control', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnModule(page, 'adsr', 'adsr');

  // 1) The Annotate entry exists for a documented module.
  let menu = await openModuleMenu(page, 'adsr');
  const annotate = menu.getByTestId('ctx-annotate');
  await expect(annotate).toBeVisible();
  await expect(annotate).toHaveText(/Annotate$/); // not yet checked

  // 2) Turn it ON.
  await annotate.click();
  await expect(menu).toBeHidden();
  // The "mode is on" cue shows.
  await expect(page.getByTestId('annotate-badge')).toBeVisible();

  // 3) Hover the ATTACK fader → popover with the authored control prose.
  const attackControl = page.locator('[data-testid="control-attack"]').first();
  await attackControl.hover();
  const popover = page.getByTestId('annotate-popover');
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId('annotate-name')).toHaveText('A'); // ParamDef label
  // Authored desc text (adsr attack: "...rise from 0 to its peak...").
  await expect(popover.getByTestId('annotate-desc')).toContainText(/rise/i);

  // 4) Toggle OFF → the popover stops appearing.
  menu = await openModuleMenu(page, 'adsr');
  await expect(menu.getByTestId('ctx-annotate')).toHaveText(/Annotate ✓/); // shows ON
  await menu.getByTestId('ctx-annotate').click();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('annotate-badge')).toBeHidden();
  // Move away then back over the control — no popover now.
  await page.mouse.move(5, 5);
  await attackControl.hover();
  await expect(page.getByTestId('annotate-popover')).toHaveCount(0);
});

test('documented module (adsr): hovering a PATCH PORT shows its doc incl. the CV→param dual context', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnModule(page, 'adsr', 'adsr');

  // Turn Annotate ON.
  const menu = await openModuleMenu(page, 'adsr');
  await menu.getByTestId('ctx-annotate').click();
  await expect(menu).toBeHidden();

  // Open the yellow patch panel → drill into INPUT.
  const card = page.locator('.svelte-flow__node-adsr').first();
  await card.getByTestId('patch-trigger').click();
  await expect(page.getByTestId('patch-panel')).toBeVisible();
  await page.locator('[data-testid="patch-panel-nav"][data-nav="inputs"]').click();
  await expect(page.getByTestId('patch-panel-inputs')).toBeVisible();

  // Hover the `attack` CV input port row (lives in the PORTALED chrome).
  const attackRow = page
    .locator('[data-testid="patch-panel-port-row"][data-port-id="attack"][data-direction="input"]')
    .first();
  await attackRow.hover();

  const popover = page.getByTestId('annotate-popover');
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId('annotate-name')).toHaveText(/attack/i);
  // The DUAL context: this CV jack modulates the A control + carries its prose.
  const dual = popover.getByTestId('annotate-dual');
  await expect(dual).toBeVisible();
  await expect(dual).toContainText('modulates');
  await expect(dual).toContainText('A');

  // Screenshot proof of an anchored popover over a hovered port.
  await page.screenshot({ path: 'test-results/module-annotate-port-popover.png' });
});

test('undocumented module (toybox): NO Annotate entry', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // toybox is the PERMANENT docs exemption (never authored — see the coverage
  // ratchet), so it stays the stable "no authored docs" fixture as the rollout
  // documents every other module. analogVco used to be here but is now
  // documented (batch 1), which would (correctly) surface an Annotate entry.
  await spawnModule(page, 'toybox', 'toybox');

  const menu = await openModuleMenu(page, 'toybox');
  // Docs (external page) is always present; the on-canvas Annotate entry is
  // gated on authored docs, so it must be absent for the exempt module.
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Docs' })).toBeVisible();
  await expect(menu.getByTestId('ctx-annotate')).toHaveCount(0);
});
