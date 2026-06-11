// packages/dsp/src/lib/ringback-core.test.ts
//
// Unit tests for the RINGBACK crush core — the exact mechanism extracted from
// the TWOTRACKS record-time artifact (integer-cell write + fractional interp
// read-back at a varispeed cursor + feedback). Pure DSP, deterministic.

import { describe, it, expect } from 'vitest';
import {
  RINGBACK_MIN_SIZE,
  RINGBACK_MAX_SIZE,
  RINGBACK_MAX_FEEDBACK,
  ringRead,
  ringWriteSpan,
  clampSize,
  clampFeedback,
  clampMix,
  mixSample,
  RingChannel,
} from './ringback-core';

describe('ringRead (fractional interp read-back, wrapped)', () => {
  it('reads exact integer cells', () => {
    const b = new Float32Array([0, 10, 20, 30]);
    expect(ringRead(b, 0, 4)).toBe(0);
    expect(ringRead(b, 2, 4)).toBe(20);
  });
  it('interpolates between cells', () => {
    const b = new Float32Array([0, 10, 20, 30]);
    expect(ringRead(b, 1.5, 4)).toBeCloseTo(15);
    expect(ringRead(b, 2.25, 4)).toBeCloseTo(22.5);
  });
  it('wraps modulo size (ring) at the seam', () => {
    const b = new Float32Array([0, 10, 20, 30]);
    // pos 3.5 over size 4 interpolates cell 3 (30) → cell 0 (0)
    expect(ringRead(b, 3.5, 4)).toBeCloseTo(15);
    // pos 4 wraps to 0
    expect(ringRead(b, 4, 4)).toBe(0);
    // negative wraps too
    expect(ringRead(b, -1, 4)).toBe(30);
  });
  it('size 0 reads 0', () => {
    expect(ringRead(new Float32Array([1, 2]), 0, 0)).toBe(0);
  });
});

describe('ringWriteSpan (sample-quantized varispeed write, wrapped)', () => {
  it('rate=1 writes the single integer cell', () => {
    const b = new Float32Array(4);
    ringWriteSpan(b, 0, 1, 0.5, 4);
    expect(b[0]).toBe(0.5);
    expect(b[1]).toBe(0);
  });
  it('rate=2 smears the value across 2 cells (the stretch)', () => {
    const b = new Float32Array(4);
    ringWriteSpan(b, 0, 2, 0.7, 4);
    expect(b[0]).toBeCloseTo(0.7, 6); // float32-stored
    expect(b[1]).toBeCloseTo(0.7, 6);
    expect(b[2]).toBe(0);
  });
  it('sub-1 rate still writes the starting cell (rate≈0 safe)', () => {
    const b = new Float32Array(4);
    ringWriteSpan(b, 1, 1.4, 0.9, 4);
    expect(b[1]).toBeCloseTo(0.9, 6);
  });
  it('wraps writes across the ring seam', () => {
    const b = new Float32Array(4);
    ringWriteSpan(b, 3, 5, 0.3, 4); // cells 3, 4%4=0
    expect(b[3]).toBeCloseTo(0.3, 6);
    expect(b[0]).toBeCloseTo(0.3, 6);
  });
  it('size 0 is a no-op (no crash)', () => {
    const b = new Float32Array(4);
    expect(() => ringWriteSpan(b, 0, 1, 1, 0)).not.toThrow();
  });
});

describe('clamps + mix law', () => {
  it('clampSize rounds + bounds to [MIN, MAX]', () => {
    expect(clampSize(0)).toBe(RINGBACK_MIN_SIZE);
    expect(clampSize(1e9)).toBe(RINGBACK_MAX_SIZE);
    expect(clampSize(127.6)).toBe(128);
  });
  it('clampFeedback bounds to [0, MAX_FEEDBACK] (no runaway)', () => {
    expect(clampFeedback(-1)).toBe(0);
    expect(clampFeedback(5)).toBe(RINGBACK_MAX_FEEDBACK);
    expect(clampFeedback(0.5)).toBe(0.5);
  });
  it('clampMix bounds to [0,1]', () => {
    expect(clampMix(-0.2)).toBe(0);
    expect(clampMix(2)).toBe(1);
    expect(clampMix(0.3)).toBe(0.3);
  });
  it('mixSample blends dry/wet', () => {
    expect(mixSample(1, 0, 0)).toBe(1);   // fully dry
    expect(mixSample(1, 0, 1)).toBe(0);   // fully wet
    expect(mixSample(1, 0.5, 0.5)).toBeCloseTo(0.75);
  });
});

