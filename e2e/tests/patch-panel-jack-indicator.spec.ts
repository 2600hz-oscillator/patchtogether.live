// e2e/tests/patch-panel-jack-indicator.spec.ts
//
// Behavior coverage for the on-card patch-menu PATCHED-PORT INDICATOR + the
// remote-patch hover overlay (the menu drill-down itself is covered by
// patch-menu-redesign.spec.ts; this only exercises the new jack indicator).
//
//   1. A port WITH an edge connected to it shows a FILLED jack
//      (data-patched="true") whose `title` names the remote endpoint:
//        - an OUTPUT that feeds a target → "→ TO <Name>.<PORT>"
//        - an INPUT  fed by a source     → "← FROM <Name>.<PORT>"
//   2. An UNPATCHED sibling port shows a HOLLOW jack (data-patched="false")
//      with no title.
//
// The chrome is body-portaled, so the open panel lives at
// [data-patch-panel-chrome="<nodeId>"]; selectors target it by node id.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** The portaled chrome for a given source node. */
function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

/** Open the panel from a given trigger side. */
async function openFrom(page: Page, nodeId: string, side: 'left' | 'right') {
  const testid = side === 'left' ? 'patch-trigger' : 'patch-trigger-right';
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="${testid}"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
}

/** Spawn SEQUENCER → ADSR with one PRE-WIRED edge: seq.gate → adsr.gate. */
async function spawnSeqAdsrWired(page: Page) {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 120 } },
      { id: 'adsr', type: 'adsr', position: { x: 760, y: 120 } },
    ],
    [
      {
        id: 'e-gate',
        from: { nodeId: 'seq', portId: 'gate' },
        to: { nodeId: 'adsr', portId: 'gate' },
        sourceType: 'gate',
        targetType: 'gate',
      },
    ],
  );
}

/** A port row's trailing jack indicator, scoped to the open chrome. */
function jack(page: Page, nodeId: string, portId: string) {
  return chrome(page, nodeId)
    .locator(`[data-testid="patch-panel-port-row"][data-port-id="${portId}"] [data-testid="port-row-jack"]`);
}

test('patched OUTPUT shows a filled jack with a "→ TO" remote title; unpatched sibling is hollow', async ({
  page,
}) => {
  await spawnSeqAdsrWired(page);

  // Open SEQUENCER and drill into OUTPUTs — seq.gate feeds adsr.gate.
  await openFrom(page, 'seq', 'left');
  await chrome(page, 'seq')
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();

  // The patched gate output: filled + title names the remote endpoint.
  const gateJack = jack(page, 'seq', 'gate');
  await expect(gateJack).toHaveAttribute('data-patched', 'true');
  const title = await gateJack.getAttribute('title');
  expect(title).toBeTruthy();
  expect(title!).toContain('→ TO');
  expect(title!.toUpperCase()).toContain('ADSR');
  expect(title!.toUpperCase()).toContain('GATE');
  // aria-label mirrors the title for AT.
  await expect(gateJack).toHaveAttribute('aria-label', title!);

  // An UNPATCHED sibling output (seq.pitch) is hollow with no title.
  const pitchJack = jack(page, 'seq', 'pitch');
  await expect(pitchJack).toHaveAttribute('data-patched', 'false');
  expect(await pitchJack.getAttribute('title')).toBeNull();
});

test('patched INPUT shows a filled jack with a "← FROM" remote title; unpatched sibling is hollow', async ({
  page,
}) => {
  await spawnSeqAdsrWired(page);

  // Open ADSR and drill into INPUTs — adsr.gate is fed by seq.gate.
  await openFrom(page, 'adsr', 'left');
  await chrome(page, 'adsr')
    .locator('[data-testid="patch-panel-nav"][data-nav="inputs"]')
    .click();

  const gateJack = jack(page, 'adsr', 'gate');
  await expect(gateJack).toHaveAttribute('data-patched', 'true');
  const title = await gateJack.getAttribute('title');
  expect(title).toBeTruthy();
  expect(title!).toContain('← FROM');
  expect(title!.toUpperCase()).toContain('SEQUENCER');
  expect(title!.toUpperCase()).toContain('GATE');

  // ADSR.attack has no incoming cable → hollow, no title.
  const attackJack = jack(page, 'adsr', 'attack');
  await expect(attackJack).toHaveAttribute('data-patched', 'false');
  expect(await attackJack.getAttribute('title')).toBeNull();
});
