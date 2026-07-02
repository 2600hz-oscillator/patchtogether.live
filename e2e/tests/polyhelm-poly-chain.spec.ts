// e2e/tests/polyhelm-poly-chain.spec.ts
//
// REAL-CHAIN regression for POLYHELM's poly-bus input — the gap that let the
// "POLYHELM produces no audio" bug (#674) ship.
//
// The ART poly-chord + behavioral tests drove the SHARED HelmEngine class
// DIRECTLY (synthetic engine.noteOnLane()), so they proved the voice math but
// NEVER exercised the live worklet, the poly→poly AudioWorkletNode channel
// delivery, the ChannelSplitter output, OR the MIDI-LANE poly-mode path. This
// spec mirrors the EXACT user patch:
//
//   MIDI LANE (poly mode) --poly--> POLYHELM --out_l/out_r--> SCOPE
//
// and plays notes via the same fake-Web-MIDI harness the MIDI specs use, then
// asserts the OUTPUT (a SCOPE standing in for OUTPUT-to-speakers) carries
// non-silent audio. A second control test drives POLYSEQZ.poly → POLYHELM.poly
// to isolate the worklet poly path from the MIDI-LANE poly-mode discoverability
// concern.
//
// CI is on a software renderer; audio-capture e2e is slow there, so per-test
// timeouts scale with the number of capture windows.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';
import { installMidiMock, sendNoteOn } from '../_helpers/midi';

test.describe.configure({ mode: 'parallel' });

const CAPTURE_MS = 700;
function timeoutFor(captureWindows: number): number {
  return 30_000 + captureWindows * 8_000;
}

/** Reach into the engine + call a MIDI-LANE card-api method by name. */
async function laneCardApi(
  page: import('@playwright/test').Page,
  laneId: string,
  method: 'connect' | 'setModePoly',
): Promise<void> {
  await page.evaluate(
    async ({ id, m }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return;
      const api = eng.read(node, 'card-api') as
        | { connect: () => Promise<boolean>; setMode: (mode: 'mono' | 'poly') => void }
        | undefined;
      if (!api) return;
      if (m === 'connect') await api.connect();
      else if (m === 'setModePoly') api.setMode('poly');
    },
    { id: laneId, m: method },
  );
}

// This is the PRIMARY regression for #674: it does NOT switch MIDI LANE to poly
// mode — it leaves the lane in its DEFAULT mono mode, exactly as a user gets it
// when they drop the module and wire the POLY port. Before the fix the poly bus
// fed silent gates in mono mode (peak = 0). After the fix the POLY port is
// always live, so the chord plays.
test('REAL CHAIN: MIDI LANE (default mode) → POLYHELM → OUTPUT plays audible notes', async ({ page }) => {
  test.setTimeout(timeoutFor(1));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await installMidiMock(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // The exact user patch: MIDI LANE --poly--> POLYHELM --out_l/out_r--> SCOPE
  // (SCOPE stands in for OUTPUT — OUTPUT goes to speakers, which a headless
  // test can't read; the audio path up to out_l/out_r is identical).
  await spawnPatch(
    page,
    [
      { id: 'lane', type: 'midiLane', position: { x: 40, y: 60 }, domain: 'audio' },
      { id: 'ph', type: 'polyhelm', position: { x: 360, y: 60 }, domain: 'audio',
        params: { voiceCount: 6, volume: 1, ampAttack: 0.01, ampDecay: 0.1, ampSustain: 0.9, ampRelease: 0.4, filterCutoff: 12000 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_lane_ph', from: { nodeId: 'lane', portId: 'poly' }, to: { nodeId: 'ph', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'e_ph_sc',   from: { nodeId: 'ph', portId: 'out_l' },  to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Wire the lane's MIDI handler (the card calls connect() once). We DELIBERATELY
  // do NOT switch to poly mode — the lane stays in its DEFAULT mono mode, which
  // is what a user has after just dropping the module. The POLY port must still
  // play (the #674 fix). The mono pitch_cv/gate path is asserted separately.
  await laneCardApi(page, 'lane', 'connect');

  // Play a held C-major triad on channel 1 (notes stay down for the window).
  await sendNoteOn(page, 1, 60, 100); // C4
  await sendNoteOn(page, 1, 64, 100); // E4
  await sendNoteOn(page, 1, 67, 100); // G4

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(
    peak,
    'POLYHELM out_l must carry audio when MIDI LANE (poly) plays notes',
  ).toBeGreaterThan(0.01);
  expect(errors, 'no console / page errors').toEqual([]);
});

test('CONTROL: POLYSEQZ chord → POLYHELM.poly → OUTPUT carries audio (worklet poly path)', async ({ page }) => {
  test.setTimeout(timeoutFor(1));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // POLYSEQZ.poly → POLYHELM.poly → SCOPE — a self-running poly source, so this
  // isolates POLYHELM's worklet poly→voices→stereo-split path from MIDI LANE.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'polyseqz', position: { x: 40, y: 60 }, domain: 'audio', params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.6 } },
      { id: 'ph', type: 'polyhelm', position: { x: 360, y: 60 }, domain: 'audio',
        params: { voiceCount: 6, volume: 1, ampAttack: 0.01, ampDecay: 0.1, ampSustain: 0.9, ampRelease: 0.3, filterCutoff: 12000 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_ph', from: { nodeId: 'seq', portId: 'poly' }, to: { nodeId: 'ph', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'e_ph_sc',  from: { nodeId: 'ph', portId: 'out_l' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Seed a gated chord so multiple lanes fire (each drives its own voice).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['seq'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.steps = [
        { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 64, quality: 'min', inversion: 0, voicing: 'closed' },
        { on: true, root: 67, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 72, quality: 'maj', inversion: 0, voicing: 'closed' },
      ];
    });
  });

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'POLYHELM out_l must carry audio when a POLYSEQZ chord gates the voices').toBeGreaterThan(0.01);
  expect(errors, 'no console / page errors').toEqual([]);
});

test('FALLBACK: mono pitch_cv/gate (SEQUENCER) → POLYHELM still sounds (mono path preserved)', async ({ page }) => {
  test.setTimeout(timeoutFor(1));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // SEQUENCER.pitch → POLYHELM.pitch_cv + SEQUENCER.gate → POLYHELM.gate — the
  // legacy mono single-voice fallback (HELM parity). Must still play.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.6 } },
      { id: 'ph', type: 'polyhelm', position: { x: 360, y: 60 }, domain: 'audio',
        params: { voiceCount: 4, volume: 1, ampAttack: 0.01, ampDecay: 0.1, ampSustain: 0.9, ampRelease: 0.3, filterCutoff: 12000 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_p', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'ph', portId: 'pitch_cv' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e_seq_g', from: { nodeId: 'seq', portId: 'gate' },  to: { nodeId: 'ph', portId: 'gate' },     sourceType: 'gate', targetType: 'gate' },
      { id: 'e_ph_sc', from: { nodeId: 'ph', portId: 'out_l' },  to: { nodeId: 'sc', portId: 'ch1' },      sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Seed always-on steps so the gate fires every step.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['seq'];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
    });
  });

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'POLYHELM out_l must carry audio via the mono pitch_cv/gate fallback').toBeGreaterThan(0.01);
  expect(errors, 'no console / page errors').toEqual([]);
});
