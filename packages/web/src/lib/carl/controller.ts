// packages/web/src/lib/carl/controller.ts
//
// Tick loop for Rackspace Carl. Pulled out of the Svelte component so we
// can unit-test the cancellation + sleep semantics without spinning up
// a full DOM.
//
// Lifecycle: start() begins ticking via setTimeout chains (NOT setInterval
// — sleep intents need variable gaps and the loop is naturally cancellable
// at every boundary). stop() flips the cancelled flag; in-flight setTimeout
// callbacks short-circuit when they wake.

import { SeededRng } from './rng';
import { RackspaceCarl, type CarlOptions } from './personality';
import type { Catalog } from './catalog';
import { applyIntent, readPatchView, type DriverDeps } from './driver';

export interface ControllerOptions extends CarlOptions {
  /** Deterministic seed for the run. Default: a time-derived value. */
  seed?: number;
  /** Catalog the personality picks modules from. */
  catalog: Catalog;
  /** Patch/ydoc to drive. */
  driver: DriverDeps;
  /**
   * Minimum gap between non-sleep intents in ms (default 250). Keeps the
   * bot perceptually distinct from a panic-spamming script: a human
   * patcher does maybe 4 things a second at most.
   */
  baseTickMs?: number;
}

export interface CarlController {
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** Strictly for tests — number of intents applied so far. */
  readonly intentsApplied: number;
}

export function createCarlController(opts: ControllerOptions): CarlController {
  const seed = opts.seed ?? Math.floor(Date.now() % 0x7fffffff);
  const rng = new SeededRng(seed);
  const personality = new RackspaceCarl(opts.catalog, {
    maxOwnedNodes: opts.maxOwnedNodes,
    idPrefix: opts.idPrefix,
  });
  const baseTickMs = opts.baseTickMs ?? 250;

  let cancelled = false;
  let running = false;
  let intentsApplied = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function tick() {
    if (cancelled) return;
    let sleepMs = baseTickMs;
    try {
      const view = readPatchView(opts.driver.patch);
      const intent = personality.next(rng, view);
      const intentSleep = applyIntent(opts.driver, intent);
      if (intent.kind !== 'sleep') intentsApplied++;
      sleepMs = Math.max(baseTickMs, intentSleep);
    } catch (e) {
      // Don't kill the loop on a single intent error — log and back off.
      // eslint-disable-next-line no-console
      console.warn('[carl] tick error', e);
      sleepMs = 1000;
    }
    timer = setTimeout(tick, sleepMs);
  }

  return {
    start() {
      if (running) return;
      cancelled = false;
      running = true;
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
  };
}
