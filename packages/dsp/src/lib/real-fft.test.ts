// Pins the real FFT that SAMSLOOP's denoise core is built on:
//   1. forward == a naive O(n²) DFT (the oracle) on seeded noise, n = 16 /
//      1024 / 2048 — the two STFT sizes the core derives plus a tiny one whose
//      bit-reversal table is easy to get wrong.
//   2. inverse(forward(x)) == x to float32 precision at both STFT sizes.
//   3. The WOLA constant: Σ w² over four hop-n/4 shifts of the periodic Hann
//      is exactly 1.5 at every sample — the identity the synthesis stage
//      divides by; a symmetric (n−1) Hann is the NEGATIVE CONTROL and does not
//      sum flat.

import { describe, expect, it } from 'vitest';
import { HANN_HOP4_WOLA_GAIN, RealFft, hannPeriodic } from './real-fft';
import { mulberry32 } from './noise-dsp';

function noise(n: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rnd() * 2 - 1;
  return out;
}

function naiveDft(x: Float32Array): { re: Float64Array; im: Float64Array } {
  const n = x.length;
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let sr = 0;
    let si = 0;
    for (let j = 0; j < n; j++) {
      const th = (-2 * Math.PI * j * k) / n;
      sr += x[j]! * Math.cos(th);
      si += x[j]! * Math.sin(th);
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}

describe('RealFft', () => {
  it.each([16, 1024, 2048])('forward matches a naive DFT oracle at n = %i', (n) => {
    const x = noise(n, 0xc0ffee + n);
    const fft = new RealFft(n);
    const re = new Float32Array(n / 2 + 1);
    const im = new Float32Array(n / 2 + 1);
    fft.forward(x, re, im);
    const oracle = naiveDft(x);
    // Bins scale with sqrt(n) for noise; compare relative to the spectrum's own peak.
    let peak = 0;
    for (let k = 0; k <= n / 2; k++) peak = Math.max(peak, Math.hypot(oracle.re[k]!, oracle.im[k]!));
    let worst = 0;
    for (let k = 0; k <= n / 2; k++) {
      worst = Math.max(worst, Math.abs(re[k]! - oracle.re[k]!), Math.abs(im[k]! - oracle.im[k]!));
    }
    expect(worst / peak).toBeLessThan(1e-5);
    // DC and Nyquist are purely real for a real input.
    expect(Math.abs(im[0]!)).toBeLessThan(1e-9 * peak);
    expect(Math.abs(im[n / 2]!)).toBeLessThan(1e-9 * peak);
  });

  it.each([1024, 2048])('inverse(forward(x)) == x at n = %i', (n) => {
    const x = noise(n, 0xbeef + n);
    const fft = new RealFft(n);
    const re = new Float32Array(n / 2 + 1);
    const im = new Float32Array(n / 2 + 1);
    const y = new Float32Array(n);
    fft.forward(x, re, im);
    fft.inverse(re, im, y);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(y[i]! - x[i]!));
    expect(worst).toBeLessThan(1e-6);
  });

  it('honours the read/write offset (frames are sliced out of a long buffer)', () => {
    const n = 64;
    const long = noise(3 * n, 7);
    const fft = new RealFft(n);
    const re = new Float32Array(n / 2 + 1);
    const im = new Float32Array(n / 2 + 1);
    fft.forward(long, re, im, n);
    const back = new Float32Array(3 * n);
    fft.inverse(re, im, back, 2 * n);
    for (let i = 0; i < n; i++) expect(back[2 * n + i]).toBeCloseTo(long[n + i]!, 6);
  });

  it('rejects non-power-of-two sizes', () => {
    expect(() => new RealFft(1000)).toThrow(/power of two/);
  });
});

describe('hannPeriodic + WOLA constant', () => {
  it('Σw² over four hop-n/4 shifts is exactly 1.5 at every sample (n = 1024, 2048)', () => {
    for (const n of [1024, 2048]) {
      const w = hannPeriodic(n);
      const hop = n / 4;
      for (let j = 0; j < hop; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += w[j + k * hop]! ** 2;
        expect(Math.abs(s - HANN_HOP4_WOLA_GAIN)).toBeLessThan(1e-6);
      }
    }
  });

  it('NEGATIVE CONTROL: the symmetric (n−1) Hann does NOT sum flat', () => {
    const n = 1024;
    const hop = n / 4;
    const w = new Float32Array(n);
    for (let j = 0; j < n; j++) w[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (n - 1));
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < hop; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += w[j + k * hop]! ** 2;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    expect(hi - lo).toBeGreaterThan(1e-4);
  });
});
