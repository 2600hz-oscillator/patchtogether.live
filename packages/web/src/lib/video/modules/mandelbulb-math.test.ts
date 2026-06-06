// packages/web/src/lib/video/modules/mandelbulb-math.test.ts
//
// Pure-TS tests for the Mandelbulb distance estimate (DE) + camera-zoom
// mapping. jsdom can't render the GLSL, but the GLSL `mandelbulbDE` is a
// line-for-line port of `jsDistanceEstimate` (the only differences are
// syntax — Math.* vs GLSL builtins), so a passing TS run is strong
// evidence the shader's DE is mathematically right.

import { describe, it, expect } from 'vitest';
import {
  jsDistanceEstimate,
  jsEyeDistanceFromZoom,
  MANDELBULB_BAILOUT,
} from './mandelbulb';

const POWER = 8;
const ITERS = 20;

describe('jsDistanceEstimate — Mandelbulb DE', () => {
  it('a point well outside the unit bulb reports a positive distance ~ its radius', () => {
    // Far outside the bulb (which lives in roughly |p| < 1.2), the DE
    // should be positive and on the order of the distance to the surface.
    const d = jsDistanceEstimate(3, 0, 0, POWER, ITERS);
    expect(d).toBeGreaterThan(0);
    // It's a lower-bound estimate of the true distance (3 - ~1.2 ≈ 1.8),
    // so it should be a meaningful positive number, not ~0.
    expect(d).toBeGreaterThan(0.3);
  });

  it('the exact origin is the polar singularity (acos(z/r), r=0) → NaN, same as GLSL', () => {
    // p = origin: r stays 0, so acos(z.z/r) = acos(NaN) = NaN in both this
    // reference AND the GLSL port. The raymarch never samples the exact
    // origin in practice (ray steps + finite-diff epsilons offset it), so
    // this degenerate point is documented, not defended against.
    const d = jsDistanceEstimate(0, 0, 0, POWER, ITERS);
    expect(Number.isNaN(d)).toBe(true);
  });

  it('a point just inside the bulb reports a small (near-surface) distance', () => {
    // Slightly off-origin interior point: finite + small magnitude — deep
    // inside the set the DE underestimates toward ~0 near the surface.
    const d = jsDistanceEstimate(0.05, 0.02, 0.01, POWER, ITERS);
    expect(Number.isFinite(d)).toBe(true);
    expect(Math.abs(d)).toBeLessThan(0.2);
  });

  it('DE shrinks as a ray approaches the surface from outside (monotone-ish)', () => {
    // Sampling inward along +X from far to near, the DE should decrease as
    // we get closer to the bulb surface (it's a distance estimate).
    const far = jsDistanceEstimate(2.5, 0, 0, POWER, ITERS);
    const mid = jsDistanceEstimate(1.6, 0, 0, POWER, ITERS);
    const near = jsDistanceEstimate(1.25, 0, 0, POWER, ITERS);
    expect(far).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(near);
  });

  it('is finite + not NaN across a sampled shell of points', () => {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = 1.3;
      const d = jsDistanceEstimate(r * Math.cos(a), r * Math.sin(a), 0.3, POWER, ITERS);
      expect(Number.isFinite(d)).toBe(true);
    }
  });

  it('higher power changes the field (power is a live control)', () => {
    const d8 = jsDistanceEstimate(1.4, 0.2, 0.1, 8, ITERS);
    const d3 = jsDistanceEstimate(1.4, 0.2, 0.1, 3, ITERS);
    expect(d8).not.toBeCloseTo(d3, 4);
  });

  it('a point far past the bailout escapes on the first iteration', () => {
    // |p| = 10 > BAILOUT (2.5): the loop breaks at i=0 with r≈10, so the DE
    // is dominated by 0.5*log(10)*10 / 1.
    const d = jsDistanceEstimate(10, 0, 0, POWER, ITERS);
    const expected = 0.5 * Math.log(10) * 10 / 1.0;
    expect(d).toBeCloseTo(expected, 6);
  });

  it('BAILOUT is the documented 2.5', () => {
    expect(MANDELBULB_BAILOUT).toBe(2.5);
  });
});

describe('jsEyeDistanceFromZoom — camera dolly', () => {
  it('zoom = 1 reproduces the reference eye distance ~2.2', () => {
    expect(jsEyeDistanceFromZoom(1)).toBeCloseTo(2.2, 6);
  });

  it('larger zoom dollies the eye CLOSER (smaller distance)', () => {
    expect(jsEyeDistanceFromZoom(2)).toBeLessThan(jsEyeDistanceFromZoom(1));
    expect(jsEyeDistanceFromZoom(3)).toBeLessThan(jsEyeDistanceFromZoom(2));
  });

  it('smaller zoom dollies the eye FARTHER (larger distance)', () => {
    expect(jsEyeDistanceFromZoom(0.5)).toBeGreaterThan(jsEyeDistanceFromZoom(1));
  });

  it('clamps the knob to the 0.3..3 range', () => {
    expect(jsEyeDistanceFromZoom(-5)).toBe(jsEyeDistanceFromZoom(0.3));
    expect(jsEyeDistanceFromZoom(99)).toBe(jsEyeDistanceFromZoom(3));
  });
});
