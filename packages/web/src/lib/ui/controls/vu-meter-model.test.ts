import { describe, it, expect } from 'vitest';
import {
  dbfsToUnit,
  isSegmentLit,
  litCount,
  segmentColor,
  VU_DB_FLOOR,
  VU_COLOR_AMBER,
  VU_COLOR_YELLOW,
  VU_COLOR_TEAL,
} from './vu-meter-model';

describe('dbfsToUnit', () => {
  it('pins the endpoints', () => {
    expect(dbfsToUnit(0)).toBe(1);
    expect(dbfsToUnit(VU_DB_FLOOR)).toBe(0);
    expect(dbfsToUnit(VU_DB_FLOOR - 10)).toBe(0); // below floor clamps to 0
    expect(dbfsToUnit(6)).toBe(1); // above 0 dBFS clamps to 1 (clipping)
  });
  it('is linear-in-dB between floor and 0', () => {
    // Halfway in dB → 0.5.
    expect(dbfsToUnit(VU_DB_FLOOR / 2)).toBeCloseTo(0.5, 6);
    expect(dbfsToUnit(-15, -60)).toBeCloseTo(0.75, 6);
  });
  it('handles non-finite', () => {
    expect(dbfsToUnit(-Infinity)).toBe(0);
    expect(dbfsToUnit(Infinity)).toBe(1);
    expect(dbfsToUnit(NaN)).toBe(0);
  });
});

describe('litCount / isSegmentLit', () => {
  it('lights none at silence and all at full', () => {
    expect(litCount(0, 12)).toBe(0);
    expect(litCount(1, 12)).toBe(12);
    expect(litCount(1.5, 12)).toBe(12); // clamps
    expect(litCount(-0.2, 12)).toBe(0);
  });
  it('lights bottom-up proportionally', () => {
    expect(litCount(0.5, 12)).toBe(6);
    expect(litCount(0.25, 12)).toBe(3);
    // a tiny signal still lights the bottom segment
    expect(litCount(0.01, 12)).toBe(1);
  });
  it('isSegmentLit agrees with litCount (bottom-up)', () => {
    const segs = 12;
    for (const level of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
      const n = litCount(level, segs);
      for (let i = 0; i < segs; i++) {
        expect(isSegmentLit(i, level, segs)).toBe(i < n);
      }
    }
  });
  it('rejects out-of-range indices', () => {
    expect(isSegmentLit(-1, 1, 12)).toBe(false);
    expect(isSegmentLit(12, 1, 12)).toBe(false);
    expect(isSegmentLit(0, 1, 0)).toBe(false);
  });
});

describe('segmentColor', () => {
  it('is warm at the top, cool below', () => {
    const segs = 12;
    // top segment (index 11) is amber (peak zone)
    expect(segmentColor(11, segs)).toBe(VU_COLOR_AMBER);
    // just under → yellow
    expect(segmentColor(9, segs)).toBe(VU_COLOR_YELLOW);
    // bottom → teal-green
    expect(segmentColor(0, segs)).toBe(VU_COLOR_TEAL);
    expect(segmentColor(4, segs)).toBe(VU_COLOR_TEAL);
  });
  it('never returns cool above warm (monotone zones by fraction)', () => {
    const segs = 20;
    const rank = (c: string) =>
      c === VU_COLOR_TEAL ? 0 : c === VU_COLOR_YELLOW ? 1 : 2;
    let prev = -1;
    for (let i = 0; i < segs; i++) {
      const r = rank(segmentColor(i, segs));
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
  it('single-segment meter is amber (treated as top)', () => {
    expect(segmentColor(0, 1)).toBe(VU_COLOR_AMBER);
  });
});
