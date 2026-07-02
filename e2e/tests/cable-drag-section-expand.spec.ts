// e2e/tests/cable-drag-section-expand.spec.ts
//
// CV-family interchange in the patch-to picker.
//
// The no-drag redesign RETIRED the drag-over-auto-open + drag-time
// section-expand-all behaviors (there is no cable drag anymore), so those
// tests were removed. What survives + still matters: the patch-to picker
// lists every CV-family-compatible candidate in BOTH directions (gate ↔ cv ↔
// pitch interchange from canConnect) — the same compatibleTargetPorts logic,
// now reached through the carry → "patch to" flow instead of right-click.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

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

/** Carry a port (output OR input) from a source module + open the picker on a
 *  chosen target module. Returns once the target's port list is showing. */
async function carryToPicker(
  page: Page,
  src: { nodeId: string; portId: string; direction: 'input' | 'output' },
  targetNodeId: string,
) {
  await openFrom(page, src.nodeId, 'left');
  await chrome(page, src.nodeId)
    .locator(`[data-testid="patch-panel-nav"][data-nav="${src.direction === 'output' ? 'outputs' : 'inputs'}"]`)
    .click();
  await chrome(page, src.nodeId)
    .locator(`[data-testid="patch-panel-port-row"][data-port-id="${src.portId}"]`)
    .click();
  await page.mouse.move(500, 300);
  await chrome(page, src.nodeId).locator('[data-testid="patch-panel-patch-to"]').click();
  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
  await page.locator(`[data-testid="patch-to-module"][data-node-id="${targetNodeId}"]`).click();
}

async function pickerPortIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="patch-to-port"]')
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
    );
}

test.describe('patch-to picker — cv-family interchange', () => {
  test('SEQUENCER.gate → ADSR lists gate + every cv input (attack/decay/sustain/release)', async ({
    page,
  }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 120 } },
      { id: 'adsr', type: 'adsr', position: { x: 700, y: 120 } },
    ]);

    await carryToPicker(page, { nodeId: 'seq', portId: 'gate', direction: 'output' }, 'adsr');
    expect((await pickerPortIds(page)).sort()).toEqual([
      'attack',
      'decay',
      'gate',
      'release',
      'sustain',
    ]);
    await page.keyboard.press('Escape');
  });

  test('SEQUENCER.pitch → ANALOG VCO lists pitch + cv params (tune/fmAmount), excludes audio', async ({
    page,
  }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 120 } },
      { id: 'vco', type: 'analogVco', position: { x: 700, y: 120 } },
    ]);

    await carryToPicker(page, { nodeId: 'seq', portId: 'pitch', direction: 'output' }, 'vco');
    const portIds = await pickerPortIds(page);
    expect(portIds).toContain('pitch');
    expect(portIds).toContain('tune');
    expect(portIds).toContain('fine');
    expect(portIds).toContain('fmAmount');
    expect(portIds).toContain('pmAmount');
    // audio-family inputs are strict — never offered to a non-audio source.
    expect(portIds).not.toContain('fm');
    expect(portIds).not.toContain('pm');
    await page.keyboard.press('Escape');
  });

  test('reverse: carry ADSR.gate (input) → LFO lists every cv output', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'adsr', type: 'adsr', position: { x: 80, y: 120 } },
      { id: 'lfo', type: 'lfo', position: { x: 700, y: 120 } },
    ]);

    await carryToPicker(page, { nodeId: 'adsr', portId: 'gate', direction: 'input' }, 'lfo');
    // All four LFO phase outputs are cv → permitted via CV_FAMILY interchange.
    expect((await pickerPortIds(page)).sort()).toEqual([
      'phase0',
      'phase180',
      'phase270',
      'phase90',
    ]);
    await page.keyboard.press('Escape');
  });

  test('commits a cross-family edge: SEQUENCER.gate → ADSR.attack via the picker', async ({
    page,
  }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 120 } },
      { id: 'adsr', type: 'adsr', position: { x: 700, y: 120 } },
    ]);

    await carryToPicker(page, { nodeId: 'seq', portId: 'gate', direction: 'output' }, 'adsr');
    await page.locator('[data-testid="patch-to-port"][data-port-id="attack"]').click();
    await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);

    const edges = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { edges: Record<string, unknown> } };
      return Object.values(w.__patch.edges).filter(Boolean);
    });
    expect(edges.length).toBe(1);
  });
});
