// art/scenarios/twotracks/twotracks-lofi-error.test.ts
//
// ART scenario: TWOTRACKS Lofi mode ERROR (lofi=3).
//
// Drives the pure-math lofi chain with lofi=3 and lofiSeed=42 (fixed for
// determinism) and asserts:
//   - Output is NOT fully silence (signal gets through between dropouts)
//   - Output has SOME zero samples (dropouts exist — granular chew active)
//   - Not all samples are zero (the module is still producing audio)
//   - Not all samples are nonzero (the chew dropout actually mutes some sections)

import { describe, it, expect } from 'vitest';

const SR = 48000;

function lcgNext(state: number): number {
  return ((state * 1664525 + 1013904223) >>> 0);
}

function renderLofiError(
  freqHz: number,
  durationS: number,
  lofiSeed: number = 42,
): Float32Array {
  const totalSamples = Math.round(SR * durationS);
  const buf = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    buf[i] = Math.sin((2 * Math.PI * freqHz * i) / SR) * 0.7;
  }
  const out = new Float32Array(totalSamples);

  // lofi=3 constants (mirror of worklet)
  const drive    = 2.0;
  const offset   = 0.03;
  const outGain  = 1 / Math.tanh(2.0);
  const hfA      = 1 - Math.exp(-2 * Math.PI * 4000 / SR);
  const hissAmp  = 0.010;
  const wowDepth     = 0.002;
  const flutterDepth = 0.001;
  const wowInc     = 2 * Math.PI * 0.7 / SR;
  const flutterInc = 2 * Math.PI * 7.0 / SR;
  const CHEW_PROB  = 0.00005;

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

    // Granular chew
    if (grainActive) {
      grainRemaining--;
      if (grainRemaining <= 0) grainActive = false;
    }
    if (!grainActive) {
      rngState = lcgNext(rngState);
      if (rngState / 4294967296 < CHEW_PROB) {
        rngState = lcgNext(rngState);
        const grainLenMs = 20 + (rngState / 4294967296) * 60;
        grainRemaining = Math.round(grainLenMs * SR / 1000);
        rngState = lcgNext(rngState);
        grainType = (rngState >>> 31);
        grainActive = true;
        if (grainType === 0) stutterSample = s;
      }
    }
    if (grainActive) {
      s = grainType === 1 ? 0 : stutterSample;
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

describe('ART twotracks / lofi=ERROR', () => {
  it('output is not fully silent — signal gets through between dropouts', () => {
    const out = renderLofiError(220, 5, 42);
    const r = rms(out);
    expect(r, `lofi=error overall RMS ${r} must be > 0`).toBeGreaterThan(0);
  });

  it('some samples are zero (silence dropout grains exist)', () => {
    // At CHEW_PROB=0.00005, expect ~2.4 grains/sec → in 5s there should be
    // ~12 grains. Each silence grain is 20-80ms. Probability that NONE of them
    // are silence-type is 0.5^12 ≈ 0.02%. This test should be extremely stable.
    const out = renderLofiError(220, 5, 42);
    let zeroCount = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === 0) zeroCount++;
    }
    expect(zeroCount, `silence grains produced ${zeroCount} zero samples`).toBeGreaterThan(0);
  });

  it('NOT all samples are zero — signal survives between dropout grains', () => {
    const out = renderLofiError(220, 5, 42);
    let nonZeroCount = 0;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i]!) > 1e-6) nonZeroCount++;
    }
    expect(nonZeroCount, `nonzero samples count ${nonZeroCount}`).toBeGreaterThan(
      out.length * 0.5, // at least half the output should be non-silent
    );
  });

  it('deterministic: same seed produces identical output', () => {
    const a = renderLofiError(220, 1, 42);
    const b = renderLofiError(220, 1, 42);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    expect(maxDiff, 'same seed must produce identical output').toBe(0);
  });

  it('different seeds produce different outputs', () => {
    const a = renderLofiError(220, 1, 42);
    const b = renderLofiError(220, 1, 99999);
    let anyDiff = false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-9) { anyDiff = true; break; }
    }
    expect(anyDiff, 'different seeds must produce different noise/chew patterns').toBe(true);
  });
});
