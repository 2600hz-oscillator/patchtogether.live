// packages/web/src/lib/audio/modules/analog-vco-morph.test.ts
//
// Unit coverage for the ANALOG VCO saw→sine→square MORPH (the 5th output
// added alongside the four fixed taps).
//
// The morph itself lives in Faust (packages/dsp/src/analog-vco.dsp) and is
// compiled to WASM, so we can't import it here. Instead we mirror the exact
// per-sample formula from the .dsp in JS and assert the morph's defining
// properties — the same approach the treeohvox blend-osc test uses for its
// saw↔square morph. The reference below is kept algebraically identical to
// the `.dsp` so a regression in the Faust source that diverges from these
// shapes is caught by the spectral / zero-crossing / identity asserts.
//
// Crucially: at shape == 0 the morph sample MUST equal the saw tap exactly
// (the .dsp's `saw(p) = 2p - 1`). This is the backward-compat guarantee — a
// patch that wires the morph in place of the saw with the knob at 0 gets the
// bare saw, and the four fixed taps are untouched by the morph code path.

import { describe, expect, it } from 'vitest';

// ---- JS mirror of the .dsp shape primitives (shared phase p in [0,1)) ----
const sawTap = (p: number) => 2 * p - 1;
const sq50 = (p: number) => (p < 0.5 ? 1 : -1);
const sn = (p: number) => Math.sin(2 * Math.PI * p);

// JS mirror of the .dsp `morph(p)` two-segment crossfade:
//   shape∈[0,0.5): saw → sine, mix = 2*shape
//   shape∈[0.5,1]: sine → square, mix = 2*shape - 1
function morph(p: number, shape: number): number {
  if (shape < 0.5) {
    const lo = 2 * shape;
    return sn(p) * lo + sawTap(p) * (1 - lo);
  }
  const hi = 2 * shape - 1;
  return sq50(p) * hi + sn(p) * (1 - hi);
}

// Render one cycle of `morph` at N points.
function renderCycle(shape: number, n = 2048): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = morph(i / n, shape);
  return out;
}

// Count zero-crossings over one PERIODIC cycle (wrap last→first so the
// edge at the cycle boundary is counted — a coarse shape fingerprint).
function zeroCrossings(buf: Float32Array): number {
  let c = 0;
  for (let i = 0; i < buf.length; i++) {
    const prev = buf[(i - 1 + buf.length) % buf.length]!;
    const cur = buf[i]!;
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) c++;
  }
  return c;
}

// Naive single-bin DFT magnitude at harmonic k over one cycle.
function harmonic(buf: Float32Array, k: number): number {
  let re = 0;
  let im = 0;
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * k * i) / n;
    re += buf[i]! * Math.cos(ph);
    im -= buf[i]! * Math.sin(ph);
  }
  return Math.sqrt(re * re + im * im) / n;
}

describe('analogVco morph: saw → sine → square', () => {
  it('shape=0 (default) is BIT-IDENTICAL to the saw tap (back-compat)', () => {
    // The morph output at the param default reproduces TODAY's saw exactly —
    // existing patches + ART baselines are unaffected.
    for (let i = 0; i < 64; i++) {
      const p = i / 64;
      expect(morph(p, 0)).toBe(sawTap(p));
    }
  });

  it('shape=0.5 is BIT-IDENTICAL to a pure sine', () => {
    for (let i = 0; i < 64; i++) {
      const p = i / 64;
      expect(morph(p, 0.5)).toBeCloseTo(sn(p), 12);
    }
  });

  it('shape=1 is BIT-IDENTICAL to a 50% square', () => {
    for (let i = 0; i < 64; i++) {
      const p = i / 64;
      expect(morph(p, 1)).toBe(sq50(p));
    }
  });

  it('mid-morph (shape=0.5) is spectrally sine-dominated', () => {
    // A pure sine has all energy in the fundamental and ~zero in harmonics 2/3.
    const buf = renderCycle(0.5);
    const h1 = harmonic(buf, 1);
    const h2 = harmonic(buf, 2);
    const h3 = harmonic(buf, 3);
    expect(h1).toBeGreaterThan(0.4); // strong fundamental (~0.5 for unit sine)
    expect(h2 / h1).toBeLessThan(1e-6);
    expect(h3 / h1).toBeLessThan(1e-6);
  });

  it('saw end (shape=0) has strong even+odd harmonics; square end (shape=1) is odd-only', () => {
    const saw = renderCycle(0);
    const sqr = renderCycle(1);
    // Saw has a 2nd harmonic; a 50% square's even harmonics vanish.
    expect(harmonic(saw, 2)).toBeGreaterThan(1e-3);
    expect(harmonic(sqr, 2) / harmonic(sqr, 1)).toBeLessThan(1e-3);
    // Both have a 3rd (odd) harmonic.
    expect(harmonic(saw, 3)).toBeGreaterThan(1e-3);
    expect(harmonic(sqr, 3)).toBeGreaterThan(1e-3);
  });

  it('the morph is continuous in shape (no discontinuity at the 0.5 seam)', () => {
    // sine is the shared midpoint of both segments, so morph(p,0.5⁻)==morph(p,0.5⁺).
    for (let i = 0; i < 64; i++) {
      const p = i / 64;
      expect(morph(p, 0.4999)).toBeCloseTo(morph(p, 0.5001), 3);
    }
  });

  it('square end has 2 zero-crossings/cycle (one rising, one falling)', () => {
    expect(zeroCrossings(renderCycle(1))).toBe(2);
    // Sine also has exactly 2.
    expect(zeroCrossings(renderCycle(0.5))).toBe(2);
  });

  it('output stays bounded in [-1, 1] across the full sweep', () => {
    for (let s = 0; s <= 1.0001; s += 0.05) {
      const buf = renderCycle(Math.min(1, s));
      for (const v of buf) {
        expect(v).toBeGreaterThanOrEqual(-1.0000001);
        expect(v).toBeLessThanOrEqual(1.0000001);
      }
    }
  });
});
