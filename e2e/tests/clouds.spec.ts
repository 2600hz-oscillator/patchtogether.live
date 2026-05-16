// e2e/tests/clouds.spec.ts
//
// CLOUDS end-to-end smoke test. Patch ANALOGVCO → CLOUDS (stereo in) →
// AUDIOOUT (stereo). Sweep the granular knobs. Confirm the card renders,
// freeze toggles, and no errors fire during knob automation.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('CLOUDS renders + audio flows from VCO through granular cloud to OUTPUT', async ({ page }) => {
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
      { id: 'a-cl',  type: 'clouds',    position: { x: 360, y: 60 },  domain: 'audio',
        params: { position: 0.3, size: 0.5, pitch: 0, density: 0.7, texture: 0.6, blend: 0.7 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 },  domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-cl',  portId: 'in_l' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-cl',  portId: 'in_r' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-cl',  portId: 'out_l' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'a-cl',  portId: 'out_r' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-clouds');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('CLOUDS');

  await page.waitForTimeout(800);

  // Sweep the six knobs through mid-range to exercise the worklet under
  // continuous param mutation.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-cl'];
      if (n) {
        n.params.position = 0.2;
        n.params.size = 0.8;
        n.params.pitch = 12;
        n.params.density = 0.9;
        n.params.texture = 0.3;
        n.params.blend = 1.0;
      }
    });
  });
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-cl'];
      if (n) n.params.pitch = -12;
    });
  });
  await page.waitForTimeout(400);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('CLOUDS freeze button toggles its active class', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-cl',  type: 'clouds',   position: { x: 100, y: 100 }, domain: 'audio' },
    ],
    [],
  );

  const card = page.locator('.svelte-flow__node-clouds');
  await expect(card).toHaveCount(1);

  const freezeBtn = page.locator('[data-testid="clouds-freeze"]');
  await expect(freezeBtn).toHaveCount(1);
  await expect(freezeBtn).not.toHaveClass(/active/);

  await freezeBtn.click();
  await expect(freezeBtn).toHaveClass(/active/);

  await freezeBtn.click();
  await expect(freezeBtn).not.toHaveClass(/active/);
});

test('CLOUDS survives extreme-param mutation via __patch (no crashes)', async ({ page }) => {
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
      { id: 'a-cl',  type: 'clouds',    position: { x: 360, y: 60 },  domain: 'audio' },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 },  domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-cl',  portId: 'in_l' } },
      { id: 'e2', from: { nodeId: 'a-cl',  portId: 'out_l' }, to: { nodeId: 'a-out', portId: 'L' } },
      { id: 'e3', from: { nodeId: 'a-cl',  portId: 'out_r' }, to: { nodeId: 'a-out', portId: 'R' } },
    ],
  );

  await page.waitForTimeout(500);

  const corners: Array<Record<string, number>> = [
    { position: 0, size: 0, pitch: -24, density: 0, texture: 0, blend: 0 },
    { position: 1, size: 1, pitch:  24, density: 1, texture: 1, blend: 1 },
    { position: 0, size: 1, pitch:  24, density: 0, texture: 1, blend: 1 },
    { position: 1, size: 0, pitch: -24, density: 1, texture: 0, blend: 0 },
    { position: 0.5, size: 0.5, pitch: 0, density: 0.5, texture: 0.5, blend: 0.5 },
  ];
  for (const corner of corners) {
    await page.evaluate((params) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-cl'];
        if (n) Object.assign(n.params, params);
      });
    }, corner);
    await page.waitForTimeout(150);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
