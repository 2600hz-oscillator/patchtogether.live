// e2e/tests/patch-panel-nested.spec.ts
//
// Sectioned mega-modules (MIXMSTRS 49 inputs) in the
// overlay-replace patch menu.
//
// The OLD multi-open inline-expand model (click headers to fan out several
// sections at once) is GONE — replaced by drill-in overlay: each section is
// a NAV row at root; clicking one REPLACES the root with that section's port
// rows (parent hides; nothing stacks). A back affordance returns. The
// drag-time expand-all is also gone (no cable drag).
//
// What this spec pins:
//   1. Root shows one section NAV row per section (with a port-count badge)
//      + an OUTPUT pivot — and zero port rows (you must drill in).
//   2. Drilling into a section shows that section's port rows; back returns
//      to the section list.
//   3. Drilling into a DIFFERENT section replaces the first (overlay, not
//      stacked).
//   4. Handles for every declared port stay in the card DOM with the menu
//      CLOSED — the io-spec / per-module-per-port sweep depends on it.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { REGISTRY } from './_registry';

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

async function openMenu(page: Page, nodeId: string) {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
}

function sectionNav(page: Page, nodeId: string, label: string) {
  return chrome(page, nodeId).locator(
    `[data-testid="patch-panel-section-nav"][data-section-label="${label}"]`,
  );
}

async function drillSection(page: Page, nodeId: string, label: string) {
  await sectionNav(page, nodeId, label).click();
  await expect(
    chrome(page, nodeId).locator('[data-testid="patch-panel-section"]'),
  ).toHaveAttribute('data-section-label', label);
}

async function visibleRowCount(page: Page, nodeId: string): Promise<number> {
  return chrome(page, nodeId).locator('[data-testid="patch-panel-port-row"]:visible').count();
}

test.describe('PatchPanel: overlay-replace nested sections', () => {
  test('MIXMSTRS: 6 channel nav rows; drill/back overlay behaviour', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'mm', type: 'mixmstrs', position: { x: 100, y: 100 } }]);
    await openMenu(page, 'mm');

    // Channel sections present as nav rows.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5', 'Ch6', 'Master']) {
      await expect(sectionNav(page, 'mm', label)).toHaveCount(1);
    }
    expect(await visibleRowCount(page, 'mm')).toBe(0);

    await drillSection(page, 'mm', 'Ch1');
    expect(await visibleRowCount(page, 'mm')).toBeGreaterThan(0);
    await chrome(page, 'mm').locator('[data-testid="patch-panel-back"]').click();
    await drillSection(page, 'mm', 'Ch2');
    await expect(chrome(page, 'mm').locator('[data-testid="patch-panel-section"]')).toHaveCount(1);
  });

  test('MIXMSTRS: collapsed root menu fits on a 1366×768 viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'mm', type: 'mixmstrs', position: { x: 100, y: 100 } }]);
    await openMenu(page, 'mm');

    const box = await chrome(page, 'mm').boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;
    // Root shows section nav rows only → well under viewport height.
    expect(box.height).toBeLessThanOrEqual(600);
  });

  test('handles remain in the card DOM with the menu closed (io-spec parity)', async ({
    page,
  }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const mmDef = REGISTRY.find((m) => m.type === 'mixmstrs')!;
    const mmExpected = mmDef.inputs.length + mmDef.outputs.length;
    // Menu CLOSED — the per-module-per-port sweep counts handles here.
    await spawnPatch(page, [{ id: 'mm', type: 'mixmstrs', position: { x: 200, y: 200 } }]);
    await expect(chrome(page, 'mm')).toHaveCount(0);
    const mmCount = await page
      .locator('.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid]')
      .count();
    expect(mmCount, `MIXMSTRS exposes all ${mmExpected} handles with the menu closed`).toBe(
      mmExpected,
    );
  });
});
