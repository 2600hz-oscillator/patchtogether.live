// packages/web/src/lib/video/render-cost.test.ts
//
// The instrument's own gate. CLAUDE.md §VALIDATE THE INSTRUMENT: "perturb the
// thing it claims to measure and confirm the number moves" — and do it in BOTH
// directions, because a probe that can only go up is satisfied by a counter
// that never comes down.
//
// Everything here is driven by explicit timestamps, so there is no wall-clock
// sleep and no flake surface.

import { describe, it, expect } from 'vitest';
import { createRenderCostRecorder, formatRenderCost } from './render-cost';

describe('render-cost recorder', () => {
  it('NEGATIVE CONTROL both ways: 0 calls and a real cost are distinguishable', () => {
    const r = createRenderCostRecorder('engine.step');

    // Direction 1 — nothing recorded. Every percentile is 0, and `calls`/
    // `samples` say WHY it is 0. This leg is the one that matters: a p99 of 0
    // from "cheap" and a p99 of 0 from "never ran" are the same number, and
    // reading them as the same fact is the documented failure mode.
    const idle = r.stats();
    expect(idle.calls, 'calls (spans)').toBe(0);
    expect(idle.samples, 'samples (spans in the percentile ring)').toBe(0);
    expect(idle.p99Ms, 'p99 (ms)').toBe(0);
    expect(formatRenderCost(idle)).toContain('never ran');

    // Direction 2 — a real cost moves every field.
    r.record(4, 1000);
    r.record(12, 1016);
    const busy = r.stats();
    expect(busy.calls, 'calls (spans)').toBe(2);
    expect(busy.totalMs, 'totalMs (ms of main-thread CPU)').toBe(16);
    expect(busy.maxMs, 'maxMs (ms)').toBe(12);
    expect(busy.elapsedMs, 'elapsedMs (ms of wall clock)').toBe(16);
    expect(formatRenderCost(busy)).toContain('ms');
  });

  it('p99 tracks the SLOW tail, not the mean — sustained 200ms blocks are visible', () => {
    const r = createRenderCostRecorder('blit');
    // 253 cheap frames and three 200 ms blocks: a MEAN would report ~2.7 ms and
    // hide them entirely. The whole point of the instrument is that they show.
    //
    // Three and not one, deliberately: the percentile is EXACT over the ring,
    // so with a full 256-sample window the p99 is the 3rd-worst span, and a
    // lone outlier is a p100 event that `maxMs` reports and `p99Ms` correctly
    // does not. Asserting both here pins that distinction rather than leaving
    // a future reader to discover it from a surprising number.
    for (let i = 0; i < 253; i++) r.record(0.4, 1000 + i * 16);
    for (let i = 0; i < 3; i++) r.record(200, 1000 + (253 + i) * 16);
    const s = r.stats();
    expect(s.samples, 'samples — a full ring').toBe(256);
    expect(s.p50Ms, 'p50 (ms)').toBeCloseTo(0.4, 5);
    expect(s.p99Ms, 'p99 (ms) — the 200ms blocks must survive summarisation').toBe(200);
    expect(s.maxMs, 'maxMs (ms)').toBe(200);
  });

  it('a LONE outlier is maxMs, not p99 — the exact-percentile contract, stated', () => {
    const r = createRenderCostRecorder('blit');
    for (let i = 0; i < 253; i++) r.record(0.4, 1000 + i * 16);
    r.record(200, 1000 + 253 * 16);
    const s = r.stats();
    expect(s.p99Ms, 'p99 (ms) — one span in 254 is above the 99th percentile').toBeCloseTo(0.4, 5);
    expect(s.maxMs, 'maxMs (ms) — which is why max is reported alongside p99').toBe(200);
  });

  it('reset() gives a caller a DEFINED measurement window over a cumulative counter', () => {
    const r = createRenderCostRecorder('engine.step');
    r.record(50, 1000);
    expect(r.stats().calls).toBe(1);
    r.reset();
    const after = r.stats();
    expect(after.calls, 'calls after reset').toBe(0);
    expect(after.maxMs, 'maxMs after reset (ms) — NOT ring-limited, so it must be cleared too').toBe(0);
    expect(after.elapsedMs, 'elapsedMs after reset (ms)').toBe(0);
  });

  it('refuses a non-finite or negative span rather than poisoning the percentiles', () => {
    const r = createRenderCostRecorder('engine.step');
    r.record(Number.NaN, 1000);
    r.record(-5, 1001);
    r.record(Number.POSITIVE_INFINITY, 1002);
    expect(r.stats().calls, 'calls — a dropped span must not be counted as one').toBe(0);
    r.record(1, 1003);
    expect(r.stats().calls).toBe(1);
    expect(r.stats().maxMs).toBe(1);
  });

  it('the ring bounds the percentile window without bounding the cumulative totals', () => {
    const r = createRenderCostRecorder('blit');
    // One expensive span, then a full ring of cheap ones: the percentile
    // window has forgotten it, the cumulative fields have not. Both behaviours
    // are load-bearing — p99 must describe RECENT frames, `maxMs`/`totalMs`
    // must describe the whole session.
    r.record(500, 0);
    for (let i = 0; i < 300; i++) r.record(1, i + 1);
    const s = r.stats();
    expect(s.p99Ms, 'p99 (ms) over the last 256 spans').toBe(1);
    expect(s.maxMs, 'maxMs (ms) over the session').toBe(500);
    expect(s.totalMs, 'totalMs (ms) over the session').toBe(800);
    expect(s.samples, 'samples — the ring is full').toBe(256);
    expect(s.calls, 'calls — cumulative, not ring-limited').toBe(301);
  });
});
