// packages/web/src/lib/audio/dx7-eg-curve.test.ts
//
// Three facts here were WRONG in the first draft of the DX7 program and are
// each easy to reintroduce, so each gets an assertion that names the wrong
// answer as well as the right one:
//   - rate 0 is 317.487 s, NOT 90 s (the 90 was ~90 dB — a units confusion);
//   - the hold is a FROZEN segment 3 drawn as the L3 plateau PRECEDING the
//     release, not a distinct fourth segment;
//   - X is RAW RATE width, never seconds.

import { describe, it, expect } from 'vitest';
import {
  DX7_EG_HOLD_WIDTH,
  dx7EgCurve,
  dx7EgSegmentSeconds,
  dx7RateToWidth,
  dx7WidthToRate,
} from './dx7-eg-curve';
import {
  DX7_EG_ATTACK_SPEEDUP,
  DX7_EG_RATE0_FULL_SCALE_S,
  dx7EgTick,
  dx7LevelToDb,
  dx7RateToDbPerSec,
} from './dx7-syx';

describe('dx7EgCurve — the corrected model', () => {
  it('OPENS and CLOSES at L4 — the envelope idles where the release lands', () => {
    const c = dx7EgCurve([99, 50, 40, 60], [99, 80, 60, 12], 99);
    expect(c.points[0]!.kind).toBe('start');
    expect(c.points[0]!.level).toBe(12); // L4
    expect(c.points[0]!.x).toBe(0);
    const last = c.points[c.points.length - 1]!;
    expect(last.kind).toBe('release');
    expect(last.level).toBe(12); // L4 again
    // NOT zero. A curve that starts at 0 is the pre-0b engine, not the DX7.
    expect(c.points[0]!.level).not.toBe(0);
  });

  it('draws the hold as the L3 PLATEAU PRECEDING the release (a frozen segment 3)', () => {
    const c = dx7EgCurve([99, 60, 50, 40], [99, 80, 55, 5], 99);
    const l3Point = c.points[3]!;
    const hold = c.points[4]!;
    expect(l3Point.level).toBe(55);
    expect(hold.kind).toBe('hold');
    // Same LEVEL as the point before it — a horizontal run, not a new segment.
    expect(hold.level).toBe(l3Point.level);
    expect(hold.y).toBe(l3Point.y);
    expect(hold.x).toBeCloseTo(l3Point.x + DX7_EG_HOLD_WIDTH, 12);
    // It sits BEFORE the release, and the release is the only thing after it.
    expect(c.points[5]!.kind).toBe('release');
    expect(c.points[5]!.x).toBeGreaterThan(hold.x);
    // The plateau has NO rate and NO level of its own: only four of the six
    // points are draggable, indices 0..3 for the R1/L1..R4/L4 pairs.
    expect(c.points.map((p) => p.index)).toEqual([-1, 0, 1, 2, -1, 3]);
    expect(c.segmentWidths).toHaveLength(4);
    expect(c.segmentTimes).toHaveLength(4);
  });

  it('rate 0 is 317.487 s for a full-scale fall — NOT 90 s', () => {
    // 90 was Dexed's ~90 dB internal span read as seconds.
    const t = dx7EgSegmentSeconds(99, 0, 0);
    expect(t).toBeCloseTo(DX7_EG_RATE0_FULL_SCALE_S, 3);
    expect(t).toBeCloseTo(317.487, 3);
    expect(Math.abs(t - 90)).toBeGreaterThan(200);
  });

  it('an ATTACK is 8.01x faster than a DECAY at the same rate byte (hexter\'s measured ratio)', () => {
    for (const rate of [5, 20, 40, 60, 80, 99]) {
      const fall = dx7EgSegmentSeconds(99, 0, rate);
      const rise = dx7EgSegmentSeconds(0, 99, rate);
      expect(fall / rise, `rate ${rate}`).toBeCloseTo(DX7_EG_ATTACK_SPEEDUP, 2);
    }
  });
});

