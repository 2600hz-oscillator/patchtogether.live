// packages/dsp/src/lib/rbj-biquad.test.ts
//
// Own-code RBJ biquads: measured frequency response at the design points via
// steady-state sine probes (bin-aligned Goertzel — exact, no FFT dep).

import { describe, it, expect } from 'vitest';
import {
  makeBiquad,
  biquadStep,
  resetBiquad,
  updatePeaking,
  updateLowShelf,
  updateHighShelf,
  updateHighpass,
  updateLowpass,
  type Biquad,
} from './rbj-biquad';

const SR = 48000;
const N = 8192;

function goertzelMag(buf: Float32Array, bin: number): number {
  const w = (2 * Math.PI * bin) / N;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < N; i++) {
    const s0 = buf[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
}

/** Gain (dB) of the configured biquad at bin-aligned frequency `bin`. */
function gainDbAt(bq: Biquad, bin: number): number {
  resetBiquad(bq);
  const inBuf = new Float32Array(N);
  const outBuf = new Float32Array(N);
  // Warmup + capture (filter transient is a handful of samples; one extra
  // window of warmup is overkill-safe).
  for (let t = 0; t < 2 * N; t++) {
    const x = Math.sin((2 * Math.PI * bin * t) / N);
    const y = biquadStep(bq, x);
    if (t >= N) {
      inBuf[t - N] = x;
      outBuf[t - N] = y;
    }
  }
  return 20 * Math.log10(goertzelMag(outBuf, bin) / goertzelMag(inBuf, bin));
}

// Handy bins: bin b ↔ b·(48000/8192) Hz ≈ b·5.86 Hz.
const BIN_50HZ = 9; // ≈52.7 Hz
const BIN_150HZ = 26; // ≈152 Hz
const BIN_2K8 = 478; // ≈2801 Hz
const BIN_10K = 1706; // ≈9996 Hz

describe('rbj-biquad: response at the design points', () => {
  it('peaking: +6 dB at fc, ~0 dB two octaves away', () => {
    const bq = makeBiquad();
    updatePeaking(bq, 150, 6, 1.0, SR);
    expect(gainDbAt(bq, BIN_150HZ)).toBeGreaterThan(5.4);
    expect(gainDbAt(bq, BIN_150HZ)).toBeLessThan(6.6);
    expect(Math.abs(gainDbAt(bq, BIN_2K8))).toBeLessThan(0.8);
  });

  it('peaking: cut mirrors boost (−6 dB)', () => {
    const bq = makeBiquad();
    updatePeaking(bq, 2800, -6, 0.8, SR);
    expect(gainDbAt(bq, BIN_2K8)).toBeGreaterThan(-6.6);
    expect(gainDbAt(bq, BIN_2K8)).toBeLessThan(-5.4);
  });

  it('low shelf: full gain well below fc, ~0 well above', () => {
    const bq = makeBiquad();
    updateLowShelf(bq, 120, 8, SR);
    expect(gainDbAt(bq, BIN_50HZ)).toBeGreaterThan(6.5);
    expect(Math.abs(gainDbAt(bq, BIN_10K))).toBeLessThan(0.5);
  });

  it('high shelf: full gain well above fc, ~0 well below', () => {
    const bq = makeBiquad();
    updateHighShelf(bq, 2500, -8, SR);
    expect(gainDbAt(bq, BIN_10K)).toBeLessThan(-6.5);
    expect(Math.abs(gainDbAt(bq, BIN_50HZ))).toBeLessThan(0.5);
  });

  it('highpass 22 Hz: kills sub-sonic rumble, unity in the audio band', () => {
    const bq = makeBiquad();
    updateHighpass(bq, 22, SR);
    expect(gainDbAt(bq, 1)).toBeLessThan(-20); // ≈5.9 Hz
    expect(Math.abs(gainDbAt(bq, BIN_150HZ))).toBeLessThan(0.3);
  });

  it('lowpass 300 Hz: unity below, strong attenuation at 10 kHz', () => {
    const bq = makeBiquad();
    updateLowpass(bq, 300, SR);
    expect(Math.abs(gainDbAt(bq, BIN_50HZ))).toBeLessThan(0.6);
    expect(gainDbAt(bq, BIN_10K)).toBeLessThan(-40);
  });

  it('coefficient cache: same params do not recompute (identity preserved)', () => {
    const bq = makeBiquad();
    updatePeaking(bq, 150, 6, 1.0, SR);
    const b0 = bq.b0;
    bq.b0 = 123; // sentinel — an unwanted recompute would overwrite it
    updatePeaking(bq, 150, 6, 1.0, SR);
    expect(bq.b0).toBe(123);
    updatePeaking(bq, 151, 6, 1.0, SR); // param change → recompute
    expect(bq.b0).not.toBe(123);
    expect(Math.abs(bq.b0 - b0)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// The cache key must contain EVERY parameter the math reads.
//
// `updatePeaking` guarded on (fc, dbGain) only, so a Q-ONLY change early-
// returned the previous filter verbatim — measured bit-identical b0..a2 and a
// 1.85 dB response error one octave above fc. The three legs below are a set:
// leg 1 is the regression, legs 2 and 3 are its negative controls, and leg 1
// goes vacuous the moment either control stops holding.
// ---------------------------------------------------------------------------
describe('rbj-biquad: Q is part of the peaking cache key', () => {
  const COEFFS = ['b0', 'b1', 'b2', 'a1', 'a2'] as const;
  const coeffs = (bq: Biquad) => COEFFS.map((k) => bq[k]);
  const FC = 150;
  const DB = 6;
  const Q_WIDE = 1.0;
  const Q_NARROW = 8.0;
  const BIN_OCT_UP = 51; // ≈299 Hz — one octave above fc, where Q shows

  // Leg 1 — THE REGRESSION. Red against `k1 === fc && k2 === dbGain`.
  it('a Q-ONLY change recomputes the coefficients', () => {
    const live = makeBiquad();
    updatePeaking(live, FC, DB, Q_WIDE, SR);
    const wide = coeffs(live);
    updatePeaking(live, FC, DB, Q_NARROW, SR); // fc and dbGain unchanged
    const narrow = coeffs(live);

    expect(narrow).not.toEqual(wide);

    // …and it lands on the RIGHT coefficients, not merely different ones: a
    // biquad that never saw Q_WIDE must agree bit-for-bit.
    const reference = makeBiquad();
    updatePeaking(reference, FC, DB, Q_NARROW, SR);
    expect(narrow).toEqual(coeffs(reference));

    // The audible consequence, in dB (units stated so a red run is readable):
    // the stale wide bell boosts ≈1.90 dB an octave up; the narrow one ≈0.05.
    const liveDb = gainDbAt(live, BIN_OCT_UP);
    const wantDb = gainDbAt(reference, BIN_OCT_UP);
    expect(Math.abs(liveDb - wantDb)).toBeLessThan(0.01); // dB @≈299 Hz
  });

  // Leg 2 — NEGATIVE CONTROL on the FIX: "recompute unconditionally" would
  // satisfy leg 1 while throwing the cache away. The sentinel proves an
  // all-params-equal call still early-returns.
  it('negative control: an all-params-equal call still hits the cache', () => {
    const bq = makeBiquad();
    updatePeaking(bq, FC, DB, Q_NARROW, SR);
    bq.b0 = 123; // sentinel — any recompute overwrites it
    updatePeaking(bq, FC, DB, Q_NARROW, SR);
    expect(bq.b0).toBe(123);
    updatePeaking(bq, FC, DB, Q_WIDE, SR); // Q differs → must recompute
    expect(bq.b0).not.toBe(123);
  });

  // Leg 3 — NEGATIVE CONTROL on the INSTRUMENT: leg 1 asserts two coefficient
  // sets differ, which proves nothing if Q were a no-op in the math. On FRESH
  // biquads the cache cannot hit at all, so this measures the math alone — and
  // it is what makes the chosen Q pair a real perturbation rather than a
  // decorative one.
  it('negative control: Q genuinely changes the math (fresh biquads, no cache)', () => {
    const wide = makeBiquad();
    updatePeaking(wide, FC, DB, Q_WIDE, SR);
    const narrow = makeBiquad();
    updatePeaking(narrow, FC, DB, Q_NARROW, SR);
    expect(coeffs(narrow)).not.toEqual(coeffs(wide));

    // Both hit their design gain AT fc — Q moves the skirt, not the peak, so
    // an fc-only probe would have been blind to this whole defect.
    expect(gainDbAt(wide, BIN_150HZ)).toBeGreaterThan(5.4);
    expect(gainDbAt(narrow, BIN_150HZ)).toBeGreaterThan(5.4);
    // One octave up the two are far apart (measured 1.900 vs 0.045 dB).
    expect(gainDbAt(wide, BIN_OCT_UP)).toBeGreaterThan(1.5); // dB
    expect(gainDbAt(narrow, BIN_OCT_UP)).toBeLessThan(0.3); // dB
  });
});
