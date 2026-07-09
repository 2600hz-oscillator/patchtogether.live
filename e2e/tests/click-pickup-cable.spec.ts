// e2e/tests/click-pickup-cable.spec.ts
//
// Jack-click → pickup (carry) gesture on a port ROW.
//
// The no-drag redesign RETIRED cable dragging entirely (the old
// drag-vs-click differentiation is gone — handles are pointer-events:none
// in the card DOM, used only as cable anchors + the per-port sweep target).
// The surviving gesture: clicking a port ROW in the open menu picks up a
// cable that sticks to the cursor (connectDragState mode='pickup' with
// pickupMenuOpen), follows the cursor on move, and is consumed by the
// patch-to / carry-commit flow or discarded by Esc.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

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

async function readPickupState(page: Page): Promise<{
  mode: string;
  active: boolean;
  sourcePortId: string | null;
  menuOpen: boolean;
}> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __connectDragState?: {
        mode: string;
        active: boolean;
        pickupSource: { portId: string } | null;
        pickupMenuOpen: boolean;
      };
    };
    return {
      mode: w.__connectDragState?.mode ?? 'idle',
      active: w.__connectDragState?.active ?? false,
      sourcePortId: w.__connectDragState?.pickupSource?.portId ?? null,
      menuOpen: w.__connectDragState?.pickupMenuOpen ?? false,
    };
  });
}

test.describe('PatchPanel: jack-click → pickup carry', () => {
  test('clicking an OUTPUT port row picks up a cable (mode=pickup, menu open)', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 120 } },
      { id: 'flt', type: 'filter', position: { x: 700, y: 120 } },
    ]);

    await openFrom(page, 'lfo', 'left');
    await chrome(page, 'lfo')
      .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
      .click();
    await chrome(page, 'lfo')
      .locator('[data-testid="patch-panel-port-row"][data-port-id="phase0"]')
      .click();

    const state = await readPickupState(page);
    expect(state.mode).toBe('pickup');
    expect(state.active).toBe(true);
    expect(state.sourcePortId).toBe('phase0');
    expect(state.menuOpen).toBe(true);

    // The dangling cable follows the cursor.
    await page.mouse.move(450, 300);
    await expect(page.locator('[data-testid="pickup-cable"]')).toBeVisible();
    await page.mouse.move(550, 360);
    await expect(page.locator('[data-testid="pickup-cable"]')).toBeVisible();

    // Esc discards (no edge).
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="pickup-cable"]')).toHaveCount(0);
    expect((await readPickupState(page)).mode).toBe('idle');
  });

  test('handles for every declared port stay in the card DOM (io-spec parity)', async ({ page, rack }) => {
    await spawnPatch(page, [{ id: 'lfo', type: 'lfo', position: { x: 80, y: 120 } }]);
    // Panel CLOSED.
    await expect(chrome(page, 'lfo')).toHaveCount(0);
    const handleIds = await page
      .locator('.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-handleid')));
    expect(handleIds).toContain('phase0');
  });
});
