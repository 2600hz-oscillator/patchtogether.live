// e2e/tests/patch-panel.spec.ts
//
// Core invariants of the redesigned (no-drag / overlay-replace / portaled)
// patch menu:
//
//  1. Default state: handles are in the card DOM but opacity:0 +
//     pointer-events:none, stacked at the affordance corner (the per-port
//     sweep + cable anchor depend on this). The menu chrome is NOT mounted.
//  2. Click a trigger → the body-portaled chrome opens at the root view
//     (INPUT / OUTPUT pivots, edge-aligned to the trigger side).
//  3. Drilling into INPUT / OUTPUT shows verbose-labeled port rows.
//  4. Both triggers open the SAME menu (state shared).
//  5. Edge-alignment: the menu's anchored edge lines up with the matching
//     card edge for left vs right triggers, never spilling past it.
//
// I/O-spec consistency (exact handle id matching) is covered separately in
// io-spec-consistency.spec.ts / per-module-per-port.spec.ts.

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

async function drill(page: Page, nodeId: string, nav: 'inputs' | 'outputs') {
  await chrome(page, nodeId).locator(`[data-testid="patch-panel-nav"][data-nav="${nav}"]`).click();
}

test.describe('PatchPanel: redesigned menu', () => {
  test('ADSR default state hides jacks; click-open + drill shows verbose labels', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);

    // 1. Default: chrome not mounted.
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // Handles in DOM but visually hidden (opacity:0 + pointer-events:none).
    const gate = page
      .locator(`.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="gate"]`)
      .first();
    await expect(gate).toHaveCount(1);
    const hidden = await gate.evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.opacity === '0' && cs.pointerEvents === 'none';
    });
    expect(hidden, 'closed-state handle is opacity:0 + pointer-events:none').toBe(true);

    // 2 + 3. Click-open + drill INPUT → verbose labels.
    await openFrom(page, 'adsr', 'left');
    await drill(page, 'adsr', 'inputs');
    const inputLabels = (
      await chrome(page, 'adsr').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    for (const expected of ['ATTACK', 'DECAY', 'SUSTAIN', 'RELEASE', 'GATE']) {
      expect(inputLabels).toContain(expected);
    }
    expect(inputLabels).not.toContain('ATK');

    // Back → drill OUTPUT → ENVELOPE.
    await chrome(page, 'adsr').locator('[data-testid="patch-panel-back"]').click();
    await drill(page, 'adsr', 'outputs');
    const outLabels = (
      await chrome(page, 'adsr').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    expect(outLabels).toContain('ENVELOPE');
    expect(outLabels).not.toContain('GATE');
  });

  test('Filter drill uses verbose CUTOFF / RESONANCE labels', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'flt', type: 'filter', position: { x: 200, y: 200 } }]);
    await openFrom(page, 'flt', 'left');
    await drill(page, 'flt', 'inputs');
    const labels = (
      await chrome(page, 'flt').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    expect(labels).toContain('CUTOFF');
    expect(labels).toContain('RESONANCE');
    expect(labels).not.toContain('CUT');
  });

  test('both triggers open the same menu (shared state)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);

    const rightTrigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger-right"]`,
    );
    await expect(rightTrigger).toHaveCount(1);

    // Hover alone never opens.
    await rightTrigger.hover();
    await page.waitForTimeout(150);
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // Click right → opens (one chrome instance).
    await rightTrigger.click();
    await expect(chrome(page, 'adsr')).toHaveAttribute('aria-hidden', 'false');
    await expect(chrome(page, 'adsr')).toHaveCount(1);

    // Outside click closes.
    await page.mouse.click(20, 20);
    await expect(chrome(page, 'adsr')).toHaveCount(0);
  });

  test('edge-alignment: left trigger anchors menu left; right trigger anchors menu right', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 160 } }]);

    const cardLoc = page.locator('.svelte-flow__node[data-id="adsr"]');

    // Left trigger → menu LEFT edge ≈ card LEFT edge.
    await openFrom(page, 'adsr', 'left');
    let card = await cardLoc.boundingBox();
    let menu = await chrome(page, 'adsr').boundingBox();
    expect(card && menu).toBeTruthy();
    if (!card || !menu) return;
    expect(Math.abs(menu.x - card.x)).toBeLessThanOrEqual(4);
    await page.mouse.click(8, 8);
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // Right trigger → menu RIGHT edge ≈ card RIGHT edge (never spills past).
    await openFrom(page, 'adsr', 'right');
    card = await cardLoc.boundingBox();
    menu = await chrome(page, 'adsr').boundingBox();
    expect(card && menu).toBeTruthy();
    if (!card || !menu) return;
    const cardRight = card.x + card.width;
    const menuRight = menu.x + menu.width;
    expect(Math.abs(menuRight - cardRight)).toBeLessThanOrEqual(4);
    expect(menuRight).toBeLessThanOrEqual(cardRight + 1);
  });

  test('cables visually anchor at the affordance corner when the menu is closed', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'adsr', type: 'adsr', position: { x: 100, y: 100 } },
        { id: 'vca', type: 'vca', position: { x: 600, y: 100 } },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'adsr', portId: 'env' },
          to: { nodeId: 'vca', portId: 'cv' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );
    await expect(
      page.locator(`.svelte-flow__edge[data-id="e1"] .svelte-flow__edge-path`),
    ).toHaveCount(1);

    // Menu closed → the env output handle sits near the source card's
    // top-left trigger (the corner stack), so the cable anchors there.
    await expect(chrome(page, 'adsr')).toHaveCount(0);
    const trigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`,
    );
    const triggerBox = await trigger.boundingBox();
    const handleBox = await page
      .locator(
        `.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="env"][class*="source"]`,
      )
      .boundingBox();
    expect(triggerBox && handleBox).toBeTruthy();
    if (!triggerBox || !handleBox) return;
    const dx = Math.abs(handleBox.x + handleBox.width / 2 - (triggerBox.x + triggerBox.width / 2));
    const dy = Math.abs(handleBox.y + handleBox.height / 2 - (triggerBox.y + triggerBox.height / 2));
    expect(dx, `closed output handle anchors near trigger x (dx=${dx})`).toBeLessThan(30);
    expect(dy, `closed output handle anchors near trigger y (dy=${dy})`).toBeLessThan(30);
  });

  test('handles for every declared port stay in the card DOM with the menu closed (io-spec parity)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'rg', type: 'riotgirls', position: { x: 200, y: 200 } }]);
    await expect(chrome(page, 'rg')).toHaveCount(0);
    // RIOTGIRLS: 55 inputs + 2 outputs = 57 handles regardless of menu state.
    const count = await page
      .locator('.svelte-flow__node[data-id="rg"] .svelte-flow__handle[data-handleid]')
      .count();
    expect(count).toBe(57);
  });
});
