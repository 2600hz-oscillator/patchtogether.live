// e2e/tests/sample-hold.spec.ts
//
// Smoke + behavior for SAMPLE & HOLD / quantizer. Modelled on
// e2e/tests/resofilter.spec.ts.
//
// Composite chain under test (the spec's headline scenario):
//
//   BUGGLES (slow CV)  →  sampleHold.cv_in
//   SEQUENCER (clock)  →  sampleHold.gate_in
//                         sampleHold.cv_quant  →  analogVco.pitch  →  SCOPE.ch1
//
// Asserts:
//   1. Card mounts; "SAMPLE & HOLD" title present; no console errors.
//   2. The quantized pitch drives the VCO and the SCOPE observes audio
//      energy (the whole chain is alive).
//   3. The SCALE knob's name label updates as the `scale` param changes.
//   4. CONTINUOUS-QUANTIZER variant: with NO gate patched, cv passes through
//      continuously and the VCO still sings (pure quantizer mode), and the
//      card's mode hint reads QUANTIZER.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, setNodeParams } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

test('SAMPLE & HOLD chain: BUGGLES → S&H (clocked) → VCO → SCOPE produces audio', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 's-buggles', type: 'buggles',    position: { x: 40,  y: 60 }, domain: 'audio' },
      { id: 's-seq',     type: 'sequencer',  position: { x: 40,  y: 300 }, domain: 'audio',
        params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 's-sh',      type: 'sampleHold', position: { x: 340, y: 60 }, domain: 'audio',
        params: { scale: 1 } },
      { id: 's-vco',     type: 'analogVco',  position: { x: 640, y: 60 }, domain: 'audio' },
      { id: 's-scope',   type: 'scope',      position: { x: 940, y: 60 }, domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 's-buggles', portId: 'smooth'   }, to: { nodeId: 's-sh',    portId: 'cv_in'   },
        sourceType: 'cv',   targetType: 'cv' },
      { id: 'e2', from: { nodeId: 's-seq',     portId: 'gate'     }, to: { nodeId: 's-sh',    portId: 'gate_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e3', from: { nodeId: 's-sh',      portId: 'cv_quant' }, to: { nodeId: 's-vco',   portId: 'pitch'   },
        sourceType: 'cv',   targetType: 'pitch' },
      { id: 'e4', from: { nodeId: 's-vco',     portId: 'saw'      }, to: { nodeId: 's-scope', portId: 'ch1'     },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-sampleHold');
  await expect(card).toHaveCount(1);
  // The editable ModuleTitle defaults to the auto-assigned node name
  // (the type slug uppercased, "SAMPLEHOLD") — same convention as RESOFILTER.
  await expect(card).toContainText('SAMPLEHOLD');

  // The VCO sings the quantized pitch — the SCOPE must see audio energy over
  // the drive window (the saw is continuous, so any held pitch yields signal).
  const obs = await readScopePeakOverWindow(page, 's-scope', 1200);
  expect(obs.peak, `scope peak over window: ${JSON.stringify(obs)}`).toBeGreaterThan(0.01);

});

test('SAMPLE & HOLD scale-name label updates as the scale param changes', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [{ id: 's-sh', type: 'sampleHold', position: { x: 120, y: 120 }, domain: 'audio' }],
    [],
  );

  const card = page.locator('.svelte-flow__node-sampleHold');
  await expect(card).toHaveCount(1);

  const label = page.locator('[data-testid="samplehold-scale-name"]');
  // default scale = 1 → "Major".
  await expect(label).toHaveText('Major');

  const expected = [
    [0, 'Chromatic'],
    [1, 'Major'],
    [2, 'Minor'],
    [3, 'Dorian'],
    [4, 'Phrygian'],
    [5, 'Lydian'],
    [6, 'Mixolydian'],
    [7, 'Locrian'],
    [8, 'Harmonic Minor'],
    [9, 'Melodic Minor'],
  ] as const;

  for (const [scale, name] of expected) {
    await setNodeParams(page, 's-sh', { scale: scale });
    await expect(label).toHaveText(name);
  }
});

test('SAMPLE & HOLD continuous-quantizer (no gate): cv passes through, VCO sings, hint=QUANTIZER', async ({ page, rack, errorWatch }) => {
  // NO sequencer / gate cable — sampleHold becomes a pure quantizer.
  await spawnPatch(
    page,
    [
      { id: 'q-buggles', type: 'buggles',    position: { x: 40,  y: 60 }, domain: 'audio' },
      { id: 'q-sh',      type: 'sampleHold', position: { x: 340, y: 60 }, domain: 'audio',
        params: { scale: 1 } },
      { id: 'q-vco',     type: 'analogVco',  position: { x: 640, y: 60 }, domain: 'audio' },
      { id: 'q-scope',   type: 'scope',      position: { x: 940, y: 60 }, domain: 'audio' },
    ],
    [
      { id: 'qe1', from: { nodeId: 'q-buggles', portId: 'smooth'   }, to: { nodeId: 'q-sh',    portId: 'cv_in'   },
        sourceType: 'cv',   targetType: 'cv' },
      { id: 'qe2', from: { nodeId: 'q-sh',      portId: 'cv_quant' }, to: { nodeId: 'q-vco',   portId: 'pitch'   },
        sourceType: 'cv',   targetType: 'pitch' },
      { id: 'qe3', from: { nodeId: 'q-vco',     portId: 'saw'      }, to: { nodeId: 'q-scope', portId: 'ch1'     },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-sampleHold');
  await expect(card).toHaveCount(1);

  // gate_in is unpatched → the card hints QUANTIZER mode.
  await expect(page.locator('[data-testid="samplehold-mode-hint"]')).toHaveText('QUANTIZER');

  // The continuously-quantized cv drives the VCO → audio reaches the scope.
  const obs = await readScopePeakOverWindow(page, 'q-scope', 1000);
  expect(obs.peak, `scope peak over window: ${JSON.stringify(obs)}`).toBeGreaterThan(0.01);

});
