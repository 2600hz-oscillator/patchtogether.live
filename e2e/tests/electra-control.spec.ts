// e2e/tests/electra-control.spec.ts
//
// ELECTRA CONTROL — the full behavioral loop for the fixed 6×6 Electra-laid-out
// control surface:
//   1. spawn an ElectraControl + a source (ADSR). The card shows the
//      DETERMINISTIC empty 36-slot grid, grouped TOP / MID / BOT; empties empty.
//   2. right-click the ADSR's Attack control → "Send to <electra>" → Row2 → 2.
//      Assert node.data.slots["7"] == {moduleId, paramId} (slotIndex(2,2)=7) and
//      the (row2, knob2) grid cell renders the proxied Knob.
//   3. edit the slot label inline (✎) → the binding's `name` persists.
//   4. assign a SECOND control to Row6 → 6 (slotIndex(6,6)=35, rightmost-bottom).
//   5. proxy proof: the proxied Knob writes the SOURCE's live param (shared
//      moduleId:paramId). Then clear the slot via the control menu → cell empties.
//
// Flash is asserted PURELY (no device) by the unit test
// (electra-control.test.ts → generatePreset over the fixed slots places each at
// the right (controlSetId, potId, bounds) + clamps the custom name) — physical
// flash can't run in CI.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

async function readSlots(page: Page, electraId: string) {
  return await page.evaluate((id) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    const data = w.__patch.nodes[id]?.data as { slots?: Record<string, unknown> } | undefined;
    return data?.slots ?? null;
  }, electraId);
}

async function setup(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'ec-1', type: 'electraControl', position: { x: 700, y: 60 }, domain: 'meta' },
    { id: 'adsr-1', type: 'adsr', position: { x: 60, y: 60 }, domain: 'audio' },
  ]);
}

test('send a control to a fixed (row, knob) slot → grid renders it, label persists, proxy drives source, clear empties', async ({ page }) => {
  await setup(page);

  const card = page.locator('[data-testid="electra-control-card"][data-node-id="ec-1"]');
  await expect(card).toBeVisible();

  // The fixed 36-slot grid is always present, grouped into 3 banks.
  await expect(card.locator('[data-testid="electra-control-bank-TOP"]')).toBeVisible();
  await expect(card.locator('[data-testid="electra-control-bank-MID"]')).toBeVisible();
  await expect(card.locator('[data-testid="electra-control-bank-BOT"]')).toBeVisible();
  await expect(card.locator('[data-testid^="electra-control-slot-"]')).toHaveCount(36);
  // All 36 slots are empty on a fresh ElectraControl.
  await expect(card.locator('[data-testid^="electra-control-slot-"][data-filled="true"]')).toHaveCount(0);
  await expect(card.locator('[data-testid="electra-control-slot-2-2"]')).toHaveAttribute('data-filled', 'false');

  // Right-click ADSR Attack → control menu → Send to <electra> → Row2 → 2.
  const adsr = page.locator('.svelte-flow__node-adsr');
  const attack = adsr.locator('[role="slider"][aria-label="Attack"]');
  await expect(attack).toBeVisible();
  await attack.click({ button: 'right' });

  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  // Open the 3-level flyout: Send to <electra> → Row2 → knob 2.
  await menu.locator('[data-testid="ctx-electra-ec-1"]').click();
  await menu.locator('[data-testid="ctx-electra-ec-1-row-2"]').click();
  await menu.locator('[data-testid="ctx-electra-ec-1-row-2-knob-2"]').click();

  // slotIndex(2,2) = (2-1)*6 + (2-1) = 7.
  await expect.poll(async () => await readSlots(page, 'ec-1')).toEqual({
    '7': { moduleId: 'adsr-1', paramId: 'attack' },
  });

  // The (row2, knob2) grid cell now renders the proxied control.
  const slot22 = card.locator('[data-testid="electra-control-slot-2-2"]');
  await expect(slot22).toHaveAttribute('data-filled', 'true');
  await expect(slot22.locator('[role="slider"]')).toBeVisible();

  // Edit the slot label inline (✎) → the binding's `name` persists in node.data.
  await slot22.locator('[data-testid="electra-control-rename-2-2"]').click();
  const renameInput = slot22.locator('[data-testid="electra-control-rename-input-2-2"]');
  await expect(renameInput).toBeVisible();
  await renameInput.fill('Punch');
  await renameInput.press('Enter');
  await expect.poll(async () => await readSlots(page, 'ec-1')).toEqual({
    '7': { moduleId: 'adsr-1', paramId: 'attack', name: 'Punch' },
  });
  await expect(slot22).toContainText('Punch');

  // Assign a SECOND control to Row6 → 6 = slotIndex(6,6) = 35 (rightmost-bottom,
  // BOTTOM bank). Use the ADSR's Decay control.
  const decay = adsr.locator('[role="slider"][aria-label="Decay"]');
  await decay.click({ button: 'right' });
  await expect(page.locator('[data-testid="control-context-menu"]')).toBeVisible();
  await page.locator('[data-testid="ctx-electra-ec-1"]').click();
  await page.locator('[data-testid="ctx-electra-ec-1-row-6"]').click();
  await page.locator('[data-testid="ctx-electra-ec-1-row-6-knob-6"]').click();
  await expect.poll(async () => Object.keys((await readSlots(page, 'ec-1')) ?? {}).sort()).toEqual(['35', '7']);
  await expect(card.locator('[data-testid="electra-control-slot-6-6"]')).toHaveAttribute('data-filled', 'true');

  // Proxy proof: push the SOURCE param off-default, reset via the PROXY
  // (double-click) — the source param must change (the proxy writes the source).
  await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    w.__patch.nodes['adsr-1'].params.attack = 0.9;
  });
  await slot22.locator('[role="slider"]').dblclick();
  const attackAfter = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return w.__patch.nodes['adsr-1'].params.attack;
  });
  expect(attackAfter).not.toBe(0.9); // proxy reset the SOURCE to its default

  // Clear the Row2→2 slot via the proxy's OWN control menu ("Remove from").
  await slot22.locator('[role="slider"]').click({ button: 'right' });
  const menu2 = page.locator('[data-testid="control-context-menu"]');
  await expect(menu2).toBeVisible();
  const clearItem = menu2.locator('[data-testid="ctx-electra-ec-1-clear"]');
  await expect(clearItem).toContainText('Remove from');
  await clearItem.click();
  // Only the Row6→6 binding remains; the (row2, knob2) cell is empty again.
  await expect.poll(async () => Object.keys((await readSlots(page, 'ec-1')) ?? {})).toEqual(['35']);
  await expect(card.locator('[data-testid="electra-control-slot-2-2"]')).toHaveAttribute('data-filled', 'false');
});
