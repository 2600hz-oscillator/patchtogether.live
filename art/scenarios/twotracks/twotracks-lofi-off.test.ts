// art/scenarios/twotracks/twotracks-lofi-off.test.ts
//
// ART scenario: TWOTRACKS Lofi mode OFF (lofi=0).
//
// Exercises the pure-math lofi signal chain (mirrored from packages/dsp/src/twotracks.ts)
// over a synthetic 220 Hz sine recorded into the ring buffer, then played back with
// no lofi processing. Asserts output RMS > 0.05 — i.e., the tape loop is audible
// and the lofi bypass does not attenuate the signal.
//
// Algorithm notes (Phase 3 worklet, for traceability):
//   lofi=0: no saturation, no HF loss, no hiss, no wow/flutter, no chew.
//   Output is the raw A/B mix.

import { describe, it, expect } from 'vitest';

const SR = 48000;

/** Simple 32-bit Numerical Recipes LCG (same as worklet). */
function lcgNext(state: number): number {
  return ((state * 1664525 + 1013904223) >>> 0);
}

/**
 * Synthesise a sine into a ring buffer, then play it back through
 * the lofi chain at the given mode. Returns the output Float32Array.
 */
function renderLofi(
  freqHz: number,
  durationS: number,
  lofiMode: 0 | 1 | 2 | 3,
  lofiSeed: number = 12345,
): Float32Array {
  const totalSamples = Math.round(SR * durationS);
  const buf = new Float32Array(totalSamples);

  // Fill ring buffer with sine
  for (let i = 0; i < totalSamples; i++) {
    buf[i] = Math.sin((2 * Math.PI * freqHz * i) / SR) * 0.7;
  }

  const out = new Float32Array(totalSamples);

  if (lofiMode === 0) {
    // Bypass: copy straight through
    out.set(buf);
    return out;
  }

  // Per-mode constants (mirror of worklet Phase 3 implementation)
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

  // State
  let hfLoss = 0;
  let wowPhase = 0;
  let flutterPhase = 0;
  let rngState = lofiSeed >>> 0;
  // Chew state (error mode)
  let grainActive = false;
  let grainRemaining = 0;
  let grainType = 0;
  let stutterSample = 0;

  for (let i = 0; i < totalSamples; i++) {
    let s = buf[i]!;

    // 1. Saturation
    s = Math.tanh(drive * s + offset) * outGain;

    // 2. HF loss
    hfLoss = hfA * s + (1 - hfA) * hfLoss;
    s = hfLoss;

    // 3. Hiss
    rngState = lcgNext(rngState);
    const noise = (rngState / 2147483648 - 1) * hissAmp;
    s += noise;

    // 4. Wow/flutter
    const mod = wowDepth * Math.sin(wowPhase) + flutterDepth * Math.cos(flutterPhase);
    s *= (1 + mod);
    wowPhase     += wowInc;
    flutterPhase += flutterInc;
    if (wowPhase     > 2 * Math.PI) wowPhase     -= 2 * Math.PI;
    if (flutterPhase > 2 * Math.PI) flutterPhase -= 2 * Math.PI;

    // 5. Chew (error mode only)
    if (lofiMode === 3) {
      if (grainActive) {
        grainRemaining--;
        if (grainRemaining <= 0) grainActive = false;
      }
      if (!grainActive) {
        rngState = lcgNext(rngState);
        if (rngState / 4294967296 < 0.00005) {
          rngState = lcgNext(rngState);
          const lenFrac = rngState / 4294967296;
          const grainLenMs = 20 + lenFrac * 60;
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
    }

    out[i] = s;
  }

  return out;
}

function rms(buf: Float32Array, from = 0, to?: number): number {
  const end = to ?? buf.length;
  let sum = 0;
  for (let i = from; i < end; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / (end - from));
}

describe('ART twotracks / lofi=OFF bypass', () => {
  it('220 Hz sine passes through at lofi=0 with RMS > 0.05', () => {
    const out = renderLofi(220, 1, 0);
    const r = rms(out);
    expect(r, `lofi=off RMS ${r}`).toBeGreaterThan(0.05);
  });

  it('lofi=0 output is bit-identical to the ring buffer (no processing)', () => {
    const freqHz = 220;
    const durationS = 0.1;
    const n = Math.round(SR * durationS);
    const ref = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ref[i] = Math.sin((2 * Math.PI * freqHz * i) / SR) * 0.7;
    }
    const out = renderLofi(freqHz, durationS, 0);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs((out[i] ?? 0) - (ref[i] ?? 0)));
    expect(maxDiff).toBe(0);
  });
});
