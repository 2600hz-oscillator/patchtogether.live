// packages/web/src/lib/audio/cv-buddy/clock-math.test.ts
//
// PURE unit coverage for CV Buddy's generated-clock scheduling math.
// (Flake-check REPEAT=3 pre-MR per CLAUDE.md.)

import { describe, it, expect } from 'vitest';
import { pulsePeriodS, pulseTimes, CLOCK_PULSE_HIGH_S } from './clock-math';

describe('pulsePeriodS', () => {
  it('120 BPM @ 24 PPQN → 60/120/24 s', () => {
    expect(pulsePeriodS(120, 24)).toBeCloseTo(60 / 120 / 24, 12); // ~20.833 ms
  });
  it('scales inversely with BPM and PPQN', () => {
    expect(pulsePeriodS(60, 1)).toBeCloseTo(1, 12); // 1 pulse/sec
    expect(pulsePeriodS(120, 1)).toBeCloseTo(0.5, 12);
    expect(pulsePeriodS(120, 48)).toBeCloseTo(0.5 / 48, 12);
  });
  it('returns Infinity for degenerate tempo', () => {
    expect(pulsePeriodS(0, 24)).toBe(Infinity);
    expect(pulsePeriodS(120, 0)).toBe(Infinity);
    expect(pulsePeriodS(-1, 24)).toBe(Infinity);
    expect(pulsePeriodS(NaN, 24)).toBe(Infinity);
  });
});

describe('pulseTimes', () => {
  it('places pulses on the k·period grid inside the window', () => {
    // 60 BPM @ 1 PPQN → period 1 s. Window [0, 3) → pulses at 0, 1, 2.
    expect(pulseTimes(60, 1, 0, 0, 3)).toEqual([0, 1, 2]);
  });

  it('half-open window: winEnd is exclusive, winStart inclusive', () => {
    // period 1 s, window [1, 3) → 1, 2 (not 3).
    expect(pulseTimes(60, 1, 0, 1, 3)).toEqual([1, 2]);
  });

  it('is phase-stable across contiguous windows (no drift, no double-count)', () => {
    const a = pulseTimes(120, 4, 0, 0, 1); // period 0.125s
    const b = pulseTimes(120, 4, 0, 1, 2);
    const merged = [...a, ...b];
    // No duplicate edges at the window seam; strictly ascending.
    for (let i = 1; i < merged.length; i++) expect(merged[i]).toBeGreaterThan(merged[i - 1]);
    // Union equals a single [0,2) query.
    expect(merged).toEqual(pulseTimes(120, 4, 0, 0, 2));
  });

  it('applies the ± offset to each edge and filters on the SHIFTED time', () => {
    // period 1s, +100ms offset → grid edges at 0.1, 1.1, 2.1.
    expect(pulseTimes(60, 1, 100, 0, 3)).toEqual([0.1, 1.1, 2.1]);
    // A negative offset shifts the grid earlier: edges at -0.1, 0.9, 1.9… — in
    // the window [0,1) only 0.9 lands (-0.1 is before winStart, filtered out).
    expect(pulseTimes(60, 1, -100, 0, 1)).toEqual([0.9]);
    // Widen the window to [0,2) and 1.9 also lands.
    expect(pulseTimes(60, 1, -100, 0, 2)).toEqual([0.9, 1.9]);
  });

  it('returns [] for a backwards/empty window or degenerate tempo', () => {
    expect(pulseTimes(60, 1, 0, 3, 3)).toEqual([]);
    expect(pulseTimes(60, 1, 0, 3, 1)).toEqual([]);
    expect(pulseTimes(0, 24, 0, 0, 10)).toEqual([]);
  });

  it('a realistic lookahead window yields the expected pulse count', () => {
    // 120 BPM @ 24 PPQN, period ~20.83ms, 200ms window → ~9-10 pulses.
    const times = pulseTimes(120, 24, 0, 0, 0.2);
    expect(times.length).toBeGreaterThanOrEqual(9);
    expect(times.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });
});

describe('CLOCK_PULSE_HIGH_S', () => {
  it('is a short ~5 ms gate pulse', () => {
    expect(CLOCK_PULSE_HIGH_S).toBeCloseTo(0.005, 6);
  });
});
