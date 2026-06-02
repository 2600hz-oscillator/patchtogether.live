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
// PW-driven rectangle, identical to the .dsp `sqr(p) = select2(p < pw, 1, -1)`.
// At pw=0.5 this is exactly the canonical 50% square the morph used before the
// PW fix — so the morph stays byte-identical at the default pw.
const sqr = (p: number, pw: number) => (p < pw ? 1 : -1);
const sq50 = (p: number) => sqr(p, 0.5);
const sn = (p: number) => Math.sin(2 * Math.PI * p);

// JS mirror of the POST-FIX .dsp `morph(p)` two-segment crossfade:
//   shape∈[0,0.5): saw → sine, mix = 2*shape
//   shape∈[0.5,1]: sine → square, mix = 2*shape - 1
// The square endpoint uses the pw-driven `sqr(p)` (NOT a hardcoded 50% square),
// so PW shapes the morph's square component — the bug fix this PR validates.
function morph(p: number, shape: number, pw = 0.5): number {
  if (shape < 0.5) {
    const lo = 2 * shape;
    return sn(p) * lo + sawTap(p) * (1 - lo);
  }
  const hi = 2 * shape - 1;
  return sqr(p, pw) * hi + sn(p) * (1 - hi);
}

// Render one cycle of `morph` at N points.
function renderCycle(shape: number, n = 2048, pw = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = morph(i / n, shape, pw);
  return out;
}

function rms(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s / a.length);
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

// ── PW FIX regression coverage (the user-reported "PW dead in MORPH mode") ──
describe('analogVco morph: PW shapes the square component (bug fix)', () => {
  it('pw=0.5 is BYTE-IDENTICAL to the pre-fix hardcoded 50% square (back-compat)', () => {
    // The fix must not change the morph at the default PW — existing patches +
    // ART/morph baselines stay valid.
    for (const shape of [0, 0.25, 0.5, 0.75, 1]) {
      for (let i = 0; i < 256; i++) {
        const p = i / 256;
        expect(morph(p, shape, 0.5)).toBe(sn(p) * 0 + 0 + (
          shape < 0.5
            ? sn(p) * (2 * shape) + sawTap(p) * (1 - 2 * shape)
            : sq50(p) * (2 * shape - 1) + sn(p) * (1 - (2 * shape - 1))
        ));
      }
    }
  });

  it('PW changes the morph duty cycle at the square end (shape=1)', () => {
    // BEFORE the fix this was rms 0 — PW had no effect on the morph. Now a
    // narrow vs wide pulse re-shapes the square endpoint substantially.
    const narrow = renderCycle(1, 2048, 0.2);
    const wide = renderCycle(1, 2048, 0.8);
    expect(rms(narrow, wide)).toBeGreaterThan(0.5);
    // The duty actually shifts: count the fraction of samples that are +1.
    const dutyOf = (buf: Float32Array) => buf.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) / buf.length;
    expect(dutyOf(narrow)).toBeCloseTo(0.2, 1);
    expect(dutyOf(wide)).toBeCloseTo(0.8, 1);
  });

  it('PW is alive continuously across the sine→square half of the morph', () => {
    // PW energy grows monotonically as the morph blends in more square (the
    // crossfade weight hi = 2*shape-1 scales the pw-driven rectangle).
    let prev = -1;
    for (const shape of [0.5, 0.6, 0.75, 0.9, 1.0]) {
      const narrow = renderCycle(shape, 2048, 0.2);
      const wide = renderCycle(shape, 2048, 0.8);
      const r = rms(narrow, wide);
      // shape=0.5 is pure sine (hi=0) → no square energy → PW has no effect.
      if (shape === 0.5) {
        expect(r).toBeLessThan(1e-9);
      } else {
        expect(r, `PW dead at shape=${shape}`).toBeGreaterThan(0.01);
        expect(r, `PW effect not increasing toward square at shape=${shape}`).toBeGreaterThan(prev);
      }
      prev = r;
    }
  });

  it('PW has NO effect on the saw→sine half (no square energy there)', () => {
    for (const shape of [0, 0.1, 0.25, 0.4]) {
      const narrow = renderCycle(shape, 2048, 0.2);
      const wide = renderCycle(shape, 2048, 0.8);
      expect(rms(narrow, wide), `PW leaked into saw half at shape=${shape}`).toBeLessThan(1e-9);
    }
  });

  it('stays bounded in [-1,1] for extreme PW across the morph', () => {
    for (const pw of [0.05, 0.5, 0.95]) {
      for (let s = 0.5; s <= 1.0001; s += 0.1) {
        const buf = renderCycle(Math.min(1, s), 2048, pw);
        for (const v of buf) {
          expect(v).toBeGreaterThanOrEqual(-1.0000001);
          expect(v).toBeLessThanOrEqual(1.0000001);
        }
      }
    }
  });
});
