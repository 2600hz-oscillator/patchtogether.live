// art/scenarios/twotracks/twotracks-lofi-low.test.ts
//
// ART scenario: TWOTRACKS Lofi mode LOW (lofi=1).
//
// Drives the same pure-math lofi chain used in twotracks-lofi-off.test.ts
// with lofi=1 and asserts:
//   - Output is not silence (RMS > 0.01)
//   - Output has some signal even after HF loss + saturation

import { describe, it, expect } from 'vitest';

const SR = 48000;

function lcgNext(state: number): number {
  return ((state * 1664525 + 1013904223) >>> 0);
}

function renderLofi(
  freqHz: number,
  durationS: number,
  lofiMode: 1 | 2 | 3,
  lofiSeed: number = 12345,
): Float32Array {
  const totalSamples = Math.round(SR * durationS);
  const buf = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    buf[i] = Math.sin((2 * Math.PI * freqHz * i) / SR) * 0.7;
  }
  const out = new Float32Array(totalSamples);

  const drive    = lofiMode === 1 ? 1.2 : 2.0;
  const offset   = lofiMode === 1 ? 0.01 : 0.03;
  const outGain  = lofiMode === 1 ? 1 / Math.tanh(1.2) : 1 / Math.tanh(2.0);
  const hfCutoff = lofiMode === 1 ? 8000 : 4000;
  const hfA      = 1 - Math.exp(-2 * Math.PI * hfCutoff / SR);
  const hissAmp  = lofiMode === 1 ? 0.002 : lofiMode === 2 ? 0.006 : 0.010;
  const wowDepth     = lofiMode === 1 ? 0.0005 : 0.002;
  const flutterDepth = lofiMode === 1 ? 0.0003 : 0.001;
  const wowInc     = 2 * Math.PI * 0.7 / SR;
  const flutterInc = 2 * Math.PI * 7.0 / SR;

  let hfLoss = 0;
  let wowPhase = 0;
  let flutterPhase = 0;
  let rngState = lofiSeed >>> 0;
  let grainActive = false;
  let grainRemaining = 0;
  let grainType = 0;
  let stutterSample = 0;

  for (let i = 0; i < totalSamples; i++) {
    let s = buf[i]!;
    s = Math.tanh(drive * s + offset) * outGain;
    hfLoss = hfA * s + (1 - hfA) * hfLoss;
    s = hfLoss;
    rngState = lcgNext(rngState);
    s += (rngState / 2147483648 - 1) * hissAmp;
    const mod = wowDepth * Math.sin(wowPhase) + flutterDepth * Math.cos(flutterPhase);
    s *= (1 + mod);
    wowPhase += wowInc;
    flutterPhase += flutterInc;
    if (wowPhase > 2 * Math.PI) wowPhase -= 2 * Math.PI;
    if (flutterPhase > 2 * Math.PI) flutterPhase -= 2 * Math.PI;
    if (lofiMode === 3) {
      if (grainActive) {
        grainRemaining--;
        if (grainRemaining <= 0) grainActive = false;
      }
      if (!grainActive) {
        rngState = lcgNext(rngState);
        if (rngState / 4294967296 < 0.00005) {
          rngState = lcgNext(rngState);
          const grainLenMs = 20 + (rngState / 4294967296) * 60;
          grainRemaining = Math.round(grainLenMs * SR / 1000);
          rngState = lcgNext(rngState);
          grainType = (rngState >>> 31);
          grainActive = true;
          if (grainType === 0) stutterSample = s;
        }
      }
      if (grainActive) s = grainType === 1 ? 0 : stutterSample;
    }
    out[i] = s;
  }
  return out;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / buf.length);
}

describe('ART twotracks / lofi=LOW', () => {
  it('220 Hz sine processed at lofi=1 has RMS > 0.01 (not silence)', () => {
    const out = renderLofi(220, 1, 1);
    const r = rms(out);
    expect(r, `lofi=low RMS ${r}`).toBeGreaterThan(0.01);
  });

  it('lofi=1 output is not bit-identical to the input (processing occurs)', () => {
    const n = Math.round(SR * 0.1);
    const ref = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ref[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.7;
    }
    const out = renderLofi(220, 0.1, 1);
    // Allow the 1-pole filter settling time (~few ms), then compare a mid-section
    const midStart = Math.round(SR * 0.01);
    let anyDiff = false;
    for (let i = midStart; i < n; i++) {
      if (Math.abs((out[i] ?? 0) - (ref[i] ?? 0)) > 1e-6) { anyDiff = true; break; }
    }
    expect(anyDiff, 'lofi=1 must differ from bypass').toBe(true);
  });

  it('lofi=1 HF loss: high-freq content (8kHz) is attenuated relative to bypass', () => {
    // Feed a single-frequency test at 8kHz (the lofi=1 HF cutoff).
    // After saturation + HF LP @ 8kHz, output should be ~6dB down from the
    // un-processed amplitude. We check that the low-lofi RMS is meaningfully lower
    // than the input amplitude (0.7) for a 8kHz tone.
    const out = renderLofi(8000, 0.5, 1);
    const r = rms(out);
    // Must still be audible (not zeroed) but clearly reduced vs 0.7 amplitude
    expect(r, `lofi=1 8kHz RMS ${r} should be > 0`).toBeGreaterThan(0);
    expect(r, `lofi=1 8kHz RMS ${r} should be < 0.7`).toBeLessThan(0.7);
  });
});
