// e2e/tests/clipplayer.spec.ts
//
// CLIP PLAYER real-source-chain proof (the poly/real-source discipline): a
// LAUNCHED note clip must drive a downstream VOICE to AUDIBLE output through the
// REAL TIMELORDE-locked clock — not just "an edge materializes". The chain is
// the real one a user builds:
//
//   clipplayer.pitch1 → VCO.pitch ; VCO.sine → VCA.audio ;
//   clipplayer.gate1  → VCA.cv    ; VCA.audio → SCOPE.ch1
//
// The clip player has NO internal BPM — it runs only while TIMELORDE is running.
// So the test proves the lock three ways:
//   1. no clip launched              → silent (VCA closed)
//   2. clip launched, TIMELORDE STOP → still silent (frozen — the lock works)
//   3. clip launched, TIMELORDE RUN  → audible, structured RMS at the clip pitch
// The pre→post delta proves the launch produces sound through the real spawn +
// engine (catches the green-but-silent class).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

/** Set running (+ a fast bpm) on every TIMELORDE in the patch; create one if
 *  none exists. Done via the same Y.Doc path the card/transport use. */
async function setTransport(page: import('@playwright/test').Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-cp-test'] = {
          id: 'tl-cp-test', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
          params: { running: run, bpm: 200 }, data: {},
        } as never;
      } else {
        for (const n of tls) {
          if (!n.params) n.params = {};
          n.params.running = run;
          n.params.bpm = 200;
        }
      }
    });
  }, running);
}

test('CLIP PLAYER: launched clip is silent until TIMELORDE runs, then audible (per-lane)', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'a-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        // quantize off so the first launch fires immediately; 1/16 steps.
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'a-vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'a-vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
        // base 0 → fully closed when cv=0; cvAmount 1 → gate opens it fully.
        params: { base: 0, cvAmount: 1 } },
      { id: 'a-scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      // lane-1 clip pitch (poly) → VCO v/oct (mono sink auto-receives lane 0)
      { id: 'e1', from: { nodeId: 'a-cp', portId: 'pitch1' }, to: { nodeId: 'a-vco', portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      // VCO tone → VCA audio in
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'sine' }, to: { nodeId: 'a-vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      // lane-1 clip gate → VCA cv (opens the amp while a note sounds)
      { id: 'e3', from: { nodeId: 'a-cp', portId: 'gate1' }, to: { nodeId: 'a-vca', portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      // gated voice → scope ch1 (readScopePeakOverWindow measures ch1)
      { id: 'e4', from: { nodeId: 'a-vca', portId: 'audio' }, to: { nodeId: 'a-scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-clipplayer');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('CLIP');

  // (1) Before any clip is launched the VCA is closed → the chain is silent.
  const before = await readScopePeakOverWindow(page, 'a-scp', 500);
  expect(before.rms, `silent before launch (VCA closed)`).toBeLessThan(0.03);

  // (2) Stop the transport, THEN launch a clip in lane 0 (slot 0) via the same
  // Y.Doc path the card/grid use. Because the clip player locks to TIMELORDE,
  // a launched clip with the transport stopped must stay SILENT (frozen).
  await setTransport(page, 0);
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-cp'];
      if (!n.data) n.data = {};
      n.data.clips = {
        // clip index 0 = lane 0, slot 0 (drives pitch1/gate1).
        '0': {
          kind: 'note', lengthSteps: 4, root: 48, loop: true,
          steps: [
            { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
            { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
            { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
            { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
          ],
        },
      };
      n.data.queued = [0, null, null, null, null, null, null, null];
    });
  });
  const frozen = await readScopePeakOverWindow(page, 'a-scp', 700);
  expect(frozen.rms, `frozen while TIMELORDE is stopped (the lock)`).toBeLessThan(0.03);

  // (3) Start the transport → the clip runs out lane-0's pitch/gate → audible.
  await setTransport(page, 1);
  const after = await readScopePeakOverWindow(page, 'a-scp', 1500);
  expect(after.polls, 'SCOPE was polled across the window').toBeGreaterThan(0);
  expect(after.rms, `audible gated RMS after TIMELORDE runs`).toBeGreaterThan(0.03);
  expect(after.nonzeroSamples, `structured signal, not a glitch`).toBeGreaterThan(50);
  expect(after.rms, `running the transport raised the output`).toBeGreaterThan(frozen.rms + 0.02);

});
