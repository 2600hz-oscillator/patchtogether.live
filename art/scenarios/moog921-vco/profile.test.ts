// art/scenarios/moog921-vco/profile.test.ts
//
// AUDIO PROFILE for MOOG 921 VCO (backfill batch 3 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + worklet.ts).
//
// Category: self-driving SOURCE — params only (spec §4.2). Patch: the
// SHIPPING DEFAULTS (octave 0, tune 0 → C4 off the codebase's 1V/oct 0 V
// reference; width 0.5 → square; level 1; sync off; no FM), 0.5 s steady.
//
// SIGNATURE outputs (owner decision §6b.2): ALL FOUR waveform jacks —
// sine / triangle / sawtooth / rectangular. Like the hardware, the four
// jacks ride ONE shared phase accumulator and carry genuinely different
// spectra (the polyBLEP/polyBLAMP band-limited shapes), so each gets its
// own baseline (the analog-vco per-waveform precedent).
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — moog921-vco.ts is self-contained pure math (MoogVco polyBLEP
// core + the WtParamSmoother knob smoothers, which sit exactly AT their
// primed defaults here, so they pass the constants through). No RNG.
//
// The .sha pins the worklet entry AND both libs its per-sample path runs
// through (moog-vco-dsp + wavetable-osc for the smoothers).

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { C4_HZ } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 0.5;

const OUTPUTS = ['sine', 'triangle', 'sawtooth', 'rectangular'] as const;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'moog921-vco',
    () => import('../../../packages/dsp/src/moog921-vco'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs: pitch / lin_fm / sync / width_cv — all unpatched (pitch 0 V = C4).
    inputs: [null, null, null, null],
    // Shipping defaults, spelled explicitly so the patch is pinned by this file.
    params: { octave: 0, tune: 0, width: 0.5, linFmAmount: 0, sync: 0, level: 1 },
    outputs: [...OUTPUTS],
  });
}

/** Goertzel magnitude (normalized 2/N) of freqHz over the whole buffer. */
function goertzel(buf: Float32Array, freqHz: number): number {
  const N = buf.length;
  const w = (2 * Math.PI * freqHz) / SR;
  const coeff = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < N; i++) {
    const q0 = coeff * q1 - q2 + buf[i]!;
    q2 = q1;
    q1 = q0;
  }
  const re = q1 - q2 * Math.cos(w);
  const im = q2 * Math.sin(w);
  return (2 / N) * Math.sqrt(re * re + im * im);
}

const peakAbs = (buf: Float32Array) => {
  let p = 0;
  for (const v of buf) p = Math.max(p, Math.abs(v));
  return p;
};

describe('ART moog921-vco / audio profile (C4 default patch — all four waveform jacks)', () => {
  it('renders four phase-coherent C4 waveforms with their textbook spectra', async () => {
    const bufs = await renderProfile();
    const n = Math.round(SR * DURATION_S);
    for (const k of OUTPUTS) {
      expect(bufs[k]!.length).toBe(n);
      expect(bufs[k]!.every(Number.isFinite)).toBe(true);
      // All four jacks share the C4 fundamental…
      expect(goertzel(bufs[k]!, C4_HZ)).toBeGreaterThan(0.4);
      // …at sensible analog levels (±1-ish; small polyBLEP overshoot OK).
      expect(peakAbs(bufs[k]!)).toBeGreaterThan(0.9);
      expect(peakAbs(bufs[k]!)).toBeLessThan(1.3);
    }

    const H2 = C4_HZ * 2;
    const H3 = C4_HZ * 3;
    // SINE: no harmonics.
    expect(goertzel(bufs.sine!, H2)).toBeLessThan(0.02);
    expect(goertzel(bufs.sine!, H3)).toBeLessThan(0.02);
    // SAWTOOTH: the full comb — strong 2nd (≈1/2 of fundamental).
    expect(goertzel(bufs.sawtooth!, H2)).toBeGreaterThan(0.2);
    expect(goertzel(bufs.sawtooth!, H3)).toBeGreaterThan(0.1);
    // RECTANGULAR at width 0.5 (square): odd harmonics only — 3rd strong
    // (≈1/3 of fundamental), 2nd suppressed.
    expect(goertzel(bufs.rectangular!, H3)).toBeGreaterThan(0.25);
    expect(goertzel(bufs.rectangular!, H2)).toBeLessThan(0.05);
    // TRIANGLE: odd harmonics falling as 1/k² — a faint 3rd, no 2nd.
    const triH3 = goertzel(bufs.triangle!, H3);
    expect(triH3).toBeGreaterThan(0.03);
    expect(triH3).toBeLessThan(0.15);
    expect(goertzel(bufs.triangle!, H2)).toBeLessThan(0.02);
    // Spectral ordering of "brightness" at the 3rd harmonic:
    // saw ≳ square > triangle > sine.
    expect(goertzel(bufs.rectangular!, H3)).toBeGreaterThan(triH3);
    expect(triH3).toBeGreaterThan(goertzel(bufs.sine!, H3));

    // Deterministic re-render is bit-identical (fresh processor instance).
    const again = await renderProfile();
    for (const k of OUTPUTS) {
      let diff = 0;
      for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(bufs[k]![i]! - again[k]![i]!));
      expect(diff).toBe(0);
    }
  });

  it('pins the four waveform profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'moog921-vco.ts',
      'lib/moog-vco-dsp.ts',
      'lib/wavetable-osc.ts',
    );
    await pinAll('moog921-vco', srcSha, await renderProfile());
  });
});
