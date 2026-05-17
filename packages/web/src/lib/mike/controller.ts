// packages/web/src/lib/mike/controller.ts
//
// Tick loop for Meticulous Mike. Mirror of Carl's controller with
// slower default pacing — Mike pauses 5–15 s between actions where
// Carl pauses ~250 ms. The slow cadence is the FEATURE of Mike's
// persona: the user sees one careful action at a time.
//
// Lifecycle is identical to Carl's: start()/stop()/intentsApplied.
// Tests in controller.test.ts exercise it under vi.useFakeTimers.

import { SeededRng } from '$lib/carl/rng';
import { MeticulousMike, type MikeOptions } from './personality';
import type { Catalog } from './catalog';
import { applyIntent, readPatchView, type DriverDeps } from './driver';

export interface ControllerOptions extends MikeOptions {
  /** Deterministic seed for the run. Default: a time-derived value. */
  seed?: number;
  /** Catalog the personality picks modules from. */
  catalog: Catalog;
  /** Patch/ydoc to drive. */
  driver: DriverDeps;
  /**
   * Minimum gap between non-sleep actions, in ms. Default 5000. Tests
   * pass a tiny value to compress the timeline. The personality also
   * declares a min/max range per intent; the controller picks a value
   * inside that range and `Math.max`s with `baseTickMs` as a floor.
   */
  baseTickMs?: number;
  /**
   * Max gap between non-sleep actions, in ms. Default 15000. Same
   * tuning as `baseTickMs` — together they describe Mike's 5–15 s
   * pause range.
   */
  maxTickMs?: number;
}

export interface MikeController {
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** Strictly for tests — number of intents applied so far (non-sleep). */
  readonly intentsApplied: number;
  /** Strictly for tests — most recent sleep duration scheduled (ms). */
  readonly lastSleepMs: number;
}

export function createMikeController(opts: ControllerOptions): MikeController {
  const seed = opts.seed ?? Math.floor(Date.now() % 0x7fffffff);
  const rng = new SeededRng(seed);
  const personality = new MeticulousMike(opts.catalog, {
    maxOwnedNodes: opts.maxOwnedNodes,
    idPrefix: opts.idPrefix,
  });
  const baseTickMs = opts.baseTickMs ?? 5000;
  const maxTickMs = opts.maxTickMs ?? 15000;

  let cancelled = false;
  let running = false;
  let intentsApplied = 0;
  let lastSleepMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function tick() {
    if (cancelled) return;
    let sleepMs = baseTickMs;
    try {
      const view = readPatchView(opts.driver.patch);
      const mikeIntent = personality.next(rng, view);
      const intentSleep = applyIntent(opts.driver, mikeIntent.intent);
      if (mikeIntent.intent.kind !== 'sleep') intentsApplied++;
      // Sleep window: pick a value inside [minSleepMs, maxSleepMs], then
      // clamp via baseTickMs (floor) and maxTickMs (ceiling). For sleep
      // intents the intent's own `ms` overrides.
      const minSleep = Math.max(baseTickMs, mikeIntent.minSleepMs);
      const maxSleep = Math.min(maxTickMs, mikeIntent.maxSleepMs);
      const pickedSleep =
        intentSleep > 0
          ? intentSleep
          : minSleep + Math.floor(rng.next() * Math.max(0, maxSleep - minSleep));
      sleepMs = Math.max(baseTickMs, Math.min(maxTickMs, pickedSleep));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[mike] tick error', e);
      sleepMs = 5000;
    }
    lastSleepMs = sleepMs;
    timer = setTimeout(tick, sleepMs);
  }

  return {
    start() {
      if (running) return;
      cancelled = false;
      running = true;
      // First action fires after the base tick (matches Carl's pacing
      // contract: no instant work on start).
      lastSleepMs = baseTickMs;
      timer = setTimeout(tick, baseTickMs);
    },
    stop() {
      cancelled = true;
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get running() {
      return running;
    },
    get intentsApplied() {
      return intentsApplied;
    },
    get lastSleepMs() {
      return lastSleepMs;
    },
  };
}
