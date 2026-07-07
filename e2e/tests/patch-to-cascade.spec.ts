// e2e/tests/patch-to-cascade.spec.ts
//
// "Patch to..." picker on every port, after the no-drag / overlay-replace
// redesign. The cascade is reached via the carry flow:
//   open menu → drill INPUT/OUTPUT → click a port ROW (jack-click, picks up
//   a cable) → click "patch to" → pick a target module → pick a compatible
//   port → edge.
//
// The picker itself is an OVERLAY-REPLACE cascade (modules list → click a
// module → its ports REPLACE the modules list; a back affordance returns).
// It is body-portaled + edge-aligned. It closes on Escape, on picking a
// port, or on a negative-space pointerdown.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: string;
  targetType: string;
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

async function openMenu(page: Page, nodeId: string) {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
}

/** Carry a port + open the patch-to picker (modules list level). */
async function openPickerFor(
  page: Page,
  src: { nodeId: string; portId: string; direction: 'input' | 'output' },
) {
  await openMenu(page, src.nodeId);
  await chrome(page, src.nodeId)
    .locator(
      `[data-testid="patch-panel-nav"][data-nav="${src.direction === 'output' ? 'outputs' : 'inputs'}"]`,
    )
    .click();
  await chrome(page, src.nodeId)
    .locator(`[data-testid="patch-panel-port-row"][data-port-id="${src.portId}"]`)
    .click();
  await page.mouse.move(500, 320);
  await chrome(page, src.nodeId).locator('[data-testid="patch-panel-patch-to"]').click();
  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
}

async function portIdsInPicker(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="patch-to-port"]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''));
}

test.describe.configure({ mode: 'parallel' });

test('happy path: LFO.phase0 → FILTER.cutoff via carry → picker', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
    { id: 'flt1', type: 'filter', position: { x: 600, y: 200 } },
  ]);

  await openPickerFor(page, { nodeId: 'lfo1', portId: 'phase0', direction: 'output' });
  await page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]').click();

  expect((await portIdsInPicker(page))).toEqual(['cutoff', 'res']);
  await page.locator('[data-testid="patch-to-port"][data-port-id="cutoff"]').click();
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);

  const edges = await readEdges(page);
  expect(edges.length).toBe(1);
  expect(edges[0]!.source).toEqual({ nodeId: 'lfo1', portId: 'phase0' });
  expect(edges[0]!.target).toEqual({ nodeId: 'flt1', portId: 'cutoff' });
});

test('type filtering: cv source → AudioOut shows "No compatible ports"', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
    { id: 'ao1', type: 'audioOut', position: { x: 600, y: 200 } },
  ]);

  await openPickerFor(page, { nodeId: 'lfo1', portId: 'phase0', direction: 'output' });
  await page.locator('[data-testid="patch-to-module"][data-node-id="ao1"]').click();
  await expect(page.locator('[data-testid="no-compatible-ports"]')).toBeVisible();
});

test('destructive overwrite: occupied input → "!" prefix + replaces the edge', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 100 } },
      { id: 'lfo2', type: 'lfo', position: { x: 100, y: 400 } },
      { id: 'flt1', type: 'filter', position: { x: 600, y: 200 } },
    ],
    [
      {
        id: 'e-pre',
        from: { nodeId: 'lfo1', portId: 'phase0' },
        to: { nodeId: 'flt1', portId: 'cutoff' },
        sourceType: 'cv',
        targetType: 'cv',
      },
    ],
  );

  await openPickerFor(page, { nodeId: 'lfo2', portId: 'phase0', direction: 'output' });
  await page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]').click();

  const cutoff = page.locator('[data-testid="patch-to-port"][data-port-id="cutoff"]');
  await expect(cutoff).toHaveAttribute('data-occupied', 'true');
  const title = await cutoff.getAttribute('title');
  expect(title?.toLowerCase()).toContain('lfo #1');
  await expect(cutoff.locator('.warn-glyph')).toHaveText('!');

  await cutoff.click();
  const edges = await readEdges(page);
  expect(edges.length).toBe(1);
  expect(edges[0]!.source).toEqual({ nodeId: 'lfo2', portId: 'phase0' });
  expect(edges[0]!.target).toEqual({ nodeId: 'flt1', portId: 'cutoff' });
});

test('disabled when no other modules exist', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'lfo1', type: 'lfo', position: { x: 200, y: 200 } }]);

  await openPickerFor(page, { nodeId: 'lfo1', portId: 'phase0', direction: 'output' });
  const disabled = page.locator('[data-testid="patch-to-disabled"]');
  await expect(disabled).toBeVisible();
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await expect(disabled).toHaveAttribute('title', /no other modules/i);
});

