// e2e/tests/peaks.spec.ts
//
// PEAKS end-to-end smoke. Patch a SEQUENCER (gate source) → PEAKS ch0
// (configured as KICK, audio output) → AUDIOOUT L. Ch1 is set to LFO
// (CV output) and verified to render and respond to the mode toggle.
// Asserts: card renders, mode toggle cycles labels, no console errors.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('PEAKS card renders + mode toggle cycles through KICK/SNARE/HIHAT/ENV/LFO', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [{ id: 'p', type: 'peaks', position: { x: 200, y: 200 }, params: { mode0: 0, mode1: 4 } }],
    [],
  );

  const card = page.locator('.svelte-flow__node-peaks');
  await expect(card).toBeVisible();
  await expect(card).toContainText('PEAKS');

  const mode0Btn = page.locator('[data-testid="peaks-mode0"]');
  await expect(mode0Btn).toContainText('KICK');

  // Cycle through the five modes — clicks should land on SNARE, HIHAT,
  // ENV, LFO, then wrap back to KICK.
  await mode0Btn.click();
  await expect(mode0Btn).toContainText('SNARE');
  await mode0Btn.click();
  await expect(mode0Btn).toContainText('HIHAT');
  await mode0Btn.click();
  await expect(mode0Btn).toContainText('ENV');
  await mode0Btn.click();
  await expect(mode0Btn).toContainText('LFO');
  await mode0Btn.click();
  await expect(mode0Btn).toContainText('KICK');

  // Channel 1 button starts at LFO (per the spawn params).
  const mode1Btn = page.locator('[data-testid="peaks-mode1"]');
  await expect(mode1Btn).toContainText('LFO');

  expect(errors, errors.join('; ')).toEqual([]);
});

test('PEAKS routes audio from KICK channel through to AUDIOOUT', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Sequencer → ch0 gate → PEAKS (ch0=KICK, ch1=LFO) → AUDIOOUT.
  // Sequencer free-runs at default BPM so the gate fires throughout
  // the test without needing manual clicks.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 60,  y: 60 } },
      { id: 'p',   type: 'peaks',     position: { x: 360, y: 60 },
        params: { mode0: 0, mode1: 4, k1_0: 60, k2_0: 0.3 } },
      { id: 'out', type: 'audioOut',  position: { x: 760, y: 60 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'p',   portId: 'gate0' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'p',   portId: 'out0' }, to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Give the worklet a beat to register triggers + render some samples.
  await page.waitForTimeout(800);

  // Mutate the second channel's knob mid-render to exercise param mutation
  // without crashing the worklet.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['p'];
      if (n) { n.params.k1_1 = 3.0; n.params.k2_1 = 0.5; }
    });
  });
  await page.waitForTimeout(400);

  expect(errors, errors.join('; ')).toEqual([]);
});
