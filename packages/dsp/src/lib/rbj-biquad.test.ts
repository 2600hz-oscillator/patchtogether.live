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
