// packages/web/src/lib/video/modules/archivist-scrub.test.ts
//
// Pure-core unit tests for ARCHIVIST scrub/seek math. NO DOM.

import { describe, it, expect } from 'vitest';
import {
  clampSeek,
  skipBy,
  randomSeek,
  positionFraction,
  fractionToSeconds,
  formatTime,
  SKIP_STEP_S,
} from './archivist-scrub';

describe('clampSeek', () => {
  it('clamps into [0, duration]', () => {
    expect(clampSeek(-5, 100)).toBe(0);
    expect(clampSeek(50, 100)).toBe(50);
    expect(clampSeek(150, 100)).toBe(100);
  });
  it('only clamps the low end for an unknown duration', () => {
    expect(clampSeek(9999, 0)).toBe(9999);
    expect(clampSeek(-1, Infinity)).toBe(0);
    expect(clampSeek(42, Infinity)).toBe(42);
  });
  it('non-finite target → 0', () => {
    expect(clampSeek(NaN, 100)).toBe(0);
  });
});

describe('skipBy', () => {
  it('skips forward/back, clamped', () => {
    expect(skipBy(50, SKIP_STEP_S, 100)).toBe(60);
    expect(skipBy(5, -SKIP_STEP_S, 100)).toBe(0);
    expect(skipBy(95, SKIP_STEP_S, 100)).toBe(100);
  });
  it('treats a non-finite current as 0', () => {
    expect(skipBy(NaN, SKIP_STEP_S, 100)).toBe(SKIP_STEP_S);
  });
});

describe('randomSeek', () => {
  it('is deterministic with an injected RNG + biased off the very end', () => {
    expect(randomSeek(100, () => 0)).toBe(0);
    expect(randomSeek(100, () => 0.5)).toBe(49); // 0.5 * 100 * 0.98
    expect(randomSeek(100, () => 1)).toBeCloseTo(98, 5); // clamped to 0.98*dur
  });
  it('returns 0 for zero / unknown duration', () => {
    expect(randomSeek(0, () => 0.5)).toBe(0);
    expect(randomSeek(Infinity, () => 0.5)).toBe(0);
  });
  it('never exceeds duration', () => {
    for (let r = 0; r <= 1; r += 0.1) {
      expect(randomSeek(33, () => r)).toBeLessThanOrEqual(33);
    }
  });
});

describe('positionFraction / fractionToSeconds (round-trip)', () => {
  it('maps position↔fraction', () => {
    expect(positionFraction(50, 100)).toBe(0.5);
    expect(positionFraction(0, 100)).toBe(0);
    expect(positionFraction(100, 100)).toBe(1);
  });
  it('clamps fraction at 1 and 0', () => {
    expect(positionFraction(150, 100)).toBe(1);
    expect(positionFraction(-5, 100)).toBe(0);
  });
  it('0 for zero / unknown duration', () => {
    expect(positionFraction(50, 0)).toBe(0);
    expect(positionFraction(50, Infinity)).toBe(0);
  });
  it('fractionToSeconds inverts positionFraction', () => {
    expect(fractionToSeconds(0.5, 100)).toBe(50);
    expect(fractionToSeconds(1.5, 100)).toBe(100); // clamped
    expect(fractionToSeconds(-1, 100)).toBe(0);
    expect(fractionToSeconds(0.25, 0)).toBe(0);
  });
});

describe('formatTime', () => {
  it('formats mm:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(600)).toBe('10:00');
  });
  it('non-finite / negative → 0:00', () => {
    expect(formatTime(NaN)).toBe('0:00');
    expect(formatTime(-3)).toBe('0:00');
    expect(formatTime(Infinity)).toBe('0:00');
  });
});