describe('dx7EgCurve — the X axis is RAW RATE, never seconds', () => {
  it('maps rate to width as (99 - rate) / 99, so 99 is a hairline and 0 is full width', () => {
    expect(dx7RateToWidth(99)).toBe(0);
    expect(dx7RateToWidth(0)).toBe(1);
    expect(dx7RateToWidth(50)).toBeCloseTo(49 / 99, 12);
  });

  it('round-trips a drag back to the stored byte for every rate 0..99 — LOSSLESS', () => {
    // This is why the axis is raw rate: a log-seconds axis makes this lossy,
    // and the stored byte would drift every time the point was touched.
    for (let r = 0; r <= 99; r++) expect(dx7WidthToRate(dx7RateToWidth(r))).toBe(r);
  });

  it('places each point at the CUMULATIVE width of the segments before it', () => {
    const r: [number, number, number, number] = [99, 50, 0, 75];
    const c = dx7EgCurve(r, [99, 80, 60, 0], 99);
    const w = r.map(dx7RateToWidth);
    expect(c.segmentWidths).toEqual(w);
    expect(c.points[1]!.x).toBeCloseTo(w[0]!, 12);
    expect(c.points[2]!.x).toBeCloseTo(w[0]! + w[1]!, 12);
    expect(c.points[3]!.x).toBeCloseTo(w[0]! + w[1]! + w[2]!, 12);
    expect(c.points[4]!.x).toBeCloseTo(w[0]! + w[1]! + w[2]! + DX7_EG_HOLD_WIDTH, 12);
    expect(c.width).toBeCloseTo(w[0]! + w[1]! + w[2]! + DX7_EG_HOLD_WIDTH + w[3]!, 12);
    expect(c.points.every((p) => p.x <= c.width + 1e-12)).toBe(true);
    // X is monotonic — a polyline can never fold back on itself.
    for (let i = 1; i < c.points.length; i++) {
      expect(c.points[i]!.x).toBeGreaterThanOrEqual(c.points[i - 1]!.x);
    }
  });

  it('X is NOT proportional to seconds — the reason a seconds axis is unusable', () => {
    // rate 0 vs rate 40: ~80x in TIME, but only ~1.7x in drawn WIDTH.
    const tRatio = dx7EgSegmentSeconds(99, 0, 0) / dx7EgSegmentSeconds(99, 0, 40);
    const wRatio = dx7RateToWidth(0) / dx7RateToWidth(40);
    expect(tRatio).toBeGreaterThan(50);
    expect(wRatio).toBeLessThan(2);
  });
});

describe('dx7EgCurve — Y, and the output-level scaling', () => {
  it('Y is LEVEL / 99, scaled by the operator OUTPUT LEVEL', () => {
    const full = dx7EgCurve([99, 99, 99, 99], [99, 60, 30, 0], 99);
    expect(full.points[1]!.y).toBeCloseTo(1, 12);
    expect(full.points[2]!.y).toBeCloseTo(60 / 99, 12);
    expect(full.peakY).toBeCloseTo(1, 12);

    const half = dx7EgCurve([99, 99, 99, 99], [99, 60, 30, 0], 50);
    for (let i = 0; i < full.points.length; i++) {
      expect(half.points[i]!.y).toBeCloseTo(full.points[i]!.y * (50 / 99), 12);
      // LEVEL itself is untouched — the scaling is a drawing concern only.
      expect(half.points[i]!.level).toBe(full.points[i]!.level);
    }
    const off = dx7EgCurve([99, 99, 99, 99], [99, 60, 30, 0], 0);
    expect(off.peakY).toBe(0);
  });

  it('defaults to the unscaled shape', () => {
    expect(dx7EgCurve([99, 50, 40, 60], [99, 80, 60, 0])).toEqual(
      dx7EgCurve([99, 50, 40, 60], [99, 80, 60, 0], 99),
    );
  });
});