test('compatible direction: carry an INPUT → picker lists OUTPUTs of the target', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
    { id: 'flt1', type: 'filter', position: { x: 600, y: 200 } },
  ]);

  // Carry FILTER.cutoff (an INPUT). Candidates after picking LFO are LFO's
  // OUTPUTs (phase0/90/180/270), not its inputs.
  await openPickerFor(page, { nodeId: 'flt1', portId: 'cutoff', direction: 'input' });
  await page.locator('[data-testid="patch-to-module"][data-node-id="lfo1"]').click();

  const portIds = await portIdsInPicker(page);
  expect(portIds).toEqual(['phase0', 'phase90', 'phase180', 'phase270']);
  expect(portIds).not.toContain('rate');

  await page.locator('[data-testid="patch-to-port"][data-port-id="phase90"]').click();
  const edges = await readEdges(page);
  expect(edges.length).toBe(1);
  expect(edges[0]!.source).toEqual({ nodeId: 'lfo1', portId: 'phase90' });
  expect(edges[0]!.target).toEqual({ nodeId: 'flt1', portId: 'cutoff' });
});

test('overlay-replace: clicking a module replaces the modules list with its ports; back returns', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
    { id: 'flt1', type: 'filter', position: { x: 600, y: 200 } },
  ]);

  await openPickerFor(page, { nodeId: 'lfo1', portId: 'phase0', direction: 'output' });
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu.locator('[data-testid="patch-to-modules"]')).toBeVisible();
  await menu.locator('[data-testid="patch-to-module"][data-node-id="flt1"]').click();
  await expect(menu.locator('[data-testid="patch-to-modules"]')).toHaveCount(0);
  await expect(menu.locator('[data-testid="patch-to-ports"]')).toBeVisible();
  await menu.locator('[data-testid="patch-to-back"]').click();
  await expect(menu.locator('[data-testid="patch-to-modules"]')).toBeVisible();
});

test('persists through pointer movement; closes on Escape', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
    { id: 'flt1', type: 'filter', position: { x: 600, y: 200 } },
  ]);

  await openPickerFor(page, { nodeId: 'lfo1', portId: 'phase0', direction: 'output' });
  const menu = page.locator('[data-testid="port-context-menu"]');
  // Move the cursor around — the menu persists (no cursor-leave close).
  await page.mouse.move(300, 500, { steps: 6 });
  await page.mouse.move(900, 120, { steps: 6 });
  await expect(menu).toBeVisible();
  // Esc closes.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('closes on commit (port click)', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
    { id: 'flt1', type: 'filter', position: { x: 600, y: 200 } },
  ]);

  await openPickerFor(page, { nodeId: 'lfo1', portId: 'phase0', direction: 'output' });
  await page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]').click();
  await page.locator('[data-testid="patch-to-port"][data-port-id="res"]').click();
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
  expect((await readEdges(page)).length).toBe(1);
});

test('ADSR.env → Analog VCO shows tune/fine/fmAmount/pmAmount as cv destinations', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'adsr', type: 'adsr', position: { x: 100, y: 200 } },
    { id: 'vco', type: 'analogVco', position: { x: 600, y: 200 } },
  ]);

  await openPickerFor(page, { nodeId: 'adsr', portId: 'env', direction: 'output' });
  await page.locator('[data-testid="patch-to-module"][data-node-id="vco"]').click();
  const portIds = await portIdsInPicker(page);
  for (const p of ['tune', 'fine', 'fmAmount', 'pmAmount']) {
    expect(portIds, `${p} listed as cv destination`).toContain(p);
  }
});

test('ADSR.env → Wavetable VCO shows tune/fine/fmAmount/pmAmount/wavePos as cv destinations', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'adsr', type: 'adsr', position: { x: 100, y: 200 } },
    { id: 'wvco', type: 'wavetableVco', position: { x: 600, y: 200 } },
  ]);

  await openPickerFor(page, { nodeId: 'adsr', portId: 'env', direction: 'output' });
  await page.locator('[data-testid="patch-to-module"][data-node-id="wvco"]').click();
  const portIds = await portIdsInPicker(page);
  for (const p of ['tune', 'fine', 'fmAmount', 'pmAmount', 'wavePos']) {
    expect(portIds, `${p} listed as cv destination`).toContain(p);
  }
});
