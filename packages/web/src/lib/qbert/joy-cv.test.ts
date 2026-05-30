// packages/web/src/lib/qbert/joy-cv.test.ts
//
// Pinning table for the CV → diagonal helper. 10 cases per spec — covers
// the dead band, single-axis swings, and all 4 diagonals.

import { describe, it, expect } from 'vitest';
import { joyCvToDiagonal, DEFAULT_JOY_THRESH } from './joy-cv';

describe('joyCvToDiagonal — pinning table', () => {
  it('returns NEUTRAL inside the dead band on both axes', () => {
    expect(joyCvToDiagonal(0, 0)).toBe('NEUTRAL');
  });

  it('returns NEUTRAL just under threshold (one axis at threshold-epsilon)', () => {
    expect(joyCvToDiagonal(DEFAULT_JOY_THRESH - 0.01, DEFAULT_JOY_THRESH - 0.01)).toBe('NEUTRAL');
  });

  it('+x, +y full deflection → SE', () => {
    expect(joyCvToDiagonal(0.8, 0.8)).toBe('SE');
  });

  it('-x, +y full deflection → SW', () => {
    expect(joyCvToDiagonal(-0.8, 0.8)).toBe('SW');
  });

  it('+x, -y full deflection → NE', () => {
    expect(joyCvToDiagonal(0.8, -0.8)).toBe('NE');
  });

  it('-x, -y full deflection → NW', () => {
    expect(joyCvToDiagonal(-0.8, -0.8)).toBe('NW');
  });

  it('pure +x (jy = 0) resolves to SE (downward bias on the inactive axis)', () => {
    expect(joyCvToDiagonal(0.9, 0)).toBe('SE');
  });

  it('pure -y (jx = 0) resolves to NE (rightward bias on the inactive axis)', () => {
    expect(joyCvToDiagonal(0, -0.9)).toBe('NE');
  });

  it('out-of-range overshoot still resolves cleanly (jx=+2, jy=+2 → SE)', () => {
    expect(joyCvToDiagonal(2.0, 2.0)).toBe('SE');
  });

  it('custom threshold (0.1) — values that were NEUTRAL at 0.3 now resolve', () => {
    expect(joyCvToDiagonal(0.2, 0.2, 0.1)).toBe('SE');
    // And the original 0.3-default dead band still works as NEUTRAL.
    expect(joyCvToDiagonal(0.2, 0.2)).toBe('NEUTRAL');
  });
});
