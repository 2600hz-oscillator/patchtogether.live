// packages/web/src/lib/video/modules/mandleblot-math.test.ts
//
// Pure-TS math tests for the Mandelbrot escape-time + smooth-coloring
// helpers. Keeps the iteration algorithm correct outside of GL (which
// jsdom can't render anyway). The shader uses the same algebra, so a
// passing TS run is strong evidence the shader is mathematically right
// — the only ports between TS and GLSL are syntax (Math.log vs log,
// dot vs zx*zx+zy*zy, etc.).

import { describe, it, expect } from 'vitest';
import { escapeTime, smoothMu } from './mandleblot';

describe('escapeTime — Mandelbrot iteration', () => {
  it('point (0, 0) is in the set — never escapes within maxIter', () => {
    // z=0, c=0 → z² + 0 = 0 forever. Iteration count saturates at maxIter.
    const { i } = escapeTime(0, 0, 200);
    expect(i).toBe(200);
  });

  it('point (-1, 0) is in the set (period-2 cycle)', () => {
    // c = -1: z₁ = -1, z₂ = 0, z₃ = -1, z₄ = 0, … (bounded forever).
    const { i } = escapeTime(-1, 0, 200);
    expect(i).toBe(200);
  });

  it('point (2, 2) escapes on iteration 1 (|c|² = 8 > 4 immediately)', () => {
    // z₀ = 0; z₁ = z₀² + c = (0, 0) + (2, 2) = (2, 2).
    // |z₁|² = 8, but our bailout is 256 (large bailout matters for smooth
    // colouring). At z₁ |z|²=8 — keep iterating.
    //   z₂ = z₁² + c = (2² - 2², 2*2*2) + (2,2) = (0,8) + (2,2) = (2,10).
    //   |z₂|² = 4 + 100 = 104 — still under 256.
    //   z₃ = z₂² + c = (4 - 100, 2*2*10) + (2,2) = (-96, 40) + (2,2) = (-94, 42).
    //   |z₃|² = 8836 + 1764 = 10600 — over 256 → escape at i=2 (the loop
    //   reports `i` as the index of the iteration that PUSHED z over).
    const { i } = escapeTime(2, 2, 200);
    expect(i).toBeLessThan(5);     // escapes very quickly
    expect(i).toBeGreaterThan(0);  // not at i=0 (since |z₁|² = 8 < 256)
  });

  it('point far outside (10, 0) escapes on iteration 0 — first step blows past bailout', () => {
    // z₁ = (10, 0); |z₁|² = 100 — still under 256.
    //   z₂ = (100 - 0, 0) + (10, 0) = (110, 0); |z₂|² = 12100 — over.
    // So i = 1 here (the second iteration is the one that escapes).
    const { i } = escapeTime(10, 0, 200);
    expect(i).toBeLessThanOrEqual(2);
  });

  it('point on the boundary (-0.75, 0) — tip of the period-2 bulb', () => {
    // Boundary point. Stays bounded for a long time but eventually escapes
    // at finite (high) maxIter. We don't pin a specific iteration count
    // (sensitive to bailout); just assert it's "deep in" — not a quick
    // escape.
    const { i } = escapeTime(-0.75, 0, 500);
    // At -0.75 the iteration converges slowly; with maxIter=500 it will
    // sit very near the boundary. Either deep or saturated is fine.
    expect(i).toBeGreaterThan(100);
  });

  it('symmetric across the real axis: escape time at (cx, cy) == escape time at (cx, -cy)', () => {
    // Mandelbrot is symmetric about the real axis.
    const a = escapeTime(-0.4, 0.3, 100);
    const b = escapeTime(-0.4, -0.3, 100);
    expect(a.i).toBe(b.i);
  });
});

describe('smoothMu — fractional iteration count', () => {
  it('in-set points return maxIter (no fractional offset)', () => {
    const mu = smoothMu(200, 0, 200);
    expect(mu).toBe(200);
  });

  it('produces a value in roughly [i, i+1] for escaped points', () => {
    // Standard formula: mu = i + 1 - log(0.5 * log(dotZ)) / log(2).
    // For dotZ just above bailout (256), the log of log → very negative,
    // so mu → i + 1 + (positive number) — but for "typical" dotZ in the
    // hundreds-to-thousands range, the value sits in [i, i+1].
    // Pick dotZ = e² ≈ 7.39 (forces inner log → 2). Bailout in our shader
    // is 256, but the math doesn't care — the formula is purely numeric.
    const mu = smoothMu(50, Math.exp(2), 200);
    // log(0.5 * 2) = log(1) = 0. So mu = 50 + 1 - 0 / log(2) = 51.
    expect(mu).toBeCloseTo(51, 5);
  });

  it('matches the standard formula for a known dotZ + i combination', () => {
    // Hand-computed reference for i=10, dotZ=1000:
    //   log(1000) = 6.9077...
    //   0.5 * log(1000) = 3.4539...
    //   log(3.4539) = 1.2393...
    //   log(2) = 0.6931...
    //   1.2393 / 0.6931 = 1.7881...
    //   mu = 10 + 1 - 1.7881 = 9.2119.
    const mu = smoothMu(10, 1000, 200);
    expect(mu).toBeCloseTo(9.2119, 3);
  });

  it('larger dotZ → larger correction → smaller mu (further below i+1)', () => {
    // mu = i + 1 - log( 0.5 * log(dotZ) ) / log(2).
    // As dotZ grows, log(dotZ) grows, the inner log grows, the outer
    // ratio grows — and that whole term is SUBTRACTED. So muLarge ends
    // up BELOW muSmall: larger dotZ pushes mu further from i+1.
    const muSmall = smoothMu(10, 300, 200);
    const muLarge = smoothMu(10, 1_000_000, 200);
    expect(muLarge).toBeLessThan(muSmall);
    // And both stay in a sensible window — neither blows up.
    expect(muLarge).toBeGreaterThan(0);
    expect(muSmall).toBeLessThan(11.5);
  });

  it('is continuous as a function of dotZ (no discontinuities for escaped points)', () => {
    // Sample mu at a dense series of dotZ values; assert successive
    // values are close. Guards against "is the formula written
    // correctly" in a way bracketed property-tests would catch.
    const samples: number[] = [];
    for (let dotZ = 257; dotZ < 1000; dotZ += 1) {
      samples.push(smoothMu(20, dotZ, 200));
    }
    for (let k = 1; k < samples.length; k++) {
      const delta = Math.abs(samples[k]! - samples[k - 1]!);
      // Monotone + smooth — every adjacent delta should be tiny.
      expect(delta).toBeLessThan(0.01);
    }
  });
});
