// packages/dsp/src/lib/varispeed-shifter.test.ts
//
// Unit spec for the OWN-CODE granular pitch shifter used by CHARLOTTE'S ECHOS
// to keep its ascending-shimmer PITCHUP after the migration off the GPL
// cocoadelay-core. Asserts: unity-rate is an exact bypass, rate > 1 raises the
// resampled fundamental (a real transpose, not a wobble), the rise is
// monotonic, output is finite + bounded, and the shifter is deterministic.

import { describe, it, expect } from 'vitest';
import { VarispeedShifter } from './varispeed-shifter';

const SR = 48000;

function sine(hz: number, amp: number, n: number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
  return b;
}

/** Spectral centroid (Hz) over [start,end) — a naive DFT scan. Rises iff energy
 *  moves up the spectrum (a real pitch shift). */
function centroid(buf: Float32Array, start: number, end: number): number {
  let num = 0;
  let den = 0;
  for (let f = 50; f <= 8000; f += 25) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / SR;
    for (let n = start; n < end; n++) {
      re += buf[n]! * Math.cos(w * n);
      im -= buf[n]! * Math.sin(w * n);
    }
    const p = re * re + im * im;
    num += f * p;
    den += p;
  }
  return den > 0 ? num / den : 0;
}

function run(input: Float32Array, rate: number): Float32Array {
  const sh = new VarispeedShifter(SR);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = sh.step(input[i]!, rate);
  return out;
}

describe('VarispeedShifter', () => {
  it('rate = 1 is an EXACT bypass (output === input)', () => {
    const input = sine(300, 0.5, 4096);
    const out = run(input, 1);
    for (let i = 0; i < input.length; i++) expect(out[i]).toBe(input[i]);
  });

  it('rate = 1.0 within float epsilon is still a bypass', () => {
    const input = sine(220, 0.4, 2048);
    const out = run(input, 1 + 1e-12);
    for (let i = 0; i < input.length; i++) expect(out[i]).toBe(input[i]);
  });

  it('rate > 1 raises the fundamental (a real upward transpose)', () => {
    const n = SR; // 1 s
    const input = sine(300, 0.5, n);
    const flat = run(input, 1);
    const up = run(input, 1.5);
    const s = Math.round(0.3 * SR);
    const e = n;
    const cFlat = centroid(flat, s, e);
    const cUp = centroid(up, s, e);
    // ~300 Hz in, ~450 Hz out — allow generous slack for grain artifacts.
    expect(cFlat).toBeGreaterThan(200);
    expect(cFlat).toBeLessThan(400);
    expect(cUp).toBeGreaterThan(cFlat * 1.25);
  });

  it('the pitch rise is monotonic in rate', () => {
    const n = SR;
    const input = sine(250, 0.5, n);
    const s = Math.round(0.3 * SR);
    const c1 = centroid(run(input, 1.1), s, n);
    const c2 = centroid(run(input, 1.4), s, n);
    const c3 = centroid(run(input, 1.8), s, n);
    expect(c2).toBeGreaterThan(c1);
    expect(c3).toBeGreaterThan(c2);
  });

  it('output stays finite and bounded (constant-power crossfade)', () => {
    const input = sine(200, 0.9, SR);
    const out = run(input, 1.7);
    let peak = 0;
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    // Two crossfaded taps of a ≤0.9 signal can only briefly sum above it; well
    // under 2× and never runaway.
    expect(peak).toBeLessThan(1.8);
  });

  it('is deterministic (two runs are bit-identical)', () => {
    const input = sine(330, 0.5, 4096);
    const a = run(input, 1.33);
    const b = run(input, 1.33);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('scrubs non-finite input to silence', () => {
    const sh = new VarispeedShifter(SR);
    for (let i = 0; i < 100; i++) sh.step(NaN, 1.5);
    const y = sh.step(0, 1.5);
    expect(Number.isFinite(y)).toBe(true);
  });
});
