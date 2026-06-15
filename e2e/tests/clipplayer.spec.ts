// e2e/tests/clipplayer.spec.ts
//
// CLIPPLAYER real-source-chain proof (the poly/real-source discipline): a
// LAUNCHED note clip must drive a downstream VOICE to AUDIBLE output — not just
// "an edge materializes". The chain is the real one a user builds:
//
//   clipplayer.pitch → VCO.pitch ; VCO.sine → VCA.audio ;
//   clipplayer.gate  → VCA.cv    ; VCA.audio → SCOPE.ch1
//
// With NO clip launched the VCA is closed (gate=0 → cv=0, base=0) so ch1 is
// silent. After launching a note clip (set node.data via the same Y.Doc path
// the card/grid use), the clip's gate pulses the VCA open at the clip's pitch →
// audible, structured RMS at the scope. The pre→post delta proves the launch
// actually produces sound through the real spawn + engine (catches the
// green-but-silent class).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

test('CLIPPLAYER: launched note clip → VCO+VCA → audible gated RMS (silent until launch)', async ({
  page,
}) => {
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
      { id: 'a-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        // quantize off so the first launch fires immediately; fast tempo so the
        // gate pulses land inside the measurement window.
        params: { quantize: 0, bpm: 240, gateLength: 0.9, octave: 0 } },
      { id: 'a-vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'a-vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
        // base 0 → fully closed when cv=0; cvAmount 1 → gate opens it fully.
        params: { base: 0, cvAmount: 1 } },
      { id: 'a-scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      // clip pitch (poly) → VCO v/oct (mono sink auto-receives lane 0)
      { id: 'e1', from: { nodeId: 'a-cp', portId: 'pitch' }, to: { nodeId: 'a-vco', portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      // VCO tone → VCA audio in
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'sine' }, to: { nodeId: 'a-vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      // clip gate → VCA cv (opens the amp while a note sounds)
      { id: 'e3', from: { nodeId: 'a-cp', portId: 'gate' }, to: { nodeId: 'a-vca', portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      // gated voice → scope ch1 (readScopePeakOverWindow measures ch1)
      { id: 'e4', from: { nodeId: 'a-vca', portId: 'audio' }, to: { nodeId: 'a-scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-clipplayer');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('CLIPPLAYER');

  // Before any clip is launched the VCA is closed → the chain is silent.
  const before = await readScopePeakOverWindow(page, 'a-scp', 500);
  expect(before.rms, `silent before launch (VCA closed)`).toBeLessThan(0.03);

  // Launch a note clip via the same Y.Doc path the card/grid use: seed clip 0
  // (a 4-step pattern, midi 72+ so V/oct ≠ 0) and queue it. quantize off →
  // it takes over on the next tick and runs out pitch + gate.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-cp'];
      if (!n.data) n.data = {};
      n.data.clips = {
        '0': {
          kind: 'note',
          lengthSteps: 4,
          root: 48,
          loop: true,
          steps: [
            { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
            { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
            { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
            { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
          ],
        },
      };
      n.data.queued = '0';
    });
  });

  // Max-hold over a window so the assertion is renderer/timing-tolerant on CI.
  const after = await readScopePeakOverWindow(page, 'a-scp', 1500);
  expect(after.polls, 'SCOPE was polled across the window').toBeGreaterThan(0);
  expect(after.rms, `audible gated RMS after launching the clip`).toBeGreaterThan(0.03);
  expect(after.nonzeroSamples, `structured signal, not a glitch`).toBeGreaterThan(50);
  expect(after.rms, `launching the clip raised the output`).toBeGreaterThan(before.rms + 0.02);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
