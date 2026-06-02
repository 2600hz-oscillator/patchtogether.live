// packages/dsp/src/lib/wavesculpt-luma-bandpass.test.ts
//
// Pure-DSP unit tests for the WAVESCULPT luminosity → morphable band-pass
// mapping. Pins the owner spec quantitatively so a refactor surfaces as a
// specific regression:
//   * lumaToEdgeHz — monotonic, FMIN at black, FMAX at white, NaN/Inf-safe.
//   * lumaBandpassParams — white = WIDE OPEN (high centre, low resonance),
//     black = NARROW but NONZERO (low-ish centre, high resonance), monotonic
//     centre in luminosity, depth=0 bypasses toward wide-open, all bounded.
//   * renderLumaBandpass — it is genuinely a BAND-PASS: rejects DC + Nyquist,
//     passes a mid-band tone; never NaN/Inf; never fully silent on a black
//     wall (a dark line is filtered, not muted).

import { describe, it, expect } from 'vitest';
import {
  LUMA_BP_FMIN,
  LUMA_BP_FMAX,
  lumaToEdgeHz,
  lumaBandpassParams,
  renderLumaBandpass,
} from './wavesculpt-luma-bandpass';

const SR = 48000;

function rms(x: Float32Array, skip = 0): number {
  let s = 0, n = 0;
  for (let i = skip; i < x.length; i++) { s += x[i]! * x[i]!; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

function sine(freqHz: number, n: number, sr = SR): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freqHz * i) / sr);
  return out;
}

