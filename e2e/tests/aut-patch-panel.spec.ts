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
//  - Spawn MIXMSTRS — section nav rows at root, drill into a section,
//    handles for every declared port stay in the card DOM
//
// AUT tests are tagged @aut so they're easy to run as a focused suite.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

async function openFrom(page: Page, nodeId: string) {
  // The shell's lane rail has ONE drill-down trigger (the card's left/right
  // corner pair died with the card — see patch-panel.spec.ts's header).
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
}

test.describe('@aut PatchPanel acceptance flow', () => {
  test('ADSR click-open, verbose labels, patch via carry, outside-click closes', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'seq', type: 'kria', position: { x: 80, y: 120 } },
      { id: 'adsr', type: 'adsr', position: { x: 900, y: 120 } },
    ]);

    // 1. ADSR menu is closed by default (no portaled chrome).
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // 2. Click ADSR's trigger — the menu opens (root view).
    await openFrom(page, 'adsr');
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
    await openFrom(page, 'seq');
    await chrome(page, 'seq')
      .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
      .click();
    await chrome(page, 'seq')
      .locator('[data-testid="patch-panel-port-row"][data-port-id="gate1"]')
      .click();
    await page.mouse.move(500, 300);
    await chrome(page, 'seq').locator('[data-testid="patch-panel-patch-to"]').click();
    await page.locator('[data-testid="patch-to-module"][data-node-id="adsr"]').click();
    await page.locator('[data-testid="patch-to-port"][data-port-id="gate"]').click();

    // Edge created.
    await expect(
      page.locator(`.svelte-flow__edge[data-id*="seq-gate1-adsr-gate"]`),
    ).toHaveCount(1);

    // 5. The menus are closed after commit.
    await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
    await expect(chrome(page, 'seq')).toHaveCount(0);
  });

  test('MIXMSTRS spawn → click-open → drill shows collapsed stereo rows + verbose labels', async ({ page, rack }) => {
    await spawnPatch(page, [{ id: 'mm', type: 'mixmstrs', position: { x: 200, y: 100 } }]);

    await openFrom(page, 'mm');

    // Root: INPUT / OUTPUT pivots. ⚠ The card's per-channel SECTION rows
    // (`Ch1 … Master`) are a MEASURED, DOCUMENTED delta of the shell rail
    // (#1762, recorded at the PatchPanel mount in ModuleShell.svelte): the
    // lane rail mounts `groupingStrategy: 'auto'`, so mixmstrs drills into ONE
    // flat list — every port still reachable, only the grouping gone. In
    // sectioned mode the HANDLE STACK is derived from the sections, so
    // restoring the grouping is a product decision, not a `sections={…}` flag.
    await expect(chrome(page, 'mm').locator('[data-testid="patch-panel-root"]')).toBeVisible();
    await expect(
      chrome(page, 'mm').locator('[data-testid="patch-panel-section-nav"]'),
    ).toHaveCount(0);

    // Drill into INPUT → the port rows + verbose labels appear.
    await chrome(page, 'mm')
      .locator('[data-testid="patch-panel-nav"][data-nav="inputs"]')
      .click();
    const ch1Labels = (
      await chrome(page, 'mm').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    // ONE stereo row, not two (PR-4 jack collapse): `ch1L` + `ch1R` are a
    // derived pair, so the strip shows a single `CH1` jack named from the
    // pair's shared stem. The per-leg names are GONE — asserted, because a
    // collapse that merely renamed one row and dropped the other would look
    // identical from a `toContain` alone.
    expect(ch1Labels).toContain('CH1');
    expect(ch1Labels).not.toContain('CH1 L');
    expect(ch1Labels).not.toContain('CH1 R');
    // …and the collapsed row addresses BOTH legs, so a click patches the
    // whole image rather than half of it.
    await expect(
      chrome(page, 'mm').locator('[data-testid="patch-panel-port-row"][data-port-id="ch1L"]'),
    ).toHaveAttribute('data-stereo-sibling', 'ch1R');
    await expect(
      chrome(page, 'mm').locator('[data-testid="patch-panel-port-row"][data-port-id="ch1R"]'),
    ).toHaveCount(0);

    // Back → drill into OUTPUT → the master/send output rows appear.
    await chrome(page, 'mm').locator('[data-testid="patch-panel-back"]').click();

    await chrome(page, 'mm')
      .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
      .click();
    const outLabels = (
      await chrome(page, 'mm').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    expect(outLabels.length).toBeGreaterThan(0);

    // io-spec parity: every declared port keeps a handle in the card DOM
    // regardless of menu state (49 inputs + outputs).
    //
    // ⚠ THE HANDLE STACK IS NOT COLLAPSED, and this is the assertion that
    // pins it. Jack collapse is a decision about ROWS A HUMAN CLICKS; the
    // handle set is the graph's anchor surface, so BOTH legs of every pair
    // keep their own hidden handle — a legacy only-R edge must still have
    // somewhere to land, and the per-module-per-port sweep counts them all.
    const handleCount = await page
      .locator('.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid]')
      .count();
    expect(handleCount).toBeGreaterThanOrEqual(50);
    // Named, not just counted: the RIGHT leg of a collapsed pair still has a
    // handle even though it no longer has a row.
    await expect(
      page.locator('.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid="ch1R"]'),
    ).toHaveCount(1);
  });
});
