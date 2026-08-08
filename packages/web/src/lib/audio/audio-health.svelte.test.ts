// packages/web/src/lib/audio/audio-health.svelte.test.ts
//
// THE PERMANENT LEG the brief asks for: feed the readout a NON-ZERO stats
// object and assert it renders.
//
// This is the test that would be worth more than any number of green e2e rows,
// because the e2e row cannot fail: headless Chromium runs a null audio sink and
// physically cannot underrun, so `expect(underruns).toBe(0)` there is vacuous
// forever. Here, a monitor wired to a struggling context MUST show the trouble,
// and a monitor wired to the owner's real healthy baseline MUST show none.
//
// No fake timers, no wall-clock: `poll()` is public precisely so this file
// drives the sampler deterministically.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAudioHealthMonitor } from './audio-health.svelte';
import { formatAudioHealth } from './playback-stats';
import { createTickLatencyRecorder } from './tick-latency';
import { recordWorkletError, __resetWorkletErrorLedger } from './worklet-guard';

/** The owner's real Chrome reading, 2026-08-08. */
const HEALTHY = {
  underrunDuration: 0,
  underrunEvents: 0,
  totalDuration: 18.056818,
  averageLatency: 0.036588,
  minimumLatency: 0,
  maximumLatency: 0.041291,
};

/** A context that has been struggling. Synthetic — see the header. */
const STRUGGLING = {
  underrunDuration: 0.412,
  underrunEvents: 37,
  totalDuration: 612.5,
  averageLatency: 0.0491,
  minimumLatency: 0,
  maximumLatency: 0.1883,
};

const asCtx = (playbackStats: unknown): AudioContext =>
  ({ playbackStats }) as unknown as AudioContext;

describe('audio-health monitor — the readout moves with the sensor', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetWorkletErrorLedger();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    __resetWorkletErrorLedger();
  });

  it('HEALTHY: the owner baseline renders zero underruns', () => {
    const m = createAudioHealthMonitor({ readTickStats: () => null });
    m.bind(asCtx(HEALTHY));
    expect(m.health.supported).toBe(true);
    expect(m.health.underrunEvents).toBe(0);
    expect(formatAudioHealth(m.health)).toEqual({
      underruns: '0',
      dropout: '0.0ms',
      avgLatency: '36.6ms',
    });
  });

  it('FORCED: a struggling context RENDERS the non-zero count', () => {
    const m = createAudioHealthMonitor({ readTickStats: () => null });
    m.bind(asCtx(STRUGGLING));
    expect(m.health.underrunEvents, 'the count the footer prints').toBe(37);
    const f = formatAudioHealth(m.health);
    expect(f.underruns).toBe('37');
    expect(f.dropout).toBe('412.0ms');
    expect(f.avgLatency).toBe('49.1ms');
  });

  it('the SAME monitor tracks a context going bad — it is a live readout, not a boot snapshot', () => {
    // The existing footer latency readout is a non-reactive property read that
    // only re-evaluates when the ctx IDENTITY changes — effectively a boot-time
    // constant. This must not be that.
    let stats: typeof HEALTHY = { ...HEALTHY };
    const ctx = { get playbackStats() { return stats; } } as unknown as AudioContext;
    const m = createAudioHealthMonitor({ readTickStats: () => null });
    m.bind(ctx);
    expect(m.health.underrunEvents).toBe(0);

    stats = { ...STRUGGLING };
    m.poll();
    expect(m.health.underrunEvents, 'the readout must follow the sensor').toBe(37);
  });

  it('UNSUPPORTED: no playbackStats degrades to "—" silently, and detaching resets it', () => {
    const m = createAudioHealthMonitor({ readTickStats: () => null });
    m.bind(asCtx(undefined));
    expect(m.health.supported).toBe(false);
    expect(formatAudioHealth(m.health).underruns).toBe('—');

    m.bind(asCtx(STRUGGLING));
    expect(m.health.supported).toBe(true);
    m.bind(null);
    expect(m.health.supported, 'detaching must not leave a stale reading').toBe(false);
  });

  it('the tick histogram reaches the readout, and null before any module starts the clock', () => {
    const rec = createTickLatencyRecorder(25);
    let live = false;
    const m = createAudioHealthMonitor({ readTickStats: () => (live ? rec.stats() : null) });
    m.bind(asCtx(HEALTHY));
    expect(m.tick, 'no scheduler clock exists yet').toBeNull();

    live = true;
    let t = 1000;
    for (let i = 0; i < 10; i++) {
      rec.arrive(t);
      t += 25;
    }
    t += 300;
    rec.arrive(t);
    m.poll();
    expect(m.tick?.maxMs, 'max lateness (MILLISECONDS)').toBeCloseTo(300, 5);
    expect(m.tick?.overBudget).toBe(1);
  });

  it('a worklet latch is counted and ATTRIBUTED even if it fired before start()', () => {
    // Module boot races the footer mount. "Missed the event" and "nothing
    // happened" must not read the same.
    recordWorkletError({ processor: 'master-limiter', moduleType: 'audioOut', nodeId: 'n-9', message: 'boom' });
    const m = createAudioHealthMonitor({ readTickStats: () => null });
    m.bind(asCtx(HEALTHY));
    expect(m.workletErrors, 'a latch from before the monitor existed').toBe(1);
    expect(m.lastWorkletError?.moduleType).toBe('audioOut');
    expect(m.lastWorkletError?.nodeId).toBe('n-9');
  });

  it('start() surfaces a latch immediately, and stop() unsubscribes', () => {
    const m = createAudioHealthMonitor({ readTickStats: () => null, intervalMs: 60_000 });
    m.bind(asCtx(HEALTHY));
    m.start();
    expect(m.workletErrors).toBe(0);

    recordWorkletError({ processor: 'karplus', moduleType: 'karplus', nodeId: 'n-3', message: '' });
    expect(m.workletErrors, 'no waiting for the 1 Hz poll').toBe(1);
    expect(m.lastWorkletError?.processor).toBe('karplus');

    m.stop();
    recordWorkletError({ processor: 'rings', moduleType: 'rings', nodeId: 'n-4', message: '' });
    expect(m.workletErrors, 'stopped means stopped').toBe(1);
    m.poll();
    expect(m.workletErrors, 'though an explicit poll still reconciles').toBe(2);
  });

  it('start() is idempotent and stop() before start() is a no-op', () => {
    const m = createAudioHealthMonitor({ readTickStats: () => null, intervalMs: 60_000 });
    expect(() => m.stop()).not.toThrow();
    m.start();
    m.start();
    recordWorkletError({ processor: 'p', message: '' });
    expect(m.workletErrors, 'a doubled subscription must not double-count').toBe(1);
    m.stop();
  });
});
