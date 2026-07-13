// packages/web/src/lib/audio/modules/clip-clock.test.ts
//
// PURE math for the clipplayer per-lane clock RATE (mult/div) — the table, the
// coercion, and the duration scaling. The SCHEDULING behavior (exact 2:1:4
// ratios, common phase origin, reset re-anchor, tempo change) is tested through
// the REAL factory + tick loop in clipplayer.test.ts.

import { describe, it, expect } from 'vitest';
import {
  RATE_LABELS,
  RATE_MULTS,
  RATE_DEFAULT_INDEX,
  coerceRateIndex,
  laneRateIndex,
  laneStepDur,
  clipDivIndex,
} from './clip-clock';

describe('clip-clock: rate table', () => {
  it('has the exact owner-specified choices, in order, label↔mult paired', () => {
    expect(RATE_LABELS).toEqual(['1/8', '1/4', '1/2', '1', '2x', '4x']);
    expect(RATE_MULTS).toEqual([0.125, 0.25, 0.5, 1, 2, 4]);
    expect(RATE_LABELS.length).toBe(RATE_MULTS.length);
  });

  it("defaults to '1' (the global STEP grid)", () => {
    expect(RATE_LABELS[RATE_DEFAULT_INDEX]).toBe('1');
    expect(RATE_MULTS[RATE_DEFAULT_INDEX]).toBe(1);
  });

  it('every mult is dyadic (exact in binary float — aligned sums stay exact)', () => {
    for (const m of RATE_MULTS) {
      // m = 2^k for integer k — no accumulation error across lane grids.
      expect(Number.isInteger(Math.log2(m))).toBe(true);
    }
  });
});

describe('clip-clock: coerceRateIndex', () => {
  it('passes valid indices through (rounded)', () => {
    expect(coerceRateIndex(0)).toBe(0);
    expect(coerceRateIndex(5)).toBe(5);
    expect(coerceRateIndex(2.4)).toBe(2);
  });
  it('clamps out-of-range and falls back on garbage', () => {
    expect(coerceRateIndex(-3)).toBe(0);
    expect(coerceRateIndex(99)).toBe(RATE_MULTS.length - 1);
    expect(coerceRateIndex(undefined)).toBe(RATE_DEFAULT_INDEX);
    expect(coerceRateIndex('2x')).toBe(RATE_DEFAULT_INDEX);
    expect(coerceRateIndex(NaN)).toBe(RATE_DEFAULT_INDEX);
    expect(coerceRateIndex(null)).toBe(RATE_DEFAULT_INDEX);
  });
});

describe('clip-clock: laneRateIndex (persisted data → index)', () => {
  it('reads the per-lane entry from data.rate', () => {
    expect(laneRateIndex({ rate: [2, 3, 4] }, 0)).toBe(2);
    expect(laneRateIndex({ rate: [2, 3, 4] }, 2)).toBe(4);
  });
  it('defaults when data / array / entry is missing or corrupt', () => {
    expect(laneRateIndex(undefined, 0)).toBe(RATE_DEFAULT_INDEX);
    expect(laneRateIndex({}, 0)).toBe(RATE_DEFAULT_INDEX);
    expect(laneRateIndex({ rate: 'nope' }, 0)).toBe(RATE_DEFAULT_INDEX);
    expect(laneRateIndex({ rate: [1] }, 5)).toBe(RATE_DEFAULT_INDEX); // short array
    expect(laneRateIndex({ rate: [null, 42] as unknown[] }, 0)).toBe(RATE_DEFAULT_INDEX);
    expect(laneRateIndex({ rate: [null, 42] as unknown[] }, 1)).toBe(RATE_MULTS.length - 1);
  });
});

describe('clip-clock: laneStepDur', () => {
  it('divides slow the lane (longer step), mults speed it up (shorter step)', () => {
    const base = 0.25;
    expect(laneStepDur(base, 2)).toBe(0.5); // 1/2 → every 2nd base step
    expect(laneStepDur(base, 0)).toBe(2); // 1/8 → every 8th base step
    expect(laneStepDur(base, 3)).toBe(0.25); // 1 → the base grid
    expect(laneStepDur(base, 4)).toBe(0.125); // 2x
    expect(laneStepDur(base, 5)).toBe(0.0625); // 4x
  });
  it('coerces a bad index to the default (1)', () => {
    expect(laneStepDur(0.25, 99)).toBe(0.25 / 4); // clamped to 4x (last)
    expect(laneStepDur(0.25, NaN)).toBe(0.25); // garbage → '1'
  });
});

describe('clip-clock: clipDivIndex (per-clip div OVERRIDES lane rate)', () => {
  it("a clip's own div wins over the lane rate (clamped)", () => {
    // lane rate = 0 (1/8); clip.div = 4 (2x) → the clip's div is used, not the lane's.
    expect(clipDivIndex({ div: 4 }, { rate: [0, 0, 0] }, 0)).toBe(4);
    expect(clipDivIndex({ div: 2.6 }, { rate: [0] }, 0)).toBe(3); // rounds
    expect(clipDivIndex({ div: 99 }, { rate: [0] }, 0)).toBe(RATE_MULTS.length - 1); // clamps high
    expect(clipDivIndex({ div: -5 }, { rate: [0] }, 0)).toBe(0); // clamps low
  });
  it('no div ⇒ falls back to the per-lane rate (existing behavior)', () => {
    expect(clipDivIndex({}, { rate: [1, 5] }, 0)).toBe(1);
    expect(clipDivIndex({}, { rate: [1, 5] }, 1)).toBe(5);
    expect(clipDivIndex(null, { rate: [2] }, 0)).toBe(2);
    expect(clipDivIndex(undefined, { rate: [2] }, 0)).toBe(2);
    // non-numeric div is ignored → lane rate
    expect(clipDivIndex({ div: NaN }, { rate: [1] }, 0)).toBe(1);
  });
  it('no div AND no lane rate ⇒ the default (1)', () => {
    expect(clipDivIndex({}, {}, 0)).toBe(RATE_DEFAULT_INDEX);
    expect(clipDivIndex(null, undefined, 0)).toBe(RATE_DEFAULT_INDEX);
  });
});
