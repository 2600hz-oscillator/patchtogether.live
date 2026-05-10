// packages/web/src/lib/video/modules/shapedramps.test.ts
//
// Unit tests for SHAPEDRAMPS pure helpers. The GL-side rendering of the
// linear / shaped / mixer programs is covered by the e2e
// ruttetra-shapedramps tests; here we just verify the JS reference of
// the crossfade math the MIX shader implements.

import { describe, it, expect } from 'vitest';
import { shapedrampsMix } from './shapedramps';

describe('shapedrampsMix — onboard 2-channel mixer crossfade', () => {
  it('amount=0 → returns A (B is silent)', () => {
    expect(shapedrampsMix(0.4, 0.9, 0)).toBeCloseTo(0.4);
    expect(shapedrampsMix(1.0, 0.0, 0)).toBeCloseTo(1.0);
  });

  it('amount=1 → returns B (A is silent)', () => {
    expect(shapedrampsMix(0.4, 0.9, 1)).toBeCloseTo(0.9);
    expect(shapedrampsMix(0.0, 1.0, 1)).toBeCloseTo(1.0);
  });

  it('amount=0.5 → equal-weight linear blend', () => {
    expect(shapedrampsMix(0.0, 1.0, 0.5)).toBeCloseTo(0.5);
    expect(shapedrampsMix(0.2, 0.8, 0.5)).toBeCloseTo(0.5);
    expect(shapedrampsMix(1.0, 1.0, 0.5)).toBeCloseTo(1.0);
  });

  it('amount=0.25 → 75% A + 25% B', () => {
    expect(shapedrampsMix(1.0, 0.0, 0.25)).toBeCloseTo(0.75);
    expect(shapedrampsMix(0.0, 1.0, 0.25)).toBeCloseTo(0.25);
  });

  it('amount=0.75 → 25% A + 75% B', () => {
    expect(shapedrampsMix(1.0, 0.0, 0.75)).toBeCloseTo(0.25);
    expect(shapedrampsMix(0.0, 1.0, 0.75)).toBeCloseTo(0.75);
  });

  it('clamps amount > 1 to 1 (returns B)', () => {
    expect(shapedrampsMix(0.3, 0.7, 5)).toBeCloseTo(0.7);
    expect(shapedrampsMix(0.3, 0.7, Infinity)).toBeCloseTo(0.7);
  });

  it('clamps amount < 0 to 0 (returns A)', () => {
    expect(shapedrampsMix(0.3, 0.7, -1)).toBeCloseTo(0.3);
    expect(shapedrampsMix(0.3, 0.7, -Infinity)).toBeCloseTo(0.3);
  });

  it('matches the canonical formula (1 - amount) * A + amount * B for representative values', () => {
    const cases: Array<[number, number, number]> = [
      [0.1, 0.9, 0.2],
      [0.5, 0.5, 0.5],
      [0.0, 1.0, 0.33],
      [0.25, 0.75, 0.6],
      [1.0, 0.0, 0.4],
    ];
    for (const [a, b, t] of cases) {
      const expected = (1 - t) * a + t * b;
      expect(shapedrampsMix(a, b, t)).toBeCloseTo(expected, 6);
    }
  });
});