describe('lumaToEdgeHz', () => {
  it('maps black→FMIN and white→FMAX', () => {
    expect(lumaToEdgeHz(0)).toBeCloseTo(LUMA_BP_FMIN, 5);
    expect(lumaToEdgeHz(1)).toBeCloseTo(LUMA_BP_FMAX, 5);
  });

  it('is monotonic increasing in luminosity', () => {
    let prev = -Infinity;
    for (let l = 0; l <= 1.0001; l += 0.05) {
      const f = lumaToEdgeHz(l);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it('is NaN/Inf-safe (non-finite → safe FMIN) and clamps finite out-of-range', () => {
    // Non-finite inputs are treated as 0 (→ FMIN), the safe/quiet default.
    expect(lumaToEdgeHz(NaN)).toBeCloseTo(LUMA_BP_FMIN, 5);
    expect(lumaToEdgeHz(Infinity)).toBeCloseTo(LUMA_BP_FMIN, 5);
    // FINITE out-of-range is clamped to [0,1] → [FMIN, FMAX].
    expect(lumaToEdgeHz(-5)).toBeCloseTo(LUMA_BP_FMIN, 5);
    expect(lumaToEdgeHz(5)).toBeCloseTo(LUMA_BP_FMAX, 5);
  });
});

describe('lumaBandpassParams', () => {
  it('white walls → WIDE OPEN: high centre + low resonance', () => {
    const black = lumaBandpassParams(0, 0, 1);
    const white = lumaBandpassParams(1, 1, 1);
    // Bright = higher centre frequency than dark.
    expect(white.centerHz).toBeGreaterThan(black.centerHz);
    // Bright = broader band = lower resonance than dark.
    expect(white.res).toBeLessThan(black.res);
  });

  it('black walls → NARROW but the centre is NONZERO (never silent)', () => {
    const black = lumaBandpassParams(0, 0, 1);
    expect(black.centerHz).toBeGreaterThan(0);
    expect(black.centerHz).toBeGreaterThanOrEqual(LUMA_BP_FMIN * 0.9);
    // Resonance bounded below 1 (no self-oscillation) and above 0.
    expect(black.res).toBeGreaterThan(0);
    expect(black.res).toBeLessThan(1);
  });

  it('centre frequency is monotonic non-decreasing as both walls brighten', () => {
    let prev = -Infinity;
    for (let l = 0; l <= 1.0001; l += 0.1) {
      const p = lumaBandpassParams(l, l, 1);
      expect(p.centerHz).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = p.centerHz;
    }
  });

  it('depth=0 collapses toward wide-open (bypass): centre high, res low', () => {
    const off = lumaBandpassParams(0, 0, 0);     // even with black walls
    const full = lumaBandpassParams(0, 0, 1);
    expect(off.centerHz).toBeGreaterThan(full.centerHz); // off is wide-open
    expect(off.res).toBeLessThanOrEqual(full.res);
  });

  it('all outputs finite + bounded across the luminosity/depth grid', () => {
    for (let a = 0; a <= 1.0001; a += 0.25) {
      for (let b = 0; b <= 1.0001; b += 0.25) {
        for (let d = 0; d <= 1.0001; d += 0.5) {
          const p = lumaBandpassParams(a, b, d);
          expect(Number.isFinite(p.centerHz)).toBe(true);
          expect(Number.isFinite(p.res)).toBe(true);
          expect(p.centerHz).toBeGreaterThan(0);
          expect(p.centerHz).toBeLessThan(SR / 2);
          expect(p.res).toBeGreaterThanOrEqual(0);
          expect(p.res).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('handles NaN/Inf luminosity without producing NaN/Inf', () => {
    const p = lumaBandpassParams(NaN, Infinity, NaN);
    expect(Number.isFinite(p.centerHz)).toBe(true);
    expect(Number.isFinite(p.res)).toBe(true);
  });
});

describe('renderLumaBandpass (it is a BAND-PASS)', () => {
  const N = 8192;
  const SKIP = 2048; // let the SVF + smoother settle before measuring

  it('passes a mid-band tone louder than DC or a near-Nyquist tone', () => {
    // Dark-ish walls → narrow band centred ~LUMA_BP_FMIN..mid. Use a moderate
    // luminosity so the band sits in the low-mids, then probe DC / mid / high.
    const lum = 0.35;
    const center = Math.sqrt(lumaToEdgeHz(lum) * lumaToEdgeHz(lum)); // both edges equal
    const dc = new Float32Array(N).fill(1); // DC
    const mid = sine(center, N);
    const high = sine(SR * 0.45, N); // near Nyquist

    const dcOut = renderLumaBandpass(dc, { lumA: lum, lumB: lum, depth: 1, sr: SR });
    const midOut = renderLumaBandpass(mid, { lumA: lum, lumB: lum, depth: 1, sr: SR });
    const highOut = renderLumaBandpass(high, { lumA: lum, lumB: lum, depth: 1, sr: SR });

    const dcR = rms(dcOut, SKIP);
    const midR = rms(midOut, SKIP);
    const highR = rms(highOut, SKIP);

    // Band-pass: mid passes, DC + Nyquist are rejected.
    expect(midR).toBeGreaterThan(dcR * 3);
    expect(midR).toBeGreaterThan(highR * 3);
  });

  it('white walls pass a high-mid tone clearly (wide-open band)', () => {
    const probe = sine(4000, N);
    const out = renderLumaBandpass(probe, { lumA: 1, lumB: 1, depth: 1, sr: SR });
    expect(rms(out, SKIP)).toBeGreaterThan(0.1);
  });

  it('black walls still let SOME signal through (never fully silent)', () => {
    // A tone near the dark band centre must survive — a dark line is filtered,
    // not muted.
    const probe = sine(LUMA_BP_FMIN, N);
    const out = renderLumaBandpass(probe, { lumA: 0, lumB: 0, depth: 1, sr: SR });
    expect(rms(out, SKIP)).toBeGreaterThan(0.01);
  });

  it('produces no NaN/Inf for any luminosity pair', () => {
    const probe = sine(1000, 2048);
    for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1], [0.5, 0.5]] as const) {
      const out = renderLumaBandpass(probe, { lumA: a, lumB: b, depth: 1, sr: SR });
      for (let i = 0; i < out.length; i++) {
        expect(Number.isFinite(out[i]!)).toBe(true);
      }
    }
  });
});
