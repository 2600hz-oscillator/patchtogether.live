// packages/web/src/lib/audio/scheduler-clock.test.ts
//
// Unit tests for the scheduler-clock singleton. Vitest's jsdom env doesn't
// ship a Worker constructor, so the test path always exercises the
// setTimeout fallback (assertion below). What we really verify is the
// public contract: subscribe → callback fires at TICK_MS cadence,
// unsubscribe stops further callbacks, errors in one subscriber don't
// kill the others, and dispose tears the clock down cleanly.
//
// In real browsers (where Worker IS available) the same callback contract
// holds; the worker-vs-fallback toggle is exercised by the e2e suite.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getSchedulerClock,
  __resetSchedulerClockForTests,
  SCHEDULER_TICK_MS,
} from './scheduler-clock';

describe('scheduler-clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSchedulerClockForTests();
  });

  afterEach(() => {
    __resetSchedulerClockForTests();
    vi.useRealTimers();
  });

  it('SCHEDULER_TICK_MS exposes the tick interval', () => {
    expect(SCHEDULER_TICK_MS).toBeGreaterThan(0);
    expect(SCHEDULER_TICK_MS).toBeLessThan(100);
  });

  it('subscribers receive a tick after TICK_MS elapses', () => {
    const clock = getSchedulerClock();
    const fn = vi.fn();
    clock.subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SCHEDULER_TICK_MS * 3);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('multiple subscribers all receive the same tick', () => {
    const clock = getSchedulerClock();
    const a = vi.fn();
    const b = vi.fn();
    clock.subscribe(a);
    clock.subscribe(b);
    vi.advanceTimersByTime(SCHEDULER_TICK_MS * 2);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops further callbacks', () => {
    const clock = getSchedulerClock();
    const fn = vi.fn();
    const unsubscribe = clock.subscribe(fn);
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    unsubscribe();
    vi.advanceTimersByTime(SCHEDULER_TICK_MS * 5);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('an error in one subscriber does not block other subscribers', () => {
    const clock = getSchedulerClock();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    clock.subscribe(bad);
    clock.subscribe(good);
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('subscribing inside a tick callback does not double-fire on the same tick', () => {
    const clock = getSchedulerClock();
    const inner = vi.fn();
    const outer = vi.fn(() => {
      clock.subscribe(inner);
    });
    clock.subscribe(outer);
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing inside a tick callback stops that subscriber on next tick', () => {
    const clock = getSchedulerClock();
    let unsub: (() => void) | null = null;
    const fn = vi.fn(() => {
      unsub?.();
    });
    unsub = clock.subscribe(fn);
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SCHEDULER_TICK_MS * 5);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('dispose stops the clock and clears subscribers', () => {
    const clock = getSchedulerClock();
    const fn = vi.fn();
    clock.subscribe(fn);
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    expect(fn).toHaveBeenCalledTimes(1);
    clock.dispose();
    vi.advanceTimersByTime(SCHEDULER_TICK_MS * 5);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('jsdom environment uses the setTimeout fallback (no Worker)', () => {
    // Sanity: in this test env Worker is undefined or its constructor
    // throws when called. Either way usingWorker should be false.
    const clock = getSchedulerClock();
    expect(clock.usingWorker).toBe(false);
  });
});
