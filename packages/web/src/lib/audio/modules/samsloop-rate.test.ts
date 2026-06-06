// packages/web/src/lib/audio/modules/samsloop-rate.test.ts
//
// Asymmetric rate-fader mapping for SAMSLOOP.
//
// The rate AudioParam ranges over [-2, +2] with the numeric value === the
// playback multiplier (1.0 = unity forward). Visually, the user expects
// the knob's geometric center to be "+100% = normal playback", NOT 0
// (stopped). That asymmetry is the whole reason knobToRate/rateToKnob
// exist — these tests are the source-of-truth contract.

import { describe, it, expect } from 'vitest';
import {
  knobToRate,
  rateToKnob,
  formatRatePercent,
} from './samsloop-rate';

describe('samsloop knobToRate — three pinned endpoints + center', () => {
  it('knob 0   → rate -2 (full left = reverse 2×)', () => {
    expect(knobToRate(0)).toBeCloseTo(-2, 10);
  });

  it('knob 0.5 → rate +1 (CENTER = forward unity / 100%)', () => {
    expect(knobToRate(0.5)).toBeCloseTo(1, 10);
  });

  it('knob 1   → rate +2 (full right = forward 2×)', () => {
    expect(knobToRate(1)).toBeCloseTo(2, 10);
  });

  it('knob 0.25 (mid-left) → rate -0.5 (one-quarter of the −2..+1 sweep)', () => {
    // Left half: rate = -2 + k*6  →  k=0.25 → -2 + 1.5 = -0.5
    expect(knobToRate(0.25)).toBeCloseTo(-0.5, 10);
  });

  it('knob 0.75 (mid-right) → rate +1.5 (halfway between +1 and +2)', () => {
    expect(knobToRate(0.75)).toBeCloseTo(1.5, 10);
  });

  it('out-of-range knob is clamped (NOT extrapolated)', () => {
    expect(knobToRate(-5)).toBeCloseTo(-2, 10);
    expect(knobToRate(99)).toBeCloseTo(2, 10);
  });

  it('NaN / non-finite falls back to the default (+1)', () => {
    // Non-finite values bypass the clamp + the piecewise math entirely
    // and return the param's default. This is the "panic" fallback —
    // a rogue Infinity should never propagate into rate state.
    expect(knobToRate(NaN)).toBe(1);
    expect(knobToRate(Infinity)).toBe(1);
    expect(knobToRate(-Infinity)).toBe(1);
  });
});

describe('samsloop rateToKnob — three pinned endpoints + center', () => {
  it('rate -2 → knob 0', () => {
    expect(rateToKnob(-2)).toBeCloseTo(0, 10);
  });

  it('rate +1 → knob 0.5 (the center marker)', () => {
    expect(rateToKnob(1)).toBeCloseTo(0.5, 10);
  });

  it('rate +2 → knob 1', () => {
    expect(rateToKnob(2)).toBeCloseTo(1, 10);
  });

  it('rate 0 (stopped) → knob 1/3 (one-third up the left half)', () => {
    // Left half: k = (r+2)/6  →  r=0 → 2/6 = 1/3
    expect(rateToKnob(0)).toBeCloseTo(1 / 3, 10);
  });

  it('rate -1 (reverse unity) → knob 1/6', () => {
    expect(rateToKnob(-1)).toBeCloseTo(1 / 6, 10);
  });

  it('out-of-range rate is clamped to [-2, +2] before mapping', () => {
    expect(rateToKnob(-10)).toBeCloseTo(0, 10);
    expect(rateToKnob(10)).toBeCloseTo(1, 10);
  });
});

describe('samsloop rate ↔ knob round-trip', () => {
  // Round-trip must be exact (within fp tolerance) at every sample point
  // — the fader will move through hundreds of intermediate positions
  // during a drag and we need the value-tag display to match what the
  // worklet actually plays.
  for (const k of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    it(`rateToKnob(knobToRate(${k})) ≈ ${k}`, () => {
      expect(rateToKnob(knobToRate(k))).toBeCloseTo(k, 10);
    });
  }

  for (const r of [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.25, 1.5, 1.75, 2]) {
    it(`knobToRate(rateToKnob(${r})) ≈ ${r}`, () => {
      expect(knobToRate(rateToKnob(r))).toBeCloseTo(r, 10);
    });
  }
});

describe('samsloop rate piecewise continuity at the seam (knob=0.5)', () => {
  // The seam between branches must be continuous: as the user drags
  // across the center, the rate must not jump. The slope is different
  // on each side (6 vs 2), but the VALUE at the seam must match —
  // otherwise dragging through center would produce a visible step.

  it('approaching knob=0.5 from below converges to rate=+1', () => {
    // Slope-6 left branch: a 1e-9 offset shifts rate by 6e-9, so we
    // compare with a slightly looser tolerance than the offset would
    // naively suggest. (toBeCloseTo(x, n) checks |diff| < 0.5 * 10^-n.)
    expect(knobToRate(0.5 - 1e-9)).toBeCloseTo(1, 7);
    expect(knobToRate(0.4999999)).toBeCloseTo(1, 5);
  });

  it('approaching knob=0.5 from above converges to rate=+1', () => {
    // Slope-2 right branch: tighter convergence at the same offset.
    expect(knobToRate(0.5 + 1e-9)).toBeCloseTo(1, 8);
    expect(knobToRate(0.5000001)).toBeCloseTo(1, 5);
  });

  it('two-sided limits match at knob=0.5 exactly', () => {
    // The seam between branches must be identical from both sides — if
    // it weren't, dragging across the center would visibly jump.
    const justBelow = knobToRate(0.5 - 1e-12);
    const exact = knobToRate(0.5);
    const justAbove = knobToRate(0.5 + 1e-12);
    expect(justBelow).toBeCloseTo(exact, 8);
    expect(justAbove).toBeCloseTo(exact, 8);
    // The exact-center value must hit +1 with no fp slop.
    expect(exact).toBe(1);
  });

  it('approaching rate=+1 from below converges to knob=0.5', () => {
    expect(rateToKnob(1 - 1e-9)).toBeCloseTo(0.5, 8);
  });

  it('approaching rate=+1 from above converges to knob=0.5', () => {
    expect(rateToKnob(1 + 1e-9)).toBeCloseTo(0.5, 8);
  });
});

describe('samsloop formatRatePercent', () => {
  it('formats unity forward as +100%', () => {
    expect(formatRatePercent(1)).toBe('+100%');
  });

  it('formats zero as 0% (no sign)', () => {
    expect(formatRatePercent(0)).toBe('0%');
  });

  it('formats positive forward rates with a leading +', () => {
    expect(formatRatePercent(0.5)).toBe('+50%');
    expect(formatRatePercent(2)).toBe('+200%');
  });

  it('formats negative (reverse) rates with the standard minus', () => {
    expect(formatRatePercent(-1)).toBe('-100%');
    expect(formatRatePercent(-2)).toBe('-200%');
    expect(formatRatePercent(-0.25)).toBe('-25%');
  });

  it('rounds to integer percent (no decimals at the value-tag)', () => {
    expect(formatRatePercent(0.5005)).toBe('+50%');
    expect(formatRatePercent(0.504)).toBe('+50%');
    expect(formatRatePercent(0.506)).toBe('+51%');
  });

  it('falls back to "0%" on non-finite input', () => {
    expect(formatRatePercent(NaN)).toBe('0%');
    expect(formatRatePercent(Infinity)).toBe('0%');
  });
});
