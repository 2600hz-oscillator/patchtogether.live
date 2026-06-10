// e2e/tests/aut-patch-panel.spec.ts
//
// @aut Acceptance flow for the redesigned (no-drag / overlay-replace) patch
// menu:
//
//  - Open a fresh rack
//  - Spawn an ADSR — see knobs, no open menu
//  - Click ADSR's trigger — the body-portaled menu opens (root: INPUT /
//    OUTPUT)
//  - Drill into INPUT — ATTACK/DECAY/SUSTAIN/RELEASE/GATE labels visible
//  - Patch SEQUENCER.gate → ADSR.gate via the carry → "patch to" → picker
//    flow — the edge materialises
//  - Outside-click closes the menu
//  - Spawn RIOTGIRLS — section nav rows at root, drill into a section,
//    handles for all 57 ports stay in the card DOM
//
// AUT tests are tagged @aut so they're easy to run as a focused suite.

import { test, expect, type Page } from '@playwright/test';
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

test.describe('@aut PatchPanel acceptance flow', () => {
  test('ADSR click-open, verbose labels, patch via carry, outside-click closes', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 120 } },
      { id: 'adsr', type: 'adsr', position: { x: 760, y: 120 } },
    ]);

    // 1. ADSR menu is closed by default (no portaled chrome).
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // 2. Click ADSR's trigger — the menu opens (root view).
    await openFrom(page, 'adsr', 'left');
    await expect(chrome(page, 'adsr').locator('[data-testid="patch-panel-root"]')).toBeVisible();

    // 3. Drill into INPUT — verbose labels visible.
    await chrome(page, 'adsr')
      .locator('[data-testid="patch-panel-nav"][data-nav="inputs"]')
      .click();
    const labels = (
      await chrome(page, 'adsr')
        .locator('[data-testid="port-row-label"]')
        .allTextContents()
    ).map((s) => s.trim());
    for (const expected of ['ATTACK', 'DECAY', 'SUSTAIN', 'RELEASE', 'GATE']) {
      expect(labels).toContain(expected);
    }
    // Close ADSR's menu (negative space) before patching from SEQUENCER.
    await page.mouse.click(8, 8);
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // 4. Patch SEQUENCER.gate → ADSR.gate via the carry → patch-to flow.
    await openFrom(page, 'seq', 'left');
    await chrome(page, 'seq')
      .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
      .click();
    await chrome(page, 'seq')
      .locator('[data-testid="patch-panel-port-row"][data-port-id="gate"]')
      .click();
    await page.mouse.move(500, 300);
    await chrome(page, 'seq').locator('[data-testid="patch-panel-patch-to"]').click();
    await page.locator('[data-testid="patch-to-module"][data-node-id="adsr"]').click();
    await page.locator('[data-testid="patch-to-port"][data-port-id="gate"]').click();

    // Edge created.
    await expect(
      page.locator(`.svelte-flow__edge[data-id*="seq-gate-adsr-gate"]`),
    ).toHaveCount(1);

    // 5. The menus are closed after commit.
    await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
    await expect(chrome(page, 'seq')).toHaveCount(0);
  });

  test('RIOTGIRLS spawn → click-open → section nav rows + drill shows verbose labels', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'rg', type: 'riotgirls', position: { x: 200, y: 100 } }]);

    await openFrom(page, 'rg', 'left');

    // Root: a section nav row per voice + an OUTPUT pivot.
    for (const label of [
      'Voice 1 (DG)',
      'Voice 2 (DG)',
      'Voice 3 (DG)',
      'Voice 4 (WT)',
      'Master FX',
    ]) {
      await expect(
        chrome(page, 'rg').locator(
          `[data-testid="patch-panel-section-nav"][data-section-label="${label}"]`,
        ),
      ).toHaveCount(1);
    }

    // Drill into Voice 1 → its port rows + verbose labels appear (overlay
    // replaces the root section list).
    await chrome(page, 'rg')
      .locator('[data-testid="patch-panel-section-nav"][data-section-label="Voice 1 (DG)"]')
      .click();
    const v1Labels = (
      await chrome(page, 'rg').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    expect(v1Labels).toContain('V1 TRIGGER');

    // Back → drill into OUTPUT → the FX output rows appear.
    await chrome(page, 'rg').locator('[data-testid="patch-panel-back"]').click();
    await chrome(page, 'rg')
      .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
      .click();
    const outLabels = (
      await chrome(page, 'rg').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    expect(outLabels.length).toBeGreaterThan(0);

    // io-spec parity: all 55 inputs + 2 outputs = 57 handles stay in the
    // card DOM regardless of menu state.
    const handleCount = await page
      .locator('.svelte-flow__node[data-id="rg"] .svelte-flow__handle[data-handleid]')
      .count();
    expect(handleCount).toBe(57);
  });
});