const SR = 48000;
function sine(freq: number, n: number, amp = 0.7): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}
function rms(xs: ArrayLike<number>): number {
  let e = 0;
  for (let i = 0; i < xs.length; i++) { const v = xs[i] ?? 0; e += v * v; }
  return Math.sqrt(e / Math.max(1, xs.length));
}
/** Crude HF-content proxy: RMS of the first difference (more aliasing/edges =
 *  more HF energy). Distinguishes a crushed signal from its clean source. */
function hfEnergy(xs: ArrayLike<number>): number {
  let e = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = (xs[i] ?? 0) - (xs[i - 1] ?? 0);
    e += d * d;
  }
  return Math.sqrt(e / Math.max(1, xs.length - 1));
}

function runChannel(input: Float32Array, opts: { rate: number; size: number; feedback: number; mix: number }) {
  const ch = new RingChannel();
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = ch.step(input[i] ?? 0, opts.rate, opts.size, opts.feedback, opts.mix);
  }
  return out;
}

describe('RingChannel (the crush) — behavior', () => {
  it('mix=0 (fully dry) passes the input through unchanged', () => {
    const input = sine(220, 2048);
    const out = runChannel(input, { rate: 1, size: 64, feedback: 0, mix: 0 });
    let maxErr = 0;
    for (let i = 0; i < input.length; i++) maxErr = Math.max(maxErr, Math.abs((out[i] ?? 0) - (input[i] ?? 0)));
    expect(maxErr).toBeLessThan(1e-9);
  });

  it('mix=1 + a varispeed rate measurably CRUSHES (adds HF aliasing vs the clean input)', () => {
    const input = sine(220, 4096);
    // rate=0.5 over a small ring = hard stair-step read-back → the crush.
    const out = runChannel(input, { rate: 0.5, size: 64, feedback: 0, mix: 1 });
    // The crushed output has clearly MORE HF (first-difference) energy than the
    // smooth source sine — this is the audible "bitcrush" character.
    expect(hfEnergy(out)).toBeGreaterThan(hfEnergy(input) * 1.5);
    // …and it is NOT just the input (it differs substantially).
    let diff = 0;
    for (let i = 0; i < input.length; i++) diff += Math.abs((out[i] ?? 0) - (input[i] ?? 0));
    expect(diff / input.length).toBeGreaterThan(0.02);
  });

  it('feedback sustains the ring TAIL after the input stops (the regen tail)', () => {
    // 256-sample burst then silence: with no feedback the ring decays away once
    // the input stops; with feedback the read-back is re-injected so the wet
    // tail rings on. Measure the post-burst tail energy, not whole-signal RMS
    // (which can phase-cancel either way).
    const N = 4096, burst = 256;
    const input = new Float32Array(N);
    for (let i = 0; i < burst; i++) input[i] = 0.8 * Math.sin((2 * Math.PI * 330 * i) / SR);
    const noFb = runChannel(input, { rate: 1, size: 64, feedback: 0, mix: 1 });
    const fb = runChannel(input, { rate: 1, size: 64, feedback: 0.9, mix: 1 });
    const tail = (xs: Float32Array) => rms(xs.subarray(burst + 256)); // well after the burst
    expect(tail(fb)).toBeGreaterThan(tail(noFb) + 1e-4);
  });

  it('feedback is bounded — even max feedback stays finite (no NaN/Inf blow-up)', () => {
    const input = sine(440, 8192, 1.0);
    const out = runChannel(input, { rate: 1, size: 16, feedback: RINGBACK_MAX_FEEDBACK, mix: 1 });
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i] ?? 0)).toBe(true);
    }
    // bounded magnitude (not exploding)
    let mx = 0;
    for (let i = 0; i < out.length; i++) mx = Math.max(mx, Math.abs(out[i] ?? 0));
    expect(mx).toBeLessThan(100);
  });

  it('is DETERMINISTIC — same input + params → byte-identical output (VRT/ART safe)', () => {
    const input = sine(220, 2048);
    const a = runChannel(input, { rate: 0.5, size: 48, feedback: 0.4, mix: 0.8 });
    const b = runChannel(input, { rate: 0.5, size: 48, feedback: 0.4, mix: 0.8 });
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('produces audible OUTPUT for a nonzero input (RMS > 0 at the out)', () => {
    const input = sine(220, 4096);
    const out = runChannel(input, { rate: 0.5, size: 64, feedback: 0.3, mix: 1 });
    expect(rms(out)).toBeGreaterThan(0.05);
  });

  it('size clamps keep the ring within [MIN, MAX] (no OOB)', () => {
    const input = sine(220, 1024);
    expect(() => runChannel(input, { rate: 1, size: 1, feedback: 0, mix: 1 })).not.toThrow();
    expect(() => runChannel(input, { rate: 1, size: 1e9, feedback: 0, mix: 1 })).not.toThrow();
  });
});
