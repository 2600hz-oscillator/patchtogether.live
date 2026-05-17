// e2e/tests/blades.spec.ts
//
// End-to-end smoke for BLADES — dual SVF filter + COLOR + mix bus.
// Patches an ANALOGVCO → BLADES (filter 1) → AUDIOOUT (mix); sweeps
// the cutoff knob through the audio range; toggles modes + MIX-MODE;
// asserts no console errors and the card UI mounts.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('BLADES renders + audio flows from VCO through filter1 to OUTPUT', async ({ page }) => {
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
      { id: 'a-b',   type: 'blades',    position: { x: 360, y: 60 },  domain: 'audio',
        params: { cutoff1: 500, res1: 0.4 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 },  domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' }, to: { nodeId: 'a-b',   portId: 'in1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-b',   portId: 'mix' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-b',   portId: 'mix' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-blades');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('BLADES');

  await page.waitForTimeout(400);

  // Sweep cutoff across the audio band — confirms the AudioParam accepts
  // the full declared log range (20..20000 Hz) without crashing.
  for (const fc of [100, 300, 1000, 4000, 12000, 800]) {
    await page.evaluate((v) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-b'];
        if (n) n.params.cutoff1 = v;
      });
    }, fc);
    await page.waitForTimeout(60);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('BLADES mode buttons cycle LP → BP → HP', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-b', type: 'blades', position: { x: 100, y: 100 }, domain: 'audio' },
    ],
    [],
  );

  const card = page.locator('.svelte-flow__node-blades');
  await expect(card).toHaveCount(1);

  const mode1 = page.locator('[data-testid="blades-mode1"]');
  await expect(mode1).toHaveText('LP');

  await mode1.click();
  await expect(mode1).toHaveText('BP');

  await mode1.click();
  await expect(mode1).toHaveText('HP');

  await mode1.click();
  await expect(mode1).toHaveText('LP');

  // Confirm the param mirror picked up the cycle.
  const mode1Param = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    return w.__patch.nodes['a-b']?.params.mode1;
  });
  expect(mode1Param).toBe(0);
});

test('BLADES MIX-MODE toggle flips PARALLEL ↔ SERIAL', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-b', type: 'blades', position: { x: 100, y: 100 }, domain: 'audio' },
    ],
    [],
  );

  const mixBtn = page.locator('[data-testid="blades-mix-mode"]');
  await expect(mixBtn).toHaveText('PARALLEL');

  await mixBtn.click();
  await expect(mixBtn).toHaveText('SERIAL');

  const mixParam = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    return w.__patch.nodes['a-b']?.params.mixMode;
  });
  expect(mixParam).toBe(1);

  await mixBtn.click();
  await expect(mixBtn).toHaveText('PARALLEL');
});

test('BLADES handles extreme-param sweeps without crashing (COLOR + resonance up)', async ({ page }) => {
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
      { id: 'a-b',   type: 'blades',    position: { x: 360, y: 60 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' }, to: { nodeId: 'a-b',   portId: 'in1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-b',   portId: 'mix' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Push COLOR to max + crank resonance to 1 — make sure the soft-clip
  // and self-osc paths don't blow up.
  for (const [color, res, fc] of [
    [0,    0.1,  1000],
    [0.5,  0.5,  2000],
    [1,    0.95, 800],
    [1,    1.0,  500],
    [0,    0,    300],
  ] as const) {
    await page.evaluate(([col, rs, c]) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-b'];
        if (n) { n.params.color = col; n.params.res1 = rs; n.params.cutoff1 = c; }
      });
    }, [color, res, fc] as [number, number, number]);
    await page.waitForTimeout(80);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
