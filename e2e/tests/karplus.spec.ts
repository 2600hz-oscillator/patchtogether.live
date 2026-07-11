// e2e/tests/karplus.spec.ts
//
// KARPLUS — REAL-SOURCE-CHAIN e2e (the CLAUDE.md discipline: a per-port
// "edge materializes" assert does NOT count as chain coverage). One test
// drives the full default-mode chain:
//
//   SEQUENCER (internal clock, ON steps @ MIDI 60) → karplus.trigger_in
//   SEQUENCER.pitch → karplus.pitch   (the 1 V/oct melodic path, 0 V = C4)
//   karplus.out → AUDIOOUT.L + R
//   karplus.out → SCOPE.ch1 (the _module-coverage-helpers scope tap)
//
// and asserts (1) AUDIBLE RMS at the output via windowed MAX-HOLD
// (readScopePeakOverWindow — flake-safe for plucked/decaying voices: a
// single analyser snapshot can land between plucks), and (2) a SPECTRAL
// check that the STRING actually rings at its sequenced fundamental
// (tune 220 Hz × 2^0V = 220 Hz): max-hold Goertzel power at 220 Hz beats
// every non-harmonic probe between the string's modes — a Karplus-Strong
// loop only resonates at k·f0, so off-mode probes stay starved.
//
// AUDIO-AVAILABILITY GATING: audio-only spec — no WebGL/renderer tolerance
// needed. The spectral loop only scores frames above an energy floor, and
// the RMS liveness assert runs FIRST, so an environment where the audio
// graph didn't run fails loudly rather than passing a vacuous check.
//
// Per-sample string behavior (tuning < 3 cents across C2–C7, ρ-compensated
// decay, stability extremes) is pinned deterministically in
// packages/dsp/src/lib/karplus-dsp.test.ts and the raw audio profile in ART
// (art/scenarios/karplus/profile.test.ts); this e2e proves the LIVE
// sequencer→pluck→audible-tuned-string chain.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, readScopeSnapshot } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

/** Hann-windowed Goertzel power at `hz` (the kickdrum.spec.ts helper). */
function goertzelPower(buf: ArrayLike<number>, sampleRate: number, hz: number): number {
  const n = buf.length;
  const omega = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    const q0 = coeff * q1 - q2 + (buf[i] as number) * win;
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

// The sequenced fundamental (tune 220 Hz, MIDI 60 = 0 V) vs NON-HARMONIC
// probes sitting between the string's modes (220·k): a K-S loop only
// resonates at its modes, so these stay starved while 220 rings.
const FUNDAMENTAL_HZ = 220;
const OFF_MODE_HZ = [155, 311, 550, 770];

test('KARPLUS real chain: SEQUENCER gate+pitch → pluck → AUDIOOUT — audible RMS + in-tune fundamental', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      // The REAL default-mode strike source: the sequencer's own internal
      // clock (isPlaying=1), not a synthetic gate injection.
      { id: 'a-seq', type: 'sequencer', position: { x: 60,  y: 60 }, domain: 'audio',
        params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.25 } },
      { id: 'a-ks',  type: 'karplus',   position: { x: 360, y: 60 }, domain: 'audio',
        params: { tune: 220, level: 0 } }, // shipping defaults otherwise
      { id: 'a-out', type: 'audioOut',  position: { x: 820, y: 60 }, domain: 'audio',
        params: { master: 0.3 } },
      { id: 'a-scp', type: 'scope',     position: { x: 820, y: 320 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-seq', portId: 'gate' },  to: { nodeId: 'a-ks',  portId: 'trigger_in' },
        sourceType: 'gate', targetType: 'gate' },
      // The melodic 1 V/oct path (polyPitchGate → pitch, engine-split).
      { id: 'e2', from: { nodeId: 'a-seq', portId: 'pitch' }, to: { nodeId: 'a-ks',  portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: 'e3', from: { nodeId: 'a-ks',  portId: 'out' },   to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'a-ks',  portId: 'out' },   to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e5', from: { nodeId: 'a-ks',  portId: 'out' },   to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  const card = page.locator('.svelte-flow__node-karplus');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(/KARPLUS/);

  // Seed ON steps @ MIDI 60 (= 0 V = keep tune's 220 Hz) so the internal
  // clock plucks the string (steps 0 + 2 → one pluck per second at BPM 120,
  // length 4 — the 2 s default decay keeps the string ringing between them).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['a-seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = [
        { on: true, midi: 60 },
        { on: false, midi: null },
        { on: true, midi: 60 },
        { on: false, midi: null },
        ...Array.from({ length: 28 }, () => ({ on: false, midi: null })),
      ];
    });
  });

  // ── 1. AUDIBLE RMS at the output (windowed MAX-HOLD — a pluck lands
  // every ~1 s and rings ~2 s, so a 2.5 s capture always observes ringing
  // string energy). A silent / wire-broken / never-plucked string never
  // crosses these floors in ANY frame. ──
  const CAPTURE_MS = 2500;
  const hold = await readScopePeakOverWindow(page, 'a-scp', CAPTURE_MS);
  expect(hold.polls, 'SCOPE was polled across the capture window').toBeGreaterThan(0);
  expect(hold.peak).toBeGreaterThan(0.03);
  expect(hold.rms).toBeGreaterThan(0.001);
  expect(hold.nonzeroSamples).toBeGreaterThan(50);

  // ── 2. SPECTRAL: the string rings AT ITS SEQUENCED PITCH. Max-hold
  // Goertzel at the 220 Hz fundamental must beat every off-mode probe —
  // the loop resonates only at k·f0, so a mistuned or noise-stuck voice
  // fails this. Only energetic frames are scored (non-vacuous per the
  // liveness assert above). ──
  const SPECTRAL_MS = 2500;
  const deadline = Date.now() + SPECTRAL_MS;
  let scored = 0;
  let maxFund = 0;
  const maxOff = new Map<number, number>(OFF_MODE_HZ.map((hz) => [hz, 0]));
  while (Date.now() < deadline) {
    const snap = await readScopeSnapshot(page, 'a-scp');
    if (snap) {
      const buf = snap.ch1;
      let energy = 0;
      for (let i = 0; i < buf.length; i++) energy += (buf[i] as number) ** 2;
      const rms = Math.sqrt(energy / Math.max(1, buf.length));
      if (rms > 1e-3) {
        scored++;
        maxFund = Math.max(maxFund, goertzelPower(buf, snap.sampleRate, FUNDAMENTAL_HZ));
        for (const hz of OFF_MODE_HZ) {
          maxOff.set(hz, Math.max(maxOff.get(hz)!, goertzelPower(buf, snap.sampleRate, hz)));
        }
      }
    }
    await page.waitForTimeout(60);
  }
  expect(scored, 'at least one energetic frame was spectrally scored').toBeGreaterThan(0);
  for (const hz of OFF_MODE_HZ) {
    expect(
      maxFund,
      `fundamental (${FUNDAMENTAL_HZ} Hz) power beats the off-mode probe at ${hz} Hz`,
    ).toBeGreaterThan(maxOff.get(hz)!);
  }
});
