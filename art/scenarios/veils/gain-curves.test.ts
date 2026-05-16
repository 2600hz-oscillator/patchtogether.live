// art/scenarios/veils/gain-curves.test.ts
//
// ART-tier check on VEILS — exercises the pure-math helper across a knob
// sweep to confirm: linear curve is a straight line, exponential curve is
// quadratic (matches y = x² above zero), soft-clip onset is symmetric and
// kicks in past unity. Same offline-render pattern as the stereovca ART.
//
// Why ART rather than just vitest: this is the cross-cutting DSP property
// that defines Veils — gain-not-clamped-at-1.0 → tanh-saturated mix. A
// future refactor that swaps the curve formulas or the soft-clip function
// is caught here with quantitative assertions rather than relying on
// signal-shape eyeballs.

import { describe, expect, it } from 'vitest';
import { veilsMath } from '../../../packages/web/src/lib/audio/modules/veils';

describe('ART veils / linear gain curve is straight', () => {
  it('shape(x, linear) = x for x ∈ [0, 2] (within FP precision)', () => {
    // 21-point sweep from 0 to 2. The linear curve is literally the
    // identity above zero, so the difference between sweep[i] and the
    // value of shape(sweep[i], 'linear') must be 0 sample-by-sample.
    for (let i = 0; i <= 20; i++) {
      const x = (i / 20) * 2;
      expect(veilsMath.shape(x, 'linear')).toBeCloseTo(x, 12);
    }
  });

  it('linear curve has unit slope: shape(x+δ) - shape(x) = δ', () => {
    // Differential check — the slope is constant 1 across the whole
    // positive range. Confirm at 5 sample points with a tiny δ so any
    // hidden nonlinearity stands out as a non-1.0 slope.
    const delta = 1e-5;
    for (const x of [0.1, 0.5, 1.0, 1.5, 1.9]) {
      const slope =
        (veilsMath.shape(x + delta, 'linear') - veilsMath.shape(x, 'linear')) / delta;
      expect(slope).toBeCloseTo(1, 4);
    }
  });
});

describe('ART veils / exponential gain curve has the expected curvature', () => {
  it('shape(x, exponential) = x² for x ∈ [0, 2]', () => {
    for (let i = 0; i <= 20; i++) {
      const x = (i / 20) * 2;
      expect(veilsMath.shape(x, 'exponential')).toBeCloseTo(x * x, 10);
    }
  });

  it('exp curve slope is 2x (derivative of x²)', () => {
    // d/dx [x²] = 2x. At x=0.5 slope=1, at x=1.0 slope=2, at x=1.5 slope=3.
    const delta = 1e-5;
    for (const x of [0.5, 1.0, 1.5]) {
      const slope =
        (veilsMath.shape(x + delta, 'exponential') - veilsMath.shape(x, 'exponential')) /
        delta;
      expect(slope).toBeCloseTo(2 * x, 3);
    }
  });

  it('exp curve is below linear for x ∈ (0, 1) and above linear for x ∈ (1, 2]', () => {
    // The "smooth fade for audio" use case — exp gain starts slower than
    // linear, then ramps faster past unity. The curves cross at x=1.
    for (const x of [0.1, 0.5, 0.8]) {
      expect(veilsMath.shape(x, 'exponential')).toBeLessThan(
        veilsMath.shape(x, 'linear'),
      );
    }
    expect(veilsMath.shape(1, 'exponential')).toBeCloseTo(
      veilsMath.shape(1, 'linear'),
      12,
    );
    for (const x of [1.2, 1.5, 2.0]) {
      expect(veilsMath.shape(x, 'exponential')).toBeGreaterThan(
        veilsMath.shape(x, 'linear'),
      );
    }
  });
});

