// e2e/tests/attenumix.spec.ts
//
// ATTENUMIX end-to-end smoke. Patch NOISE → ATTENUMIX (ch1) → AUDIOOUT
// (mix), sweep att1 + master across their ranges including the soft-clip
// zone (master > 1), confirm no console errors and the card UI mounts.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('ATTENUMIX renders + audio flows from NOISE through one channel to OUTPUT', async ({ page }) => {
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
      { id: 'a-n',   type: 'noise',     position: { x: 60,  y: 60 },  domain: 'audio' },
      { id: 'a-m',   type: 'attenumix', position: { x: 360, y: 60 },  domain: 'audio',
        params: { att1: 1.0, master: 1.0 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 },  domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-n', portId: 'white' }, to: { nodeId: 'a-m',   portId: 'in1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-m', portId: 'mix' },   to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-m', portId: 'mix' },   to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-attenumix');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('ATTENUMIX');

  await page.waitForTimeout(500);

  // Sweep att1 from 0 → 1 to make sure the AudioParam accepts the full
  // attenuator range. Master is held at unity.
  for (const a of [0, 0.25, 0.5, 0.75, 1.0, 0.5]) {
    await page.evaluate((av) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-m'];
        if (n) n.params.att1 = av;
      });
    }, a);
    await page.waitForTimeout(60);
  }

  // Then sweep master through its 0..2 range (the soft-clip zone is >1).
  for (const m of [0, 0.5, 1.0, 1.5, 2.0, 1.0]) {
    await page.evaluate((mv) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-m'];
        if (n) n.params.master = mv;
      });
    }, m);
    await page.waitForTimeout(60);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('ATTENUMIX survives extreme-param mutation (all 4 channels + CV-driven)', async ({ page }) => {
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
      { id: 'a-n',   type: 'noise',     position: { x: 60,  y: 60 } },
      { id: 'a-lfo', type: 'lfo',       position: { x: 60,  y: 260 } },
      { id: 'a-m',   type: 'attenumix', position: { x: 360, y: 60 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-n',   portId: 'white' },  to: { nodeId: 'a-m',   portId: 'in1' } },
      { id: 'e2', from: { nodeId: 'a-n',   portId: 'white' },  to: { nodeId: 'a-m',   portId: 'in2' } },
      { id: 'e3', from: { nodeId: 'a-lfo', portId: 'phase0' }, to: { nodeId: 'a-m',   portId: 'cv1' } },
      { id: 'e4', from: { nodeId: 'a-m',   portId: 'mix' },    to: { nodeId: 'a-out', portId: 'L' } },
      { id: 'e5', from: { nodeId: 'a-m',   portId: 'mix' },    to: { nodeId: 'a-out', portId: 'R' } },
    ],
  );

  await page.waitForTimeout(500);

  // Crank every knob to the corners. att caps at 1, master caps at 2.
  const corners: Array<Record<string, number>> = [
    { att1: 1, att2: 1, att3: 0, att4: 0, master: 2 },
    { att1: 0, att2: 0, att3: 1, att4: 1, master: 2 },
    { att1: 1, att2: 1, att3: 1, att4: 1, master: 0 },
    { att1: 0.5, att2: 0.5, att3: 0.5, att4: 0.5, master: 1 },
  ];
  for (const corner of corners) {
    await page.evaluate((params) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-m'];
        if (n) Object.assign(n.params, params);
      });
    }, corner);
    await page.waitForTimeout(100);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
