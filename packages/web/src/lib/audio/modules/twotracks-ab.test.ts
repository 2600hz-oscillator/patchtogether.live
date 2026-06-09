// packages/web/src/lib/audio/modules/twotracks-ab.test.ts
//
// Unit tests for the TWOTRACKS Phase-2 A/B mix law.
// Pure logic — no AudioContext deps.
//
// Law:
//   ab in [0, 0.5]: gainA = 1.0, gainB = ab * 2
//   ab in [0.5, 1]: gainA = (1 - ab) * 2, gainB = 1.0
//   ab = 0.5 (center): gainA = 1.0, gainB = 1.0 (both unity)

import { describe, it, expect } from 'vitest';
import { abGains } from './twotracks';

describe('twotracks A/B gain law', () => {
  // ─── Boundary values ───

  it('ab=0: gainA=1.0, gainB=0', () => {
    const { gainA, gainB } = abGains(0);
    expect(gainA).toBeCloseTo(1.0);
    expect(gainB).toBeCloseTo(0);
  });

  it('ab=0.25: gainA=1.0, gainB=0.5', () => {
    const { gainA, gainB } = abGains(0.25);
    expect(gainA).toBeCloseTo(1.0);
    expect(gainB).toBeCloseTo(0.5);
  });

  it('ab=0.5: gainA=1.0, gainB=1.0 (both unity at center)', () => {
    const { gainA, gainB } = abGains(0.5);
    expect(gainA).toBeCloseTo(1.0);
    expect(gainB).toBeCloseTo(1.0);
  });

  it('ab=0.75: gainA=0.5, gainB=1.0', () => {
    const { gainA, gainB } = abGains(0.75);
    expect(gainA).toBeCloseTo(0.5);
    expect(gainB).toBeCloseTo(1.0);
  });

  it('ab=1.0: gainA=0, gainB=1.0', () => {
    const { gainA, gainB } = abGains(1.0);
    expect(gainA).toBeCloseTo(0);
    expect(gainB).toBeCloseTo(1.0);
  });

  // ─── Law shape: A-side is flat 1.0 until 0.5 ───

  it('gainA is always 1.0 for ab <= 0.5', () => {
    for (const ab of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
      expect(abGains(ab).gainA).toBeCloseTo(1.0);
    }
  });

  it('gainB is always 1.0 for ab >= 0.5', () => {
    for (const ab of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
      expect(abGains(ab).gainB).toBeCloseTo(1.0);
    }
  });

  // ─── Linearity checks ───

  it('gainB rises linearly from 0→1 over ab=0→0.5', () => {
    const g0  = abGains(0);
    const g25 = abGains(0.25);
    const g5  = abGains(0.5);
    // Check that the midpoint 0.25 gives gainB midway between 0 and 1
    expect(g0.gainB).toBeCloseTo(0);
    expect(g25.gainB).toBeCloseTo(0.5);
    expect(g5.gainB).toBeCloseTo(1.0);
  });

  it('gainA falls linearly from 1→0 over ab=0.5→1', () => {
    const g5  = abGains(0.5);
    const g75 = abGains(0.75);
    const g1  = abGains(1.0);
    expect(g5.gainA).toBeCloseTo(1.0);
    expect(g75.gainA).toBeCloseTo(0.5);
    expect(g1.gainA).toBeCloseTo(0);
  });

  // ─── Clamping: out-of-range input ───

  it('clamps ab below 0 to 0', () => {
    const { gainA, gainB } = abGains(-1);
    expect(gainA).toBeCloseTo(1.0);
    expect(gainB).toBeCloseTo(0);
  });

  it('clamps ab above 1 to 1', () => {
    const { gainA, gainB } = abGains(2);
    expect(gainA).toBeCloseTo(0);
    expect(gainB).toBeCloseTo(1.0);
  });

  // ─── Continuity at the center seam ───

  it('law is continuous at 0.5 (left and right limits match)', () => {
    const epsilon = 1e-7;
    const left  = abGains(0.5 - epsilon);
    const right = abGains(0.5 + epsilon);
    // gainA should be virtually identical near 0.5
    expect(left.gainA).toBeCloseTo(right.gainA, 5);
    // gainB should be virtually identical near 0.5
    expect(left.gainB).toBeCloseTo(right.gainB, 5);
  });
});
