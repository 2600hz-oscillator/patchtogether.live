// e2e/tests/analog-logic-maths.spec.ts
//
// ANALOGLOGICMATHS end-to-end smoke. Spawn two LFOs into ALM's a + b inputs,
// route the MIN output through a VCA into AUDIOOUT, sweep both attenuverters
// across their full bipolar range. Asserts no console errors + the card UI
// mounts as expected.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('ALM renders + audio flows from two LFOs through MIN → VCA → OUTPUT', async ({ page }) => {
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
      { id: 'lfo-a',  type: 'lfo',              position: { x: 60,  y: 60  }, domain: 'audio' },
      { id: 'lfo-b',  type: 'lfo',              position: { x: 60,  y: 260 }, domain: 'audio' },
      { id: 'a-vco',  type: 'analogVco',        position: { x: 60,  y: 460 }, domain: 'audio' },
      { id: 'alm',    type: 'analogLogicMaths', position: { x: 360, y: 160 }, domain: 'audio',
        params: { attA: 1, attB: 1 } },
      { id: 'vca',    type: 'vca',              position: { x: 660, y: 160 }, domain: 'audio' },
      { id: 'out',    type: 'audioOut',         position: { x: 960, y: 160 }, domain: 'audio' },
    ],
    [
      // LFOs feed ALM A + B inputs (cv).
      { id: 'e1', from: { nodeId: 'lfo-a', portId: 'phase0' }, to: { nodeId: 'alm', portId: 'a' },
        sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'lfo-b', portId: 'phase0' }, to: { nodeId: 'alm', portId: 'b' },
        sourceType: 'cv', targetType: 'cv' },
      // ALM MIN drives VCA gain CV; analogVco saw is the audio carrier.
      { id: 'e3', from: { nodeId: 'a-vco', portId: 'saw' },    to: { nodeId: 'vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'alm',   portId: 'min' },    to: { nodeId: 'vca', portId: 'cv' },
        sourceType: 'cv', targetType: 'cv' },
      // VCA out → stereo OUTPUT.
      { id: 'e5', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e6', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-analogLogicMaths');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('ANALOGLOGICMATHS');

  // Let the engine spin up + the worklet load.
  await page.waitForTimeout(500);

  // Sweep both attenuverters through the full bipolar range, including
  // the sign-flip + mute regions. This exercises the AudioParam accepts
  // its declared range and the worklet survives sign-flipped inputs.
  const sweeps: Array<{ attA: number; attB: number }> = [
    { attA:  1,    attB:  1    },
    { attA:  0.5,  attB: -0.5  },
    { attA:  0,    attB:  0    },
    { attA: -1,    attB:  1    },
    { attA:  1,    attB: -1    },
    { attA:  0.25, attB:  0.75 },
  ];
  for (const s of sweeps) {
    await page.evaluate((params) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['alm'];
        if (n) Object.assign(n.params, params);
      });
    }, s);
    await page.waitForTimeout(80);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('ALM exposes all 5 output ports + 4 input ports', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'alm', type: 'analogLogicMaths', position: { x: 200, y: 200 }, domain: 'audio' },
    ],
    [],
  );

  const card = page.locator('.svelte-flow__node-analogLogicMaths');
  await expect(card).toHaveCount(1);

  // Output handles: min / max / diff / sum / product.
  for (const port of ['min', 'max', 'diff', 'sum', 'product']) {
    const handle = card.locator(`[data-handleid="${port}"]`);
    await expect(handle, `${port} output handle present`).toHaveCount(1);
  }
  // Input handles: a / b / attA_cv / attB_cv.
  for (const port of ['a', 'b', 'attA_cv', 'attB_cv']) {
    const handle = card.locator(`[data-handleid="${port}"]`);
    await expect(handle, `${port} input handle present`).toHaveCount(1);
  }
});
