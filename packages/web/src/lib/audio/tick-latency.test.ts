// packages/web/src/lib/audio/tick-latency.test.ts
//
// THE PERMANENT NEGATIVE CONTROL for the scheduler tick-latency histogram.
//
// Both directions run on every unit lane:
//   (a) FORCED — a synthetic 200 ms main-thread block must SHOW UP: max climbs,
//       the 100–250 ms bucket fills, `overBudget` rises, and the drain burst is
//       counted. If the recorder were stubbed this leg goes red.
//   (b) CLEAN — a perfect 25 ms cadence must read EXACTLY zero lateness. Not
//       "small", not "under a threshold": exactly 0, so the separation is not a
//       ratio over a noise floor. Without this leg, (a) could be satisfied by a
//       recorder that reports lateness unconditionally.
//   (c) DISCRIMINATION — "main thread blocked" and "tick source slowed" produce
//       DIFFERENT readings. A p99 number alone conflates them, and conflating
//       them is the whole reason this instrument exists.
//
// Timestamps are passed in, so there is no wall-clock time in this file and no
// timer to flake on. UNITS ARE MILLISECONDS throughout — stated in every
// assertion message (see `tick-latency.ts` for why ms, not frames, is correct
// for a main-thread scheduling quantity).

import { describe, it, expect } from 'vitest';
import {
  createTickLatencyRecorder,
  formatTickLatency,
  TICK_LATENESS_EDGES_MS,
} from './tick-latency';

const TICK = 25;

/** Feed `n` arrivals at a perfect cadence starting at `t0`. Returns next t. */
function feedClean(r: ReturnType<typeof createTickLatencyRecorder>, n: number, t0 = 1000): number {
  let t = t0;
  for (let i = 0; i < n; i++) {
    r.arrive(t);
    r.dispatched(0.2);
    t += TICK;
  }
  return t;
}

/** The index of the bucket whose lower edge is exactly `edgeMs`. */
function bucketIndex(edgeMs: number): number {
  const i = TICK_LATENESS_EDGES_MS.indexOf(edgeMs as never);
  if (i < 0) throw new Error(`no bucket edge ${edgeMs}ms`);
  return i;
}

describe('tick-latency — (b) CLEAN: a perfect cadence reads EXACTLY zero', () => {
  it('40 arrivals at exactly 25ms produce zero lateness, zero drain, zero over-budget', () => {
    const r = createTickLatencyRecorder(TICK);
    feedClean(r, 40);
    const s = r.stats();
    expect(s.samples, 'samples (arrivals after the first)').toBe(39);
    expect(s.maxMs, 'max lateness (MILLISECONDS) must be exactly 0').toBe(0);
    expect(s.p99Ms, 'p99 lateness (MILLISECONDS) must be exactly 0').toBe(0);
    expect(s.p50Ms, 'p50 lateness (MILLISECONDS) must be exactly 0').toBe(0);
    expect(s.overBudget, 'arrivals late by a whole tick').toBe(0);
    expect(s.drained, 'queue-drain arrivals').toBe(0);
    // Everything landed in bucket 0 and nowhere else.
    expect(s.buckets[0]).toBe(39);
    expect(s.buckets.slice(1).reduce((a, b) => a + b, 0), 'any non-zero bucket').toBe(0);
    expect(s.elapsedMs, 'span (MILLISECONDS)').toBe(39 * TICK);
    expect(s.tickMs, 'the cadence under test (MILLISECONDS)').toBe(TICK);
  });

  it('the first arrival is excluded — no predecessor means no cadence', () => {
    const r = createTickLatencyRecorder(TICK);
    r.arrive(5000);
    expect(r.stats().samples).toBe(0);
    expect(formatTickLatency(r.stats())).toBe('—');
  });
});

