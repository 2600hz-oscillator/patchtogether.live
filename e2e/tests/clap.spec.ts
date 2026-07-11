// e2e/tests/clap.spec.ts
//
// CLAP — REAL-SOURCE-CHAIN e2e (the CLAUDE.md discipline: a per-port
// "edge materializes" assert does NOT count as chain coverage). One test
// drives the full default-mode chain:
//
//   SEQUENCER (internal clock, ON steps) → clap.trigger_in
//   clap.audio_out → AUDIOOUT.L / R (mono voice into both sides)
//   clap.audio_out → SCOPE.ch1 (the _module-coverage-helpers scope tap)
//
// and asserts (1) AUDIBLE RMS at the output via windowed MAX-HOLD
// (readScopePeakOverWindow — flake-safe for percussive/decaying voices: a
// single analyser snapshot can land in the inter-hit gap), and (2) a
// SPECTRAL check that the CLAP BAND (the 1 kHz default band-pass center
// ± its width) dominates both the LOW (kick/tom) band and the HIGH band —
// real strikes producing the band-passed noise voice, not just "some
// signal" — measured with windowed max-hold Goertzel band energies on the
// scope's time-domain tap.
//
// This is an audio-only spec — no WebGL/renderer tolerance needed. The
// spectral assert is gated on the SAME captured frames having real energy
// (the RMS liveness assert runs FIRST on the max-hold window, and the
// spectral loop only scores frames above an energy floor), so a CI
// environment where the audio graph genuinely didn't run fails the
// liveness assert loudly rather than passing a vacuous spectral check.
//
// Per-sample clap SHAPE (burst scheduler, control laws, the sonic-range
// proofs) is pinned deterministically in the DSP unit tier
// (packages/dsp/src/lib/clap-dsp.test.ts) and the raw audio profile in
// ART (art/scenarios/clap/profile.test.ts); this e2e proves the LIVE
// trigger→clap→audible-band-passed-noise chain.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, readScopeSnapshot } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

/** Hann-windowed Goertzel power at `hz` (the kickdrum/tomtom spec helper). */
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

// Band probes: the CLAP band (default tone 1000 Hz band-pass at width 0.5
// — roughly 600-1700 Hz of energy) vs the LOW band (kick/tom territory,
// which a band-passed noise voice must NOT fill) and the HIGH band well
// above the filter skirt.
const CLAP_BAND_HZ = [700, 850, 1000, 1200, 1500];
const LOW_BAND_HZ = [60, 90, 130, 200];
const HIGH_BAND_HZ = [5000, 6400, 8000];

test('CLAP real chain: SEQUENCER → trigger_in → AUDIOOUT — audible RMS + clap-band-dominant spectrum', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      // The REAL default-mode trigger source: the sequencer's own internal
      // clock (isPlaying=1), not a synthetic gate injection.
      { id: 'a-seq', type: 'sequencer', position: { x: 60,  y: 60 }, domain: 'audio',
        params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.25 } },
      { id: 'a-clp', type: 'clap',      position: { x: 360, y: 60 }, domain: 'audio',
        params: { level: 0 } }, // shipping defaults otherwise (808 canonical)
      { id: 'a-out', type: 'audioOut',  position: { x: 820, y: 60 }, domain: 'audio',
        params: { master: 0.3 } },
      { id: 'a-scp', type: 'scope',     position: { x: 820, y: 320 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-seq', portId: 'gate' },      to: { nodeId: 'a-clp', portId: 'trigger_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'a-clp', portId: 'audio_out' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-clp', portId: 'audio_out' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'a-clp', portId: 'audio_out' }, to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  const card = page.locator('.svelte-flow__node-clap');
  await expect(card).toHaveCount(1);
  // The title renders the auto-assigned node name (type-uppercased →
  // "CLAP", possibly numbered) — the def label is also "clap".
  await expect(card).toContainText(/CLAP/);

  // Seed a few ON steps so the internal clock fires the clap (steps 0 + 2
  // → one strike every second at BPM 120 / length 4).
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

  // ── 1. AUDIBLE RMS at the output (windowed MAX-HOLD — a strike lands
  // every ~1 s, so a 2.5 s capture always straddles ≥2 attacks; max-hold
  // deterministically observes the loud attack frame regardless of
  // analyser phase). A silent / wire-broken / never-triggered clap never
  // crosses these floors in ANY frame. ──
  const CAPTURE_MS = 2500;
  const hold = await readScopePeakOverWindow(page, 'a-scp', CAPTURE_MS);
  expect(hold.polls, 'SCOPE was polled across the capture window').toBeGreaterThan(0);
  expect(hold.peak).toBeGreaterThan(0.05);
  expect(hold.rms).toBeGreaterThan(0.001);
  expect(hold.nonzeroSamples).toBeGreaterThan(50);

  // ── 2. SPECTRAL: the clap band dominates BOTH the low band and the
  // high band (windowed max-hold band energies). Only frames with real
  // energy are scored — the liveness assert above already proved audio is
  // available, so requiring scored frames here keeps the spectral claim
  // non-vacuous. ──
  const SPECTRAL_MS = 2500;
  const deadline = Date.now() + SPECTRAL_MS;
  let scored = 0;
  let sumClap = 0;
  let sumLow = 0;
  let sumHigh = 0;
  let maxClap = 0;
  let maxOther = 0;
  let bestRatio = 0;
  while (Date.now() < deadline) {
    const snap = await readScopeSnapshot(page, 'a-scp');
    if (snap) {
      const buf = snap.ch1;
      let energy = 0;
      for (let i = 0; i < buf.length; i++) energy += (buf[i] as number) ** 2;
      const rms = Math.sqrt(energy / Math.max(1, buf.length));
      if (rms > 1e-3) {
        let clapE = 0;
        for (const hz of CLAP_BAND_HZ) clapE += goertzelPower(buf, snap.sampleRate, hz);
        let lowE = 0;
        for (const hz of LOW_BAND_HZ) lowE += goertzelPower(buf, snap.sampleRate, hz);
        let highE = 0;
        for (const hz of HIGH_BAND_HZ) highE += goertzelPower(buf, snap.sampleRate, hz);
        scored++;
        sumClap += clapE;
        sumLow += lowE;
        sumHigh += highE;
        if (clapE > maxClap) maxClap = clapE;
        const other = lowE + highE;
        if (other > maxOther) maxOther = other;
        const ratio = clapE / Math.max(1e-12, clapE + other);
        if (ratio > bestRatio) bestRatio = ratio;
      }
    }
    await page.waitForTimeout(60);
  }
  expect(scored, 'at least one energetic frame was spectrally scored').toBeGreaterThan(0);
  // The best-observed frame is overwhelmingly the band-passed clap voice…
  expect(bestRatio).toBeGreaterThan(0.8);
  // …and across ALL scored frames the clap band out-carries each fringe
  // band — "the 1 kHz band-pass dominates", not just "noise exists".
  expect(sumClap).toBeGreaterThan(sumLow);
  expect(sumClap).toBeGreaterThan(sumHigh);
  // Max-hold agreement: the loudest clap-band frame beats the loudest
  // fringe-band frame.
  expect(maxClap).toBeGreaterThan(maxOther);
});
