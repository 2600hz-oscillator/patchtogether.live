import { describe, it, expect } from 'vitest';
import {
  RENDER_QUANTUM_S,
  TIMESTAMP_LOOKAHEAD_S,
  MAX_TIMESTAMP_LAG_MS,
  measureCtxOffset,
  eventTimeStampToAudioTime,
  createMidiScheduler,
} from './midi-timing';

describe('measureCtxOffset', () => {
  it('is currentTimeS minus performanceNowMs/1000', () => {
    expect(measureCtxOffset(10.0, 1000)).toBeCloseTo(9.0, 9);
    expect(measureCtxOffset(0.5, 3000)).toBeCloseTo(-2.5, 9);
  });
});

describe('eventTimeStampToAudioTime — the jitter-killing projection', () => {
  const CTX_OFFSET = -1.0; // perf.now() is 1000ms ahead of currentTime here

  it('preserves inter-event spacing regardless of when handlers run', () => {
    // Two events 20ms apart in TIMESTAMP, but BOTH handlers run late (and at
    // the SAME late moment — a burst after an event-loop stall). The OLD
    // floored scheduler would collapse them to the same time; the projection
    // keeps them 20ms apart.
    const ctxNow = 5.0;
    const perfNow = 6000; // both handlers dispatched at perf=6000ms
    const eventA = 5980; // arrived 20ms before perfNow
    const eventB = 6000; // arrived at perfNow
    const tA = eventTimeStampToAudioTime(eventA, ctxNow, perfNow, CTX_OFFSET);
    const tB = eventTimeStampToAudioTime(eventB, ctxNow, perfNow, CTX_OFFSET);
    // 20ms in timestamp → 0.02s apart on the audio clock, to float precision.
    expect(tB - tA).toBeCloseTo(0.02, 9);
  });

  it('projects a normal-lag event to timeStamp + offset + lookahead', () => {
    const ctxNow = 5.0;
    const perfNow = 6000;
    const eventTs = 5995; // 5ms lag — well under the lookahead budget
    const t = eventTimeStampToAudioTime(eventTs, ctxNow, perfNow, CTX_OFFSET);
    expect(t).toBeCloseTo(eventTs / 1000 + CTX_OFFSET + TIMESTAMP_LOOKAHEAD_S, 9);
    expect(t).toBeGreaterThan(ctxNow); // never in the past
  });

  it('clamps an outlier (lag > lookahead) to one render quantum ahead', () => {
    // Lag of 40ms exceeds the 25ms lookahead → projection would land in the
    // past → clamp to the floor (currentTime + one block).
    const ctxNow = 5.0;
    const perfNow = 6000;
    const eventTs = 5960; // 40ms lag
    const t = eventTimeStampToAudioTime(eventTs, ctxNow, perfNow, CTX_OFFSET);
    expect(t).toBeCloseTo(ctxNow + RENDER_QUANTUM_S, 9);
  });

  it('re-anchors a stale burst (lag > MAX_TIMESTAMP_LAG_MS) at now + lookahead', () => {
    const ctxNow = 5.0;
    const perfNow = 6000;
    const eventStale = perfNow - (MAX_TIMESTAMP_LAG_MS + 10); // 110ms lag
    const t = eventTimeStampToAudioTime(eventStale, ctxNow, perfNow, CTX_OFFSET);
    expect(t).toBeCloseTo(ctxNow + TIMESTAMP_LOOKAHEAD_S, 9);
  });

  it('re-anchors a future-skewed timestamp (negative lag) at now + lookahead', () => {
    const ctxNow = 5.0;
    const perfNow = 6000;
    const t = eventTimeStampToAudioTime(perfNow + 50, ctxNow, perfNow, CTX_OFFSET);
    expect(t).toBeCloseTo(ctxNow + TIMESTAMP_LOOKAHEAD_S, 9);
  });

  it('TIMESTAMP_LOOKAHEAD_S is at least one render quantum', () => {
    expect(TIMESTAMP_LOOKAHEAD_S).toBeGreaterThanOrEqual(RENDER_QUANTUM_S);
  });
});

describe('createMidiScheduler — drift-proof per-node scheduler', () => {
  it('schedAt preserves spacing under handler-dispatch jitter (regression for the 1-of-3 bug)', () => {
    // Drive the scheduler with an INJECTED clock so we can simulate the exact
    // failure: two notes 20ms apart in event.timeStamp, dispatched with
    // DIFFERENT (within-budget) main-thread lag — 5ms then 15ms. The pre-fix
    // floored scheduler returned `currentTime + 0.008` for both, so their
    // spacing collapsed to the audio-clock advance between handlers (here
    // 25ms) instead of the true 20ms. The projection keeps them 20ms apart.
    const ctx = { currentTime: 1.0 };
    let perf = 1000;
    const sched = createMidiScheduler(ctx, { nowMs: () => perf });

    // Note A: timeStamp 1000, handler runs 5ms late (perf 1005, ctx 1.005).
    perf = 1005;
    ctx.currentTime = 1.005;
    const tA = sched.schedAt(1000);

    // Note B: timeStamp 1020 (20ms later in real time), handler runs 10ms
    // late (perf 1030, ctx 1.030) — i.e. handlers are 25ms apart, notes 20ms.
    perf = 1030;
    ctx.currentTime = 1.03;
    const tB = sched.schedAt(1020);

    expect(tB - tA).toBeCloseTo(0.02, 6);

    // Contrast: what the OLD floored scheduler would have produced — spacing
    // collapsed to the 25ms audio-clock advance between handlers, NOT 20ms.
    const oldA = 1.005 + 0.008;
    const oldB = 1.03 + 0.008;
    expect(oldB - oldA).toBeCloseTo(0.025, 9);
  });

  it('soon() schedules a non-timestamped event a few ms ahead of currentTime', () => {
    const ctx = { currentTime: 2.0 };
    const sched = createMidiScheduler(ctx, { nowMs: () => 0 });
    expect(sched.soon()).toBeGreaterThan(2.0);
    expect(sched.soon(0.01)).toBeCloseTo(2.01, 9);
  });
});
