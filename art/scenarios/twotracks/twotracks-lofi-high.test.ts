// art/scenarios/twotracks/twotracks-lofi-high.test.ts
//
// ART scenario: TWOTRACKS Lofi mode HIGH (lofi=2).
//
// Drives the pure-math lofi chain with lofi=2 and asserts:
//   - Output RMS > 0.005 (not silence)
//   - Output differs from raw input (processing is active)
//   - More HF attenuation than lofi=1 (cutoff 4 kHz vs 8 kHz)

import { describe, it, expect } from 'vitest';

const SR = 48000;

function lcgNext(state: number): number {
  return ((state * 1664525 + 1013904223) >>> 0);
}

function renderLofi(
  freqHz: number,
  durationS: number,
  lofiMode: 1 | 2,
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
  const hissAmp  = lofiMode === 1 ? 0.002 : 0.006;
  const wowDepth     = lofiMode === 1 ? 0.0005 : 0.002;
  const flutterDepth = lofiMode === 1 ? 0.0003 : 0.001;
  const wowInc     = 2 * Math.PI * 0.7 / SR;
  const flutterInc = 2 * Math.PI * 7.0 / SR;

  let hfLoss = 0;
  let wowPhase = 0;
  let flutterPhase = 0;
  let rngState = lofiSeed >>> 0;

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
    out[i] = s;
  }
  return out;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / buf.length);
}

describe('ART twotracks / lofi=HIGH', () => {
  it('220 Hz sine processed at lofi=2 has RMS > 0.005 (not silence)', () => {
    const out = renderLofi(220, 1, 2);
    const r = rms(out);
    expect(r, `lofi=high RMS ${r}`).toBeGreaterThan(0.005);
  });

  it('lofi=2 output differs from raw input (processing active)', () => {
    const n = Math.round(SR * 0.1);
    const ref = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ref[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.7;
    }
    const out = renderLofi(220, 0.1, 2);
    const midStart = Math.round(SR * 0.01);
    let anyDiff = false;
    for (let i = midStart; i < n; i++) {
      if (Math.abs((out[i] ?? 0) - (ref[i] ?? 0)) > 1e-6) { anyDiff = true; break; }
    }
    expect(anyDiff, 'lofi=2 must differ from bypass').toBe(true);
  });

  it('lofi=2 attenuates a 5kHz tone more than lofi=1 (lower HF cutoff)', () => {
    // 5kHz is above the lofi=2 cutoff (4kHz) but below lofi=1 cutoff (8kHz).
    // So lofi=2 should have lower RMS at 5kHz than lofi=1.
    const outHigh = renderLofi(5000, 0.5, 2);
    const outLow  = renderLofi(5000, 0.5, 1);
    const rHigh = rms(outHigh);
    const rLow  = rms(outLow);
    expect(rHigh, `lofi=2 5kHz RMS ${rHigh} < lofi=1 5kHz RMS ${rLow}`).toBeLessThan(rLow);
  });
});
