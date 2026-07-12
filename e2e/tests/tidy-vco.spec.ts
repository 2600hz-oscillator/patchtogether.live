// e2e/tests/tidy-vco.spec.ts
//
// TIDY VCO — REAL-SOURCE-CHAIN e2e (the CLAUDE.md poly discipline: a
// per-port "edge materializes" assert does NOT count as poly coverage,
// and neither does an engine-direct ART/behavioral render). Three tests
// drive the full default-mode chains:
//
//   1. POLY:  POLYSEQZ (its OWN transport, isPlaying=1, seeded chord
//             steps) → tidyVco.poly → out_l → AUDIOOUT + SCOPE, audible
//             RMS via windowed max-hold. (The #674 lesson: the real
//             chord-bus chain must be audible, not an engine-class stub.)
//   2. MONO:  SEQUENCER (internal clock, ON steps @ MIDI 60) → gate +
//             pitch (polyPitchGate→cv lane-0 split) → out_l, audible RMS
//             PLUS a spectral proof the voice plays its SEQUENCED pitch
//             (max-hold Goertzel at the C4 fundamental beats every
//             non-harmonic probe).
//   3. NO STRAY DRONE: the same poly patch with the transport STOPPED
//             stays silent — the voice only speaks when gated (the
//             adsr-poly-midilane negative-control pattern).
//
// AUDIO-only spec — no WebGL/renderer tolerance needed; the spectral loop
// only scores frames above an energy floor and the RMS liveness assert
// runs FIRST, so an environment where the audio graph didn't run fails
// loudly rather than passing a vacuous check.
//
// Per-sample voice behavior (diode-ladder tuning gate, RC-ADSR curves,
// sonic-range proofs, stereo width laws) is pinned deterministically in
// packages/dsp/src/lib/tidy-vco-dsp*.test.ts and the raw audio profile in
// ART (art/scenarios/tidy-vco/profile.test.ts); this e2e proves the LIVE
// source→voice→audible-output chains.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, readScopeSnapshot } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

/** Hann-windowed Goertzel power at `hz` (the kickdrum/karplus helper). */
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

test('TIDY VCO poly chain: POLYSEQZ chord bus → voices → AUDIOOUT — audible RMS', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      // The REAL default-mode poly source: POLYSEQZ's own transport.
      { id: 'p-seq', type: 'polyseqz', position: { x: 40, y: 60 }, domain: 'audio',
        params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.6 } },
      { id: 'p-tv', type: 'tidyVco', position: { x: 420, y: 60 }, domain: 'audio',
        params: {} }, // shipping defaults — the default card must speak
      { id: 'p-out', type: 'audioOut', position: { x: 1050, y: 60 }, domain: 'audio',
        params: { master: 0.3 } },
      { id: 'p-scp', type: 'scope', position: { x: 1050, y: 320 }, domain: 'audio',
        params: { timeMs: 100 } },
    ],
    [
      { id: 'pe1', from: { nodeId: 'p-seq', portId: 'poly' }, to: { nodeId: 'p-tv', portId: 'poly' },
        sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'pe2', from: { nodeId: 'p-tv', portId: 'out_l' }, to: { nodeId: 'p-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'pe3', from: { nodeId: 'p-tv', portId: 'out_r' }, to: { nodeId: 'p-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'pe4', from: { nodeId: 'p-tv', portId: 'out_l' }, to: { nodeId: 'p-scp', portId: 'ch1' } },
    ],
  );

  const card = page.locator('.svelte-flow__node-tidyVco');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(/TIDY ?VCO/);

  // Seed gated chords so MULTIPLE voices play (the chord bus drives lanes
  // 0..n; the voice's default patch has sustain, so held steps ring).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['p-seq'];
      if (!seq) return;
      if (!seq.data) seq.data = {};
      seq.data.steps = [
        { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 57, quality: 'min', inversion: 0, voicing: 'closed' },
        { on: true, root: 65, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 62, quality: 'min', inversion: 0, voicing: 'closed' },
      ];
    });
  });

  // Audible RMS at the output via windowed MAX-HOLD (chords land every
  // 250 ms at BPM 240 — a 1.5 s capture always observes gated voices).
  const hold = await readScopePeakOverWindow(page, 'p-scp', 1500);
  expect(hold.polls, 'SCOPE was polled across the capture window').toBeGreaterThan(0);
  expect(hold.peak, 'the real POLYSEQZ→poly chain is audible').toBeGreaterThan(0.02);
  expect(hold.rms).toBeGreaterThan(0.001);
  expect(hold.nonzeroSamples).toBeGreaterThan(50);
});

// The sequenced fundamental (MIDI 60 = 0 V = C4 = 261.63 Hz) vs
// NON-HARMONIC probes (the spawn zeroes detune + sub, so the voice's
// spectrum is 261.63·k only; these probes sit between the harmonics).
const FUNDAMENTAL_HZ = 261.63;
const OFF_HARMONIC_HZ = [165, 220, 440, 660];