describe('dx7EgSegmentSeconds — validated against the engine\'s own integrator', () => {
  // NEGATIVE CONTROL ON THE INSTRUMENT. The closed form here and dx7EgTick's
  // step-by-step integration are two independent computations of the same
  // physical quantity; if the closed form were wrong (a stray DB_PER_OCTAVE,
  // the attack jump forgotten) it would still return a confident number.
  // Integrating the real tick function is the only way to catch that.
  function integrate(fromLevel: number, toLevel: number, rate: number): number {
    const dt = 1 / 48000;
    const levelsDb = [dx7LevelToDb(toLevel), 0, 0, 0];
    const ratesDbPerSec = [dx7RateToDbPerSec(rate), 0, 0, 0];
    const envDb = new Float64Array(1);
    const envSeg = new Int32Array(1);
    envDb[0] = dx7LevelToDb(fromLevel);
    let n = 0;
    const cap = 48000 * 400; // 400 s of audio — bounds the failure, not the gate
    while (envSeg[0] === 0 && n < cap) {
      dx7EgTick(envDb, envSeg, 0, levelsDb, ratesDbPerSec, false, dt);
      n++;
    }
    return n * dt;
  }

  it('matches a real dx7EgTick integration for falling segments', () => {
    for (const [from, to, rate] of [[99, 0, 40], [99, 50, 60], [80, 20, 55], [99, 0, 30]] as const) {
      const closed = dx7EgSegmentSeconds(from, to, rate);
      const stepped = integrate(from, to, rate);
      expect(Math.abs(closed - stepped) / stepped, `fall ${from}->${to} @${rate}`).toBeLessThan(0.01);
    }
  });

  it('matches a real dx7EgTick integration for rising (attack) segments', () => {
    for (const [from, to, rate] of [[0, 99, 40], [0, 99, 60], [20, 80, 50], [0, 99, 25]] as const) {
      const closed = dx7EgSegmentSeconds(from, to, rate);
      const stepped = integrate(from, to, rate);
      expect(Math.abs(closed - stepped) / stepped, `rise ${from}->${to} @${rate}`).toBeLessThan(0.01);
    }
  });

  it('a segment already at its target takes no time', () => {
    expect(dx7EgSegmentSeconds(60, 60, 50)).toBe(0);
  });

  it('the four segment times start from L4, matching the idle level', () => {
    // Segment 1 travels from L4 (the idle) to L1 — not from zero.
    const c = dx7EgCurve([40, 50, 60, 70], [99, 80, 55, 20], 99);
    expect(c.segmentTimes[0]).toBeCloseTo(dx7EgSegmentSeconds(20, 99, 40), 9);
    expect(c.segmentTimes[1]).toBeCloseTo(dx7EgSegmentSeconds(99, 80, 50), 9);
    expect(c.segmentTimes[2]).toBeCloseTo(dx7EgSegmentSeconds(80, 55, 60), 9);
    expect(c.segmentTimes[3]).toBeCloseTo(dx7EgSegmentSeconds(55, 20, 70), 9);
  });
});

describe('dx7EgCurve — tolerant of a half-written voice off the Y.Doc', () => {
  it('short, missing and out-of-range arrays clamp instead of producing NaN', () => {
    for (const c of [
      dx7EgCurve([], [], 99),
      dx7EgCurve([99], [50], 99),
      dx7EgCurve([-5, 200, NaN, 50], [-1, 400, NaN, 10], 500),
      dx7EgCurve([1, 2, 3, 4], [5, 6, 7, 8], NaN),
    ]) {
      expect(c.points).toHaveLength(6);
      for (const p of c.points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
        expect(p.level).toBeGreaterThanOrEqual(0);
        expect(p.level).toBeLessThanOrEqual(99);
      }
      expect(c.segmentTimes.every((t) => t >= 0)).toBe(true);
    }
  });
});
