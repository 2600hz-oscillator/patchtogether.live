// packages/dsp/src/lib/mandelbulb-de.test.ts
//
// Pure unit tests for the MANDELBULB distance-estimate core — the single source
// of truth shared by the GLSL shader, the bulb-slice readout, and the
// mandelbulb-osc worklet. Extracted but untested. It's pure + deterministic
// (no GL), so these pin the DE math the GLSL mirrors:
//   • escaped (far) points return a large positive distance estimate;
//   • DE approximates true distance (farther point ⇒ larger DE);
//   • the exact origin is the documented polar singularity → NaN;
//   • deterministic + finite for any non-origin sample.

import { describe, it, expect } from 'vitest';
import { jsDistanceEstimate, MANDELBULB_BAILOUT } from './mandelbulb-de';

const P = 8; // classic Mandelbulb power
const N = 20; // iteration budget

describe('MANDELBULB_BAILOUT', () => {
  it('is the royvanrijn reference escape radius 2.5', () => {
    expect(MANDELBULB_BAILOUT).toBe(2.5);
  });
});

describe('jsDistanceEstimate', () => {
  it('a far point escapes on the first iter → DE = 0.5·ln(r)·r', () => {
    // (5,0,0): r=5 > bailout → break with dr=1 → 0.5·ln(5)·5.
    expect(jsDistanceEstimate(5, 0, 0, P, N)).toBeCloseTo(0.5 * Math.log(5) * 5, 4);
  });

  it('DE approximates distance: a farther exterior point has a larger DE', () => {
    const near = jsDistanceEstimate(2.6, 0, 0, P, N); // just outside bailout
    const far = jsDistanceEstimate(5, 0, 0, P, N);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });

  it('an interior point yields a small-magnitude (non-escaping) estimate', () => {
    const inside = jsDistanceEstimate(0.2, 0, 0, P, N);
    expect(Number.isFinite(inside)).toBe(true);
    // it never escapes (r stays small) → |DE| is far smaller than the far point's
    expect(Math.abs(inside)).toBeLessThan(jsDistanceEstimate(5, 0, 0, P, N));
  });

  it('the exact origin is the documented polar singularity → NaN', () => {
    expect(Number.isNaN(jsDistanceEstimate(0, 0, 0, P, N))).toBe(true);
  });

  it('is deterministic', () => {
    const a = jsDistanceEstimate(0.7, -0.3, 0.4, P, N);
    const b = jsDistanceEstimate(0.7, -0.3, 0.4, P, N);
    expect(a).toBe(b);
  });

  it('is finite for a sweep of non-origin samples + powers + iter budgets', () => {
    for (let xi = -6; xi <= 6; xi++) {
      for (let yi = -3; yi <= 3; yi++) {
        const x = xi / 2 + 0.013; // dodge the exact origin
        const y = yi / 2;
        for (const power of [2, 8]) {
          const d = jsDistanceEstimate(x, y, 0.21, power, N);
          expect(Number.isFinite(d)).toBe(true);
        }
      }
    }
  });
});