test('TIDY VCO mono chain: SEQUENCER gate+pitch → voice → audible RMS + in-tune fundamental', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      // The REAL default-mode mono source: the sequencer's internal clock.
      { id: 'm-seq', type: 'sequencer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'm-tv', type: 'tidyVco', position: { x: 420, y: 60 }, domain: 'audio',
        // detune/sub OFF so the spectral probe set is exact; long-ish
        // sustain so the gate window always carries tone.
        params: { detune: 0, sub: 0, width: 0, sus: 0.9, cutoff: 4000, env: 0 } },
      { id: 'm-out', type: 'audioOut', position: { x: 1050, y: 60 }, domain: 'audio',
        params: { master: 0.3 } },
      { id: 'm-scp', type: 'scope', position: { x: 1050, y: 320 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'me1', from: { nodeId: 'm-seq', portId: 'gate' }, to: { nodeId: 'm-tv', portId: 'gate' },
        sourceType: 'gate', targetType: 'gate' },
      // The melodic 1 V/oct path (polyPitchGate → cv, engine lane-0 split).
      { id: 'me2', from: { nodeId: 'm-seq', portId: 'pitch' }, to: { nodeId: 'm-tv', portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'cv' },
      { id: 'me3', from: { nodeId: 'm-tv', portId: 'out_l' }, to: { nodeId: 'm-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'me4', from: { nodeId: 'm-tv', portId: 'out_r' }, to: { nodeId: 'm-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'me5', from: { nodeId: 'm-tv', portId: 'out_l' }, to: { nodeId: 'm-scp', portId: 'ch1' } },
    ],
  );

  // Seed ON steps @ MIDI 60 (= 0 V = C4) so the internal clock gates the
  // voice twice per cycle.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['m-seq'];
      if (!seq) return;
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

  // ── 1. AUDIBLE RMS (windowed max-hold: a gate opens every second and
  // holds ~250 ms, so a 2.5 s capture always observes the voice). ──
  const hold = await readScopePeakOverWindow(page, 'm-scp', 2500);
  expect(hold.polls, 'SCOPE was polled across the capture window').toBeGreaterThan(0);
  expect(hold.peak, 'the real SEQUENCER→gate/pitch chain is audible').toBeGreaterThan(0.03);
  expect(hold.rms).toBeGreaterThan(0.001);
  expect(hold.nonzeroSamples).toBeGreaterThan(50);

  // ── 2. SPECTRAL: the voice plays its SEQUENCED pitch. Max-hold
  // Goertzel at the C4 fundamental must beat every non-harmonic probe.
  // Only energetic frames are scored (non-vacuous per the liveness
  // assert above). ──
  const SPECTRAL_MS = 2500;
  const deadline = Date.now() + SPECTRAL_MS;
  let scored = 0;
  let maxFund = 0;
  const maxOff = new Map<number, number>(OFF_HARMONIC_HZ.map((hz) => [hz, 0]));
  while (Date.now() < deadline) {
    const snap = await readScopeSnapshot(page, 'm-scp');
    if (snap) {
      const buf = snap.ch1;
      let energy = 0;
      for (let i = 0; i < buf.length; i++) energy += (buf[i] as number) ** 2;
      const rms = Math.sqrt(energy / Math.max(1, buf.length));
      if (rms > 1e-3) {
        scored++;
        maxFund = Math.max(maxFund, goertzelPower(buf, snap.sampleRate, FUNDAMENTAL_HZ));
        for (const hz of OFF_HARMONIC_HZ) {
          maxOff.set(hz, Math.max(maxOff.get(hz)!, goertzelPower(buf, snap.sampleRate, hz)));
        }
      }
    }
    await page.waitForTimeout(60);
  }
  expect(scored, 'at least one energetic frame was spectrally scored').toBeGreaterThan(0);
  for (const hz of OFF_HARMONIC_HZ) {
    expect(
      maxFund,
      `fundamental (${FUNDAMENTAL_HZ} Hz) power beats the non-harmonic probe at ${hz} Hz`,
    ).toBeGreaterThan(maxOff.get(hz)!);
  }
});

test('TIDY VCO no stray drone: patched but never gated stays silent', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      // Transport STOPPED — the chord bus exists but no lane ever gates.
      { id: 'n-seq', type: 'polyseqz', position: { x: 40, y: 60 }, domain: 'audio',
        params: { isPlaying: 0 } },
      { id: 'n-tv', type: 'tidyVco', position: { x: 420, y: 60 }, domain: 'audio', params: {} },
      { id: 'n-scp', type: 'scope', position: { x: 1050, y: 60 }, domain: 'audio',
        params: { timeMs: 100 } },
    ],
    [
      { id: 'ne1', from: { nodeId: 'n-seq', portId: 'poly' }, to: { nodeId: 'n-tv', portId: 'poly' },
        sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'ne2', from: { nodeId: 'n-tv', portId: 'out_l' }, to: { nodeId: 'n-scp', portId: 'ch1' } },
    ],
  );

  const hold = await readScopePeakOverWindow(page, 'n-scp', 1200);
  expect(hold.polls).toBeGreaterThan(0);
  expect(hold.peak, 'ungated voice must be silent (no stray drone)').toBeLessThan(0.01);
});
