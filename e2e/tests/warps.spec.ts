// e2e/tests/warps.spec.ts
//
// WARPS end-to-end smoke. Patch ANALOGVCO into WARPS as the modulator (the
// internal oscillator provides the carrier), then route WARPS → AUDIOOUT.
// Sweep the algorithm + knobs through their full range; assert the card
// renders, the algo-readout updates, and no console errors fire.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('WARPS renders + audio flows from VCO modulator through warps to OUTPUT', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60 },  domain: 'audio' },
      { id: 'a-wp',  type: 'warps',     position: { x: 360, y: 60 },  domain: 'audio',
        params: { algorithm: 1, carrier_shape: 0, timbre: 0.5, level_1: 0.8, level_2: 0.8, note: 0 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 },  domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' }, to: { nodeId: 'a-wp', portId: 'modulator_in' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-wp',  portId: 'out' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-wp',  portId: 'out' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-warps');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('WARPS');

  // Algorithm readout reflects the initial param (algorithm=1 → RING-MOD).
  const readout = page.locator('[data-testid="warps-algo-name"]');
  await expect(readout).toHaveText('RING-MOD');

  await page.waitForTimeout(600);

  // Sweep algorithm through all 4 values and confirm the readout updates.
  for (const [algo, expected] of [
    [0, 'XFADE'],
    [1, 'RING-MOD'],
    [2, 'XOR'],
    [3, 'COMPARE'],
  ] as const) {
    await page.evaluate((a) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-wp'];
        if (n) n.params.algorithm = a;
      });
    }, algo);
    await expect(readout).toHaveText(expected);
    await page.waitForTimeout(150);
  }

  // Sweep the continuous knobs.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-wp'];
      if (n) {
        n.params.algorithm = 1;
        n.params.carrier_shape = 0.6;
        n.params.timbre = 0.8;
        n.params.level_1 = 0.7;
        n.params.level_2 = 0.9;
        n.params.note = 12;
      }
    });
  });
  await page.waitForTimeout(300);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('WARPS survives extreme-param mutation via __patch (no crashes)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60 },  domain: 'audio' },
      { id: 'a-wp',  type: 'warps',     position: { x: 360, y: 60 },  domain: 'audio' },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 },  domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' }, to: { nodeId: 'a-wp',  portId: 'carrier_in' } },
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'square' }, to: { nodeId: 'a-wp', portId: 'modulator_in' } },
      { id: 'e3', from: { nodeId: 'a-wp',  portId: 'out' },   to: { nodeId: 'a-out', portId: 'L' } },
      { id: 'e4', from: { nodeId: 'a-wp',  portId: 'out' },   to: { nodeId: 'a-out', portId: 'R' } },
    ],
  );

  await page.waitForTimeout(500);

  const corners: Array<Record<string, number>> = [
    { algorithm: 0, carrier_shape: 0, timbre: 0, level_1: 0, level_2: 0, note: -60 },
    { algorithm: 3, carrier_shape: 1, timbre: 1, level_1: 1, level_2: 1, note:  60 },
    { algorithm: 1, carrier_shape: 0.5, timbre: 0.5, level_1: 0.5, level_2: 0.5, note: 0 },
    { algorithm: 2, carrier_shape: 0.75, timbre: 1, level_1: 1, level_2: 1, note: 24 },
  ];
  for (const corner of corners) {
    await page.evaluate((params) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-wp'];
        if (n) Object.assign(n.params, params);
      });
    }, corner);
    await page.waitForTimeout(150);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
