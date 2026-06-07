// art/scenarios/wavefolder/wavefolder-spectrum.test.ts
//
// ART-tier check on the wavefolder spectrum behaviour shared by SWOLEVCO
// (and other wavefolder modules). Same shape as art/scenarios/video/phase1-defs.test.ts —
// math-only assertions that nail down the curve's mathematical
// behaviour so a regression touching the curve helper is caught here
// rather than during subjective listening.
//
// Why ART rather than unit: this asserts the cross-cutting spectrum
// property (foldback adds harmonics) shared across the wavefolder
// consumers; when we add headless-gl rendering this file will gain
// pixel-domain asserts on the rendered scope output.

import { describe, expect, it } from 'vitest';
import { buildFoldCurve } from '../../../packages/web/src/lib/audio/fold-curve';

/**
 * Apply a sample through the curve LUT (linear interp). Mirrors what
 * WaveShaperNode does internally — the unit-test contract.
 */
function applyCurve(curve: Float32Array, x: number): number {
  // Curve maps [-1, 1] linearly across [0, len-1].
  const N = curve.length;
  const u = (x + 1) * 0.5; // [0, 1]
  const fIdx = Math.max(0, Math.min(N - 1, u * (N - 1)));
  const i0 = Math.floor(fIdx);
  const i1 = Math.min(N - 1, i0 + 1);
  const t = fIdx - i0;
  return (curve[i0] ?? 0) * (1 - t) + (curve[i1] ?? 0) * t;
}

/** Naive DFT magnitude at a given bin. Cheap because we only care
 *  about a handful of harmonics, not the full spectrum. */
function dftMagAt(buf: Float32Array, k: number): number {
  let re = 0, im = 0;
  const N = buf.length;
  for (let n = 0; n < N; n++) {
    const phi = (-2 * Math.PI * k * n) / N;
    re += buf[n]! * Math.cos(phi);
    im += buf[n]! * Math.sin(phi);
  }
  return Math.sqrt(re * re + im * im) / N;
}

function renderSineThroughCurve(curve: Float32Array, fHz: number, sr: number, lengthS: number): Float32Array {
  const N = Math.round(sr * lengthS);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = Math.sin((2 * Math.PI * fHz * i) / sr);
    out[i] = applyCurve(curve, x);
  }
  return out;
}

describe('ART wavefolder — sine through identity passthrough', () => {
  it('fold = 0: spectrum is dominated by fundamental, harmonics are tiny', () => {
    const curve = buildFoldCurve(0);
    const sr = 48000;
    const f = 440;
    const buf = renderSineThroughCurve(curve, f, sr, 0.05); // 50ms
    // Fundamental bin at f * N / sr.
    const N = buf.length;
    const k1 = Math.round((f * N) / sr);
    const k3 = Math.round((3 * f * N) / sr);
    const k5 = Math.round((5 * f * N) / sr);
    const m1 = dftMagAt(buf, k1);
    const m3 = dftMagAt(buf, k3);
    const m5 = dftMagAt(buf, k5);
    expect(m1, 'fundamental present').toBeGreaterThan(0.1);
    // Higher harmonics are essentially noise floor for an identity curve.
    expect(m3 / m1, 'h3/h1 small for identity').toBeLessThan(0.05);
    expect(m5 / m1, 'h5/h1 small for identity').toBeLessThan(0.05);
  });
});

describe('ART wavefolder — sine through folded curve', () => {
  it('fold > 0: harmonic content rises (h3 magnitude rises vs identity)', () => {
    const sr = 48000;
    const f = 440;

    function harmonics(foldAmt: number): { m1: number; m3: number; m5: number } {
      const curve = buildFoldCurve(foldAmt);
      const buf = renderSineThroughCurve(curve, f, sr, 0.1);
      const N = buf.length;
      const k1 = Math.round((f * N) / sr);
      const k3 = Math.round((3 * f * N) / sr);
      const k5 = Math.round((5 * f * N) / sr);
      return {
        m1: dftMagAt(buf, k1),
        m3: dftMagAt(buf, k3),
        m5: dftMagAt(buf, k5),
      };
    }
    const id = harmonics(0);
    const folded = harmonics(0.5);
    // Identity has near-zero h3 and h5 (just a sine wave). Folded
    // version has measurable h3+h5 magnitudes. We don't assert
    // monotone in fold magnitude (sin(x*π*k) is non-monotone in k for
    // h3/h1 ratio at specific frequencies); instead, the bulk of
    // higher-harmonic energy must land somewhere noticeable.
    expect(id.m3, 'identity h3 ≈ 0').toBeLessThan(0.05);
    expect(id.m5, 'identity h5 ≈ 0').toBeLessThan(0.05);
    expect(folded.m3 + folded.m5, 'fold > 0 has measurable higher harmonics').toBeGreaterThan(0.05);
  });

  it('fold sweep: fold=1 produces multiple high harmonics', () => {
    const curve = buildFoldCurve(1.0);
    const sr = 48000;
    const f = 440;
    const buf = renderSineThroughCurve(curve, f, sr, 0.1);
    const N = buf.length;
    const k1 = Math.round((f * N) / sr);
    const k3 = Math.round((3 * f * N) / sr);
    const k5 = Math.round((5 * f * N) / sr);
    const k7 = Math.round((7 * f * N) / sr);
    const m1 = dftMagAt(buf, k1);
    const m3 = dftMagAt(buf, k3);
    const m5 = dftMagAt(buf, k5);
    const m7 = dftMagAt(buf, k7);
    const total = m1 + m3 + m5 + m7;
    // At fold=1, we expect significant energy outside h1.
    expect((m3 + m5 + m7) / Math.max(total, 1e-6)).toBeGreaterThan(0.2);
  });
});
