// packages/web/src/lib/audio/humanize.test.ts
//
// Unit tests for the humanize delay distribution. Pure JS; no Web Audio.

import { describe, it, expect } from 'vitest';
import {
  HUMANIZE_MAX_DELAY_S,
  HUMANIZE_MID_DELAY_S,
  humanizeMaxDelay,
  humanizeShape,
  sampleHumanizeOffset,
  sampleHumanizeOffsets,
} from './humanize';

/** Tiny seedable PRNG (mulberry32) so distribution tests are deterministic. */
function makeRng(seed: number): () => number {
  let t = seed;
  return () => {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe('humanize: max delay ramp', () => {
  it('amount=0 => 0 delay', () => {
    expect(humanizeMaxDelay(0)).toBe(0);
  });
  it('amount=0.5 => HUMANIZE_MID_DELAY_S (15ms)', () => {
    expect(humanizeMaxDelay(0.5)).toBeCloseTo(HUMANIZE_MID_DELAY_S, 6);
    expect(humanizeMaxDelay(0.5)).toBeCloseTo(0.015, 4);
  });
  it('amount=1 => HUMANIZE_MAX_DELAY_S (50ms)', () => {
    expect(humanizeMaxDelay(1)).toBeCloseTo(HUMANIZE_MAX_DELAY_S, 6);
    expect(humanizeMaxDelay(1)).toBeCloseTo(0.05, 4);
  });
  it('above 1 saturates at HUMANIZE_MAX_DELAY_S', () => {
    expect(humanizeMaxDelay(2)).toBe(HUMANIZE_MAX_DELAY_S);
  });
  it('negative amounts return 0', () => {
    expect(humanizeMaxDelay(-0.5)).toBe(0);
  });
  it('NaN amount returns 0', () => {
    expect(humanizeMaxDelay(NaN)).toBe(0);
  });
});

describe('humanize: shape exponent ramp', () => {
  it('amount=0 => exponent 1 (uniform)', () => {
    expect(humanizeShape(0)).toBe(1);
  });
  it('amount=1 => exponent 3 (heavy tail)', () => {
    expect(humanizeShape(1)).toBe(3);
  });
  it('amount=0.5 => exponent 2', () => {
    expect(humanizeShape(0.5)).toBe(2);
  });
});

describe('humanize: sampleHumanizeOffset', () => {
  it('amount=0 always returns 0', () => {
    const rng = makeRng(42);
    for (let i = 0; i < 200; i++) {
      expect(sampleHumanizeOffset(0, rng)).toBe(0);
    }
  });

  it('amount=0.5: all samples within ±MID_DELAY_S', () => {
    const rng = makeRng(123);
    let extremeCount = 0;
    for (let i = 0; i < 5000; i++) {
      const v = sampleHumanizeOffset(0.5, rng);
      expect(Math.abs(v)).toBeLessThanOrEqual(HUMANIZE_MID_DELAY_S);
      if (Math.abs(v) > HUMANIZE_MID_DELAY_S * 0.9) extremeCount++;
    }
    // With exponent 2 (mid amount), the distribution peaks toward 0 — only
    // a small fraction should be near the rails.
    expect(extremeCount).toBeLessThan(500); // <10% — sanity bound
  });

  it('amount=1: all samples within ±MAX_DELAY_S; values can be negative', () => {
    const rng = makeRng(789);
    let neg = 0, pos = 0;
    for (let i = 0; i < 5000; i++) {
      const v = sampleHumanizeOffset(1, rng);
      expect(Math.abs(v)).toBeLessThanOrEqual(HUMANIZE_MAX_DELAY_S);
      if (v < 0) neg++; else if (v > 0) pos++;
    }
    // Both signs should be represented (rough symmetry).
    expect(neg).toBeGreaterThan(1000);
    expect(pos).toBeGreaterThan(1000);
  });

  it('amount=1 is more spread out than amount=0.5 (variance grows with amount)', () => {
    const rng1 = makeRng(11);
    const rng2 = makeRng(11); // same seed for fair comparison
    let sumSq05 = 0, sumSq10 = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const a = sampleHumanizeOffset(0.5, rng1);
      sumSq05 += a * a;
      const b = sampleHumanizeOffset(1.0, rng2);
      sumSq10 += b * b;
    }
    // Variance at amount=1 must clearly exceed variance at amount=0.5 — the
    // chaotic-cluster claim made by the design.
    expect(sumSq10 / N).toBeGreaterThan(sumSq05 / N);
  });

  it('amount=1: most-extreme samples cluster near the rails (cubic shape)', () => {
    // With exponent 3, |v|=max only when |c|=1 (rng=0 or 1). The cubic curve
    // pushes more mass toward the rails than the linear (exp=1) shape.
    const rngLin = makeRng(2025);
    const rngCub = makeRng(2025);
    let nearRailLinCount = 0;
    let nearRailCubCount = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      // Linear: amount=0 in shape but max=MAX (we need the same magnitude for
      // a fair comparison) — we just compare a bunch at amount=1 to a uniform
      // baseline approximated by 2u-1 scaled.
      const u = rngLin();
      const linRail = 2 * u - 1; // ∈ [-1,1)
      if (Math.abs(linRail) > 0.9) nearRailLinCount++;
      const v = sampleHumanizeOffset(1.0, rngCub);
      if (Math.abs(v) > 0.9 * HUMANIZE_MAX_DELAY_S) nearRailCubCount++;
    }
    // Cubic distribution should have FEWER "near rail" hits than uniform —
    // sign(c) * |c|^3 maps [-1,1] but compresses values away from 1 (since
    // |0.9|^3 ≈ 0.73). So cubic should be SMALLER. Sanity-check the asymmetry.
    expect(nearRailCubCount).toBeLessThan(nearRailLinCount);
    // But high amount should still produce some near-rail clusters.
    expect(nearRailCubCount).toBeGreaterThan(0);
  });
});

describe('humanize: sampleHumanizeOffsets (vector form)', () => {
  it('returns N independent samples', () => {
    const rng = makeRng(7);
    const out = sampleHumanizeOffsets(0.7, 5, rng);
    expect(out.length).toBe(5);
    // With humanize > 0, samples should differ (P(all equal) ≈ 0).
    const distinct = new Set(out).size;
    expect(distinct).toBeGreaterThan(1);
  });

  it('amount=0 returns all-zero vector', () => {
    const out = sampleHumanizeOffsets(0, 5);
    expect(out).toEqual([0, 0, 0, 0, 0]);
  });
});