describe('ART veils / soft-clip onset above unity', () => {
  it('tanh soft-clip preserves small-signal linearity (deviation < 1% for |sum| ≤ 0.1)', () => {
    // For small inputs the tanh approximation is x - x³/3 + ..., so the
    // relative error vs. linear pass-through is roughly (x²/3). At x=0.1
    // that's ~0.33% — well under 1%.
    for (const sum of [-0.1, -0.05, 0.05, 0.1]) {
      const clipped = veilsMath.softClip(sum);
      const relErr = Math.abs((clipped - sum) / sum);
      expect(relErr).toBeLessThan(0.01);
    }
  });

  it('soft-clip onset: by |sum| = 1 the deviation from linear is ~24%', () => {
    // tanh(1) ≈ 0.7616, so (1 - 0.7616) / 1 ≈ 0.238 deviation. This is
    // the "starting to compress" sweet spot Veils is known for.
    const clipped = veilsMath.softClip(1);
    expect(clipped).toBeCloseTo(Math.tanh(1), 6);
    const deviation = (1 - clipped) / 1;
    expect(deviation).toBeGreaterThan(0.2);
    expect(deviation).toBeLessThan(0.3);
  });

  it('soft-clip is asymptotic: |sum|=10 maps to ~0.99 (no digital hard-clip artifacts)', () => {
    const huge = veilsMath.softClip(10);
    expect(Math.abs(huge)).toBeLessThan(1);
    expect(Math.abs(huge)).toBeGreaterThan(0.99);
    // Symmetric in sign.
    expect(veilsMath.softClip(-10)).toBeCloseTo(-huge, 12);
  });
});

describe('ART veils / end-to-end overdrive: 4-channel unity drives mix into saturation', () => {
  it('four channels at amplitude 0.5 * gain 1.0 (linear) drives mix to tanh(2) ≈ 0.964', () => {
    // Sum of four 0.5-amplitude signals each at unity gain = 2.0.
    // Mix soft-clips to tanh(2) ≈ 0.9640. This is the "knob + CV pushes
    // past 1.0, mix bus saturates warmly" Veils signature.
    const N = 128;
    const buf = new Float32Array(N).fill(0.5);
    const { mix } = veilsMath.render(
      [buf, buf, buf, buf],
      [null, null, null, null],
      [1, 1, 1, 1],
      ['linear', 'linear', 'linear', 'linear'],
      N,
    );
    let peak = -Infinity;
    let trough = Infinity;
    for (let i = 0; i < N; i++) {
      if ((mix[i] ?? 0) > peak) peak = mix[i] ?? 0;
      if ((mix[i] ?? 0) < trough) trough = mix[i] ?? 0;
    }
    expect(peak).toBeCloseTo(Math.tanh(2), 5);
    expect(trough).toBeCloseTo(Math.tanh(2), 5);
    expect(peak).toBeLessThan(1);
  });

  it('overdrive with EXP curves saturates harder', () => {
    // EXP curve squares the post-knob gain. knob=1.5 (exp gain = 2.25) ×
    // 0.5 audio = 1.125 per channel → sum 4.5 → tanh(4.5) ≈ 0.9998.
    const N = 32;
    const buf = new Float32Array(N).fill(0.5);
    const { mix } = veilsMath.render(
      [buf, buf, buf, buf],
      [null, null, null, null],
      [1.5, 1.5, 1.5, 1.5],
      ['exponential', 'exponential', 'exponential', 'exponential'],
      N,
    );
    const sample = mix[0] ?? 0;
    expect(sample).toBeCloseTo(Math.tanh(4 * 0.5 * 2.25), 4);
    expect(sample).toBeGreaterThan(0.99);
    expect(sample).toBeLessThan(1);
  });

  it('CV drives gain past unity for soft-clip overdrive (knob=1, +cv=0.5 → linear gain 1.5)', () => {
    // The "+5V CV pushes gain over 1" story, scaled to our ±1V CV range.
    // knob=1.0 + cv=+0.5 → effective gain 1.5 linear. Per-channel out =
    // 0.5 * 1.5 = 0.75; 4 channels sum = 3.0; mix = tanh(3) ≈ 0.995.
    const N = 16;
    const buf = new Float32Array(N).fill(0.5);
    const cv  = new Float32Array(N).fill(0.5);
    const { mix } = veilsMath.render(
      [buf, buf, buf, buf],
      [cv, cv, cv, cv],
      [1, 1, 1, 1],
      ['linear', 'linear', 'linear', 'linear'],
      N,
    );
    const sample = mix[0] ?? 0;
    expect(sample).toBeCloseTo(Math.tanh(3), 5);
    expect(sample).toBeGreaterThan(0.99);
  });
});
