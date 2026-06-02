// packages/web/src/lib/snes9x/clock-multiplier.test.ts
//
// Pure unit tests for the gate3 clock multiplier. Drives the state machine
// with synthetic rising-edge timestamps and asserts the output pulse count
// + spacing for various N (= world+level), plus the documented edge cases.

import { describe, it, expect } from 'vitest';
import {
  makeClockMultiplierState,
  onClockEdge,
  advance,
  sanitizeMultiplier,
  MAX_MULTIPLIER,
} from './clock-multiplier';

describe('sanitizeMultiplier', () => {
  it('N<=1 → 1 (passthrough)', () => {
    expect(sanitizeMultiplier(0)).toBe(1);
    expect(sanitizeMultiplier(1)).toBe(1);
    expect(sanitizeMultiplier(-3)).toBe(1);
    expect(sanitizeMultiplier(NaN)).toBe(1);
  });
  it('floors fractional N', () => {
    expect(sanitizeMultiplier(3.9)).toBe(3);
  });
  it('clamps to MAX_MULTIPLIER', () => {
    expect(sanitizeMultiplier(1000)).toBe(MAX_MULTIPLIER);
  });
});

describe('onClockEdge — passthrough (N=1)', () => {
  it('emits exactly one in-phase pulse per edge', () => {
    const st = makeClockMultiplierState();
    expect(onClockEdge(st, 0.0, 1)).toEqual([0.0]);
    expect(onClockEdge(st, 1.0, 1)).toEqual([1.0]);
    expect(onClockEdge(st, 2.0, 1)).toEqual([2.0]);
    expect(st.pending).toHaveLength(0);
  });

  it('treats N=0 (idle / not in level) as ×1 passthrough', () => {
    const st = makeClockMultiplierState();
    onClockEdge(st, 0.0, 0);
    const out = onClockEdge(st, 1.0, 0);
    expect(out).toEqual([1.0]);
  });
});

describe('onClockEdge — multiplication', () => {
  it('first edge ever: in-phase pulse only (no measured period yet)', () => {
    const st = makeClockMultiplierState();
    expect(onClockEdge(st, 0.0, 4)).toEqual([0.0]);
    expect(st.pending).toHaveLength(0);
  });

  it('N=4 over a 1s measured period → 4 evenly spaced pulses', () => {
    const st = makeClockMultiplierState();
    onClockEdge(st, 0.0, 4); // establishes lastEdge
    const out = onClockEdge(st, 1.0, 4); // period = 1.0 measured
    // in-phase at 1.0 + 3 subdivisions at 1.25,1.5,1.75
    expect(out).toHaveLength(4);
    expect(out[0]).toBeCloseTo(1.0, 9);
    expect(out[1]).toBeCloseTo(1.25, 9);
    expect(out[2]).toBeCloseTo(1.5, 9);
    expect(out[3]).toBeCloseTo(1.75, 9);
  });

  it('subdivisions are evenly spaced for various N', () => {
    for (const n of [2, 3, 5, 8]) {
      const st = makeClockMultiplierState();
      onClockEdge(st, 0.0, n);
      const out = onClockEdge(st, 2.0, n); // period 2.0
      expect(out).toHaveLength(n);
      const step = 2.0 / n;
      for (let i = 0; i < n; i++) {
        expect(out[i]).toBeCloseTo(2.0 + i * step, 9);
      }
    }
  });

  it('queues the non-immediate sub-pulses for advance() to drain', () => {
    const st = makeClockMultiplierState();
    onClockEdge(st, 0.0, 4);
    onClockEdge(st, 1.0, 4);
    // 3 future pulses queued (1.25, 1.5, 1.75).
    expect(st.pending).toHaveLength(3);
  });
});

describe('advance — draining scheduled sub-pulses', () => {
  it('returns due pulses up to t, ascending, removing them', () => {
    const st = makeClockMultiplierState();
    onClockEdge(st, 0.0, 4);
    onClockEdge(st, 1.0, 4); // queues 1.25, 1.5, 1.75
    expect(advance(st, 1.2)).toEqual([]); // nothing due yet
    const due1 = advance(st, 1.3);
    expect(due1).toHaveLength(1);
    expect(due1[0]).toBeCloseTo(1.25, 9);
    const due2 = advance(st, 2.0);
    expect(due2).toHaveLength(2); // 1.5 + 1.75
    expect(st.pending).toHaveLength(0);
  });

  it('no pending → empty', () => {
    const st = makeClockMultiplierState();
    expect(advance(st, 5)).toEqual([]);
  });
});

describe('end-to-end: pulse-count over a window equals N per period', () => {
  it('N=3 yields 3 pulses per period across several periods', () => {
    const st = makeClockMultiplierState();
    const N = 3;
    const period = 0.5;
    let total = 0;
    // First edge: establishes period baseline.
    total += onClockEdge(st, 0, N).length;
    // Subsequent edges each emit N (in-phase + drained subs land via advance).
    for (let k = 1; k <= 4; k++) {
      const edgeT = k * period;
      const fromEdge = onClockEdge(st, edgeT, N);
      total += fromEdge.length;
    }
    // Edge 0 emitted 1 (no period yet); edges 1..4 each emit N (3) =>
    // 1 + 4*3 = 13. (advance() would surface the SAME sub-pulses already
    // counted in fromEdge — we count edges' returns here to avoid double-
    // counting; the per-period count after warmup is exactly N.)
    expect(total).toBe(1 + 4 * N);
  });
});
