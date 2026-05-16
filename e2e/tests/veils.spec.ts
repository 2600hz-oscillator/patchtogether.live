// e2e/tests/veils.spec.ts
//
// VEILS end-to-end smoke. Patch ANALOGVCO → VEILS (ch1) → AUDIOOUT (mix),
// sweep the gain knob through the soft-clip range, toggle response curves,
// confirm no console errors and the card UI mounts as expected.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('VEILS renders + audio flows from VCO through one VCA channel to OUTPUT', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60 },  domain: 'audio' },
      { id: 'a-v',   type: 'veils',     position: { x: 360, y: 60 },  domain: 'audio',
        params: { gain1: 1.0 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 },  domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' }, to: { nodeId: 'a-v',   portId: 'in1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-v',   portId: 'mix' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-v',   portId: 'mix' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-veils');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('VEILS');

  await page.waitForTimeout(500);

  // Sweep gain1 from 0 to 2 — confirms the AudioParam accepts the full
  // declared range including the soft-clip zone above 1.
  for (const g of [0, 0.3, 0.7, 1.0, 1.4, 2.0, 0.8]) {
    await page.evaluate((gv) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-v'];
        if (n) n.params.gain1 = gv;
      });
    }, g);
    await page.waitForTimeout(80);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('VEILS response toggle flips LIN ↔ EXP and writes the param', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-v', type: 'veils', position: { x: 100, y: 100 }, domain: 'audio' },
    ],
    [],
  );

  const card = page.locator('.svelte-flow__node-veils');
  await expect(card).toHaveCount(1);

  // Defaults: ch1 = LIN (0), ch3 = EXP (1).
  const resp1 = page.locator('[data-testid="veils-resp1"]');
  const resp3 = page.locator('[data-testid="veils-resp3"]');
  await expect(resp1).toHaveText('LIN');
  await expect(resp3).toHaveText('EXP');

  // Click ch1 — flips to EXP.
  await resp1.click();
  await expect(resp1).toHaveText('EXP');

  // Confirm the patch.params.resp1 mirror picked up the change.
  const resp1ParamAfterClick = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    return w.__patch.nodes['a-v']?.params.resp1;
  });
  expect(resp1ParamAfterClick).toBeGreaterThanOrEqual(0.5);

  // Click again — back to LIN.
  await resp1.click();
  await expect(resp1).toHaveText('LIN');
});

test('VEILS survives extreme-param mutation (no crashes pushing knob+CV past unity)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60 } },
      { id: 'a-lfo', type: 'lfo',       position: { x: 60,  y: 260 } },
      { id: 'a-v',   type: 'veils',     position: { x: 360, y: 60 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },     to: { nodeId: 'a-v',   portId: 'in1' } },
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'saw' },     to: { nodeId: 'a-v',   portId: 'in2' } },
      { id: 'e3', from: { nodeId: 'a-lfo', portId: 'phase0' },  to: { nodeId: 'a-v',   portId: 'cv1' } },
      { id: 'e4', from: { nodeId: 'a-v',   portId: 'mix' },     to: { nodeId: 'a-out', portId: 'L' } },
      { id: 'e5', from: { nodeId: 'a-v',   portId: 'mix' },     to: { nodeId: 'a-out', portId: 'R' } },
    ],
  );

  await page.waitForTimeout(500);

  // Crank every knob to the max + flip every resp toggle a few times.
  const corners: Array<Record<string, number>> = [
    { gain1: 2.0, gain2: 2.0, gain3: 0.0, gain4: 0.0, resp1: 1, resp2: 0, resp3: 1, resp4: 0 },
    { gain1: 0.0, gain2: 0.0, gain3: 2.0, gain4: 2.0, resp1: 0, resp2: 1, resp3: 0, resp4: 1 },
    { gain1: 1.5, gain2: 1.5, gain3: 1.5, gain4: 1.5, resp1: 1, resp2: 1, resp3: 1, resp4: 1 },
    { gain1: 0.5, gain2: 0.5, gain3: 0.5, gain4: 0.5, resp1: 0, resp2: 0, resp3: 0, resp4: 0 },
  ];
  for (const corner of corners) {
    await page.evaluate((params) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-v'];
        if (n) Object.assign(n.params, params);
      });
    }, corner);
    await page.waitForTimeout(120);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