describe('tick-latency — (a) FORCED: a 200ms main-thread block SHOWS UP', () => {
  it('the stall is bucketed, counted over-budget, and the drain burst is counted', () => {
    const r = createTickLatencyRecorder(TICK);
    let t = feedClean(r, 20);

    // The main thread blocks for 200 ms starting right after the previous
    // tick. The worker keeps posting; 8 ticks queue. The next arrival lands
    // 225 ms after its predecessor (one whole tick period plus the 200 ms
    // block) = +200 ms lateness, then the queue drains in a burst ~0 ms apart.
    t += 200;
    r.arrive(t);
    r.dispatched(1.0);
    for (let i = 0; i < 7; i++) {
      t += 0.1;
      r.arrive(t);
      r.dispatched(0.2);
    }

    const s = r.stats();
    expect(s.maxMs, 'max lateness (MILLISECONDS) after a 200ms block').toBeCloseTo(200, 5);
    expect(s.overBudget, 'arrivals late by a whole 25ms tick').toBe(1);
    expect(
      s.buckets[bucketIndex(100)],
      'the 100–250ms lateness bucket must hold the stall',
    ).toBe(1);
    expect(s.drained, 'the 7 queued ticks draining in a burst').toBe(7);
    expect(formatTickLatency(s)).toMatch(/max 200ms/);
  });

  it('the recorder is NOT invariant to the stall — same sample count, different reading', () => {
    // The instrument negative control: an identical number of arrivals with no
    // stall must read differently. A recorder blind to lateness would return
    // the same clean numbers for both and every other leg would still pass.
    const stalled = createTickLatencyRecorder(TICK);
    let t = feedClean(stalled, 20);
    t += 200;
    stalled.arrive(t);
    for (let i = 0; i < 7; i++) {
      t += 0.1;
      stalled.arrive(t);
    }

    const clean = createTickLatencyRecorder(TICK);
    feedClean(clean, 28);

    expect(clean.stats().samples).toBe(27);
    expect(stalled.stats().samples).toBe(27);
    expect(
      stalled.stats().maxMs,
      'a recorder blind to lateness would report the same max for both',
    ).toBeGreaterThan(clean.stats().maxMs + 100);
  });

  it('a stall spanning the whole ring still reports its max (max is not ring-limited)', () => {
    const r = createTickLatencyRecorder(TICK);
    let t = feedClean(r, 5);
    t += 900;
    r.arrive(t); // lateness 900 ms (900 on top of the tick period already added)
    feedClean(r, 400, t + TICK); // push it well out of the 256-sample ring
    const s = r.stats();
    expect(s.maxMs, 'worst-ever lateness (MILLISECONDS) survives ring eviction').toBeCloseTo(
      900,
      5,
    );
    expect(s.p99Ms, 'the RING percentile has legitimately forgotten it').toBe(0);
  });
});

describe('tick-latency — (c) the two diagnoses are DISTINGUISHABLE', () => {
  it('blocked main thread → late arrivals WITH a drain burst', () => {
    const r = createTickLatencyRecorder(TICK);
    let t = feedClean(r, 10);
    t += 150;
    r.arrive(t);
    for (let i = 0; i < 5; i++) {
      t += 0.1;
      r.arrive(t);
    }
    const s = r.stats();
    expect(s.overBudget, 'late arrivals').toBeGreaterThan(0);
    expect(s.drained, 'the drain burst is the main-thread-block signature').toBe(5);
  });

  it('slowed tick SOURCE → late arrivals with NO drain burst', () => {
    // Background-tab throttling: the worker itself posts at 100 ms. Every
    // arrival is late; nothing ever queues, so nothing ever drains.
    const r = createTickLatencyRecorder(TICK);
    let t = 1000;
    for (let i = 0; i < 20; i++) {
      r.arrive(t);
      t += 100;
    }
    const s = r.stats();
    expect(s.overBudget, 'every arrival is a whole tick late').toBe(19);
    expect(s.p50Ms, 'sustained lateness (MILLISECONDS)').toBeCloseTo(75, 5);
    expect(
      s.drained,
      'NO drain burst — this is a slow tick source, not a blocked main thread',
    ).toBe(0);
  });
});

describe('tick-latency — dispatch cost is measured separately from lateness', () => {
  it('expensive subscriber callbacks show up in dispatch, not in lateness', () => {
    // "The main thread was busy with someone else's work" vs "OUR tick work is
    // the expensive thing" need opposite fixes. A lateness-only instrument
    // cannot tell them apart.
    const r = createTickLatencyRecorder(TICK);
    let t = 1000;
    for (let i = 0; i < 30; i++) {
      r.arrive(t);
      r.dispatched(i === 15 ? 18 : 0.3);
      t += TICK;
    }
    const s = r.stats();
    expect(s.maxMs, 'lateness (MILLISECONDS) — the cadence was never disturbed').toBe(0);
    expect(s.dispatchMaxMs, 'dispatch cost (MILLISECONDS)').toBe(18);
    expect(s.dispatchP99Ms, 'dispatch p99 (MILLISECONDS)').toBeGreaterThan(1);
  });

  it('a negative or non-finite dispatch duration is ignored, not recorded', () => {
    const r = createTickLatencyRecorder(TICK);
    feedClean(r, 3);
    r.dispatched(-5);
    r.dispatched(Number.NaN);
    expect(r.stats().dispatchMaxMs).toBe(0.2);
  });
});

describe('tick-latency — reset clears every accumulator', () => {
  it('reset() returns the recorder to its initial reading', () => {
    const r = createTickLatencyRecorder(TICK);
    let t = feedClean(r, 10);
    t += 300;
    r.arrive(t);
    r.dispatched(9);
    expect(r.stats().maxMs).toBeGreaterThan(0);

    r.reset();
    const s = r.stats();
    expect(s.samples).toBe(0);
    expect(s.maxMs).toBe(0);
    expect(s.drained).toBe(0);
    expect(s.overBudget).toBe(0);
    expect(s.dispatchMaxMs).toBe(0);
    expect(s.elapsedMs).toBe(0);
    expect(s.buckets.reduce((a, b) => a + b, 0)).toBe(0);
  });
});
