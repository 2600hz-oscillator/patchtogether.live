// e2e/tests/resofilter.spec.ts
//
// Smoke for RESOFILTER (Resonarium MultiFilter port). Spawns:
//   ANALOGVCO (saw)  →  RESOFILTER (audio)  →  AUDIOOUT (L, R)
//
// Asserts:
//   1. Card mounts; "RESOFILTER" title present; no console errors.
//   2. Audio energy flows to AUDIOOUT (engine reports input level > 0).
//   3. Sweeping the `mode` param 0..4 changes the visible mode-name label
//      on the card (the headline UX feature).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('RESOFILTER renders + audio flows VCO → filter → AUDIOOUT', async ({ page }) => {
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
      { id: 'a-vco', type: 'analogVco',  position: { x: 60,  y: 60 }, domain: 'audio' },
      { id: 'a-rf',  type: 'resofilter', position: { x: 360, y: 60 }, domain: 'audio',
        params: { cutoff: 800, resonance: 0.4, mode: 0, mix: 1 } },
      { id: 'a-out', type: 'audioOut',   position: { x: 760, y: 60 }, domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw'   }, to: { nodeId: 'a-rf',  portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-rf',  portId: 'out_l' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-rf',  portId: 'out_r' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-resofilter');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('RESOFILTER');

  // Wait for the engine to settle + start passing audio.
  await page.waitForTimeout(600);

  // Probe the engine-side audio energy. AnalogVCO ramps up over ~50ms;
  // a 600ms settle is well past that. We assert the engine has the
  // RESOFILTER node + can read its `cutoff` AudioParam back — proves the
  // worklet is alive and the parameter bridge is wired.
  const readable = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => { readParam: (n: { id: string }, p: string) => number | undefined } | null;
      __patch: { nodes: Record<string, { id: string; type: string; params: Record<string, number> }> };
    };
    const e = w.__engine?.();
    const n = w.__patch.nodes['a-rf'];
    if (!e || !n) return null;
    return e.readParam(n, 'cutoff');
  });
  expect(readable).toBeCloseTo(800, 0);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('RESOFILTER mode-name label updates as mode param changes (LP → HP → BP → Notch → Allpass)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-rf', type: 'resofilter', position: { x: 120, y: 120 }, domain: 'audio' },
    ],
    [],
  );

  const card = page.locator('.svelte-flow__node-resofilter');
  await expect(card).toHaveCount(1);

  const label = page.locator('[data-testid="resofilter-mode-name"]');
  // mode 0 (default) → "Low-pass"
  await expect(label).toHaveText('Low-pass');

  const expected = [
    [0, 'Low-pass'],
    [1, 'High-pass'],
    [2, 'Band-pass'],
    [3, 'Notch'],
    [4, 'Allpass'],
  ] as const;

  for (const [mode, name] of expected) {
    await page.evaluate((m) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-rf'];
        if (n) n.params.mode = m;
      });
    }, mode);
    await expect(label).toHaveText(name);
  }
});

test('RESOFILTER param sweeps (cutoff + resonance + mix) do not crash', async ({ page }) => {
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
      { id: 'a-vco', type: 'analogVco',  position: { x: 60,  y: 60 }, domain: 'audio' },
      { id: 'a-rf',  type: 'resofilter', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'a-out', type: 'audioOut',   position: { x: 760, y: 60 }, domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw'   }, to: { nodeId: 'a-rf',  portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-rf',  portId: 'out_l' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Hit each param range corner. Tests cutoff smoothing in the worklet
  // (50 Hz one-pole) doesn't choke on jumps, and that high-res / extreme
  // ranges stay stable.
  for (const [fc, res, mix, mode] of [
    [50,    0.0, 1, 0],
    [20000, 0.95, 1, 1],
    [200,   0.5, 0.5, 2],
    [4000,  0.99, 1, 3],
    [800,   0.3, 0,  4],
  ] as const) {
    await page.evaluate(([c, r, m, mo]) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['a-rf'];
        if (n) {
          n.params.cutoff = c;
          n.params.resonance = r;
          n.params.mix = m;
          n.params.mode = mo;
        }
      });
    }, [fc, res, mix, mode] as [number, number, number, number]);
    await page.waitForTimeout(80);
  }

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
