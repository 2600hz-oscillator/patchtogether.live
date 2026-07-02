// e2e/tests/stages.spec.ts
//
// STAGES end-to-end smoke. Patches:
//   - card renders + type buttons cycle RAMP/HOLD/STEP/RAMP...
//   - link toggle flips visual state
//   - SEQUENCER → STAGES seg0 gate → VCA (CV from STAGES out0) → AUDIOOUT
//     audible output, no console errors.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('STAGES card renders + type button cycles through RAMP/HOLD/STEP', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [{ id: 's', type: 'stages', position: { x: 200, y: 200 } }],
    [],
  );

  const card = page.locator('.svelte-flow__node-stages');
  await expect(card).toBeVisible();
  await expect(card).toContainText('STAGES');

  const type0Btn = page.locator('[data-testid="stages-type0"]');
  await expect(type0Btn).toContainText('RAMP');
  await type0Btn.click();
  await expect(type0Btn).toContainText('HOLD');
  await type0Btn.click();
  await expect(type0Btn).toContainText('STEP');
  await type0Btn.click();
  await expect(type0Btn).toContainText('RAMP');

  expect(errors, errors.join('; ')).toEqual([]);
});

test('STAGES link toggle marks adjacent segments as chained', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [{ id: 's', type: 'stages', position: { x: 200, y: 200 } }],
    [],
  );

  const link0 = page.locator('[data-testid="stages-link0"]');
  await expect(link0).toBeVisible();
  // Default unlinked.
  await expect(link0).toHaveAttribute('aria-label', 'Unlinked');
  await link0.click();
  await expect(link0).toHaveAttribute('aria-label', 'Linked');
  await link0.click();
  await expect(link0).toHaveAttribute('aria-label', 'Unlinked');

  expect(errors, errors.join('; ')).toEqual([]);
});

test('STAGES routes a triggered envelope through a VCA to AUDIOOUT', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // SEQUENCER gate → STAGES seg0 GATE.
  // Configure seg0 = RAMP linked to seg1 = HOLD, so a single trigger
  // produces an attack→hold envelope on out0.
  // STAGES out0 → VCA cv input.
  // VCO sine → VCA audio input.
  // VCA audio out → AUDIOOUT L.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 60,  y: 60 } },
      { id: 'vco', type: 'analogVco', position: { x: 60,  y: 260 } },
      { id: 'st',  type: 'stages',    position: { x: 360, y: 60 },
        params: {
          type0: 0,    // RAMP
          primary0: 0.3,
          shape0: 0.5,
          type1: 1,    // HOLD
          primary1: 0.7,
          shape1: 0.0,
          link0: 1,    // link seg0↔seg1
        } },
      { id: 'vca', type: 'vca',       position: { x: 820, y: 200 } },
      { id: 'out', type: 'audioOut',  position: { x: 1180, y: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'st',  portId: 'gate0' },
        sourceType: 'gate',  targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'st',  portId: 'out0' }, to: { nodeId: 'vca', portId: 'cv' },
        sourceType: 'cv',    targetType: 'cv' },
      { id: 'e3', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Let the worklet run; sequencer fires gates throughout. We're not
  // asserting on raw audio here (covered by ART) — just that the patch
  // hangs together without errors and the card mutates cleanly.
  await page.waitForTimeout(800);

  // Mutate a param mid-render — links + type changes should not crash.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['st'];
      if (n) {
        n.params.type2 = 0;     // segment 2 → RAMP
        n.params.primary2 = 0.2;
        n.params.link1 = 1;     // chain seg1↔seg2 too
      }
    });
  });
  await page.waitForTimeout(400);

  expect(errors, errors.join('; ')).toEqual([]);
});
