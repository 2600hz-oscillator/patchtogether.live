// packages/web/src/lib/audio/scheduler-clock.ts
//
// SchedulerClock — a singleton main-thread tick source that drives the
// per-module step schedulers (sequencer, drumseqz, polyseqz, score,
// cartesian, …). Two delivery shapes:
//
//   1. Web Worker (preferred). A tiny inline worker calls `setInterval`
//      at TICK_MS and posts back to the main thread. Worker timers are
//      isolated from main-thread blocking — when the user drags a Svelte
//      Flow node and the main thread spends 80–150ms re-rendering, the
//      worker keeps emitting ticks on schedule. The main-thread `tick`
//      callbacks then run as soon as the event loop is free again.
//
//   2. setTimeout fallback (when Worker construction fails — sandboxed
//      contexts, CSP restrictions, Vitest with jsdom, etc.). Same cadence
//      but vulnerable to main-thread blocking. This is the legacy
//      behavior the modules used before this module existed.
//
// Why this matters: prior to this module, each sequencer self-managed a
// `setTimeout(tick, 25)` loop on the main thread. With main-thread jank
// (drag, big React/Svelte updates, Y.Doc rebroadcasts), `setTimeout`
// callbacks would queue up behind the jank — by the time `tick()` ran,
// the audio thread had already exhausted its 100ms lookahead window and
// scheduled events would land late or get missed entirely. The audible
// result was tempo drift / jitter exactly correlated with drag activity.
//
// With the Worker tick, even if main-thread blocking is ~200ms, the Worker
// posts ~8 tick messages during that window; they all land in the message
// queue and the moment the main thread frees up, the JS engine drains
// them and runs `tick()` in tight succession — the lookahead window
// catches up immediately. Combined with the bumped lookahead constant
// (200ms instead of 100ms in each module), the audio thread effectively
// always has a fully-scheduled future.
//
// Non-goals:
//   - Not a "high-precision clock" — we still rely on AudioContext.currentTime
//     for sample-accurate scheduling. The worker just decides WHEN to run
//     the JS that pushes events into the audio thread.
//   - Not multi-context aware — there's one global tick rate (every 25ms).
//     Per-module sub-tick scheduling stays in each module's tick() body.

const TICK_MS = 25;

/** A subscriber that wants to be called at TICK_MS cadence. */
export type SchedulerTickFn = () => void;

interface SchedulerClock {
  subscribe(fn: SchedulerTickFn): () => void;
  /** True iff the tick source is the Web Worker (vs. setTimeout fallback). */
  readonly usingWorker: boolean;
  /** Tear down the singleton. Tests use this between cases. */
  dispose(): void;
}

/** Worker source code as a string — avoids a separate build artifact and
 *  keeps the scheduler self-contained. The worker just emits a tick on a
 *  fixed interval; all scheduling decisions stay on the main thread. */
const WORKER_SOURCE = `
let timer = null;
self.onmessage = (e) => {
  const msg = e.data;
  if (msg && msg.type === 'start') {
    if (timer !== null) return;
    const ms = typeof msg.ms === 'number' ? msg.ms : 25;
    timer = setInterval(() => self.postMessage({ type: 'tick' }), ms);
  } else if (msg && msg.type === 'stop') {
    if (timer !== null) { clearInterval(timer); timer = null; }
  }
};
`;

let SINGLETON: SchedulerClock | null = null;

function buildClock(): SchedulerClock {
  const subscribers = new Set<SchedulerTickFn>();
  let worker: Worker | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;

  function dispatch(): void {
    // Snapshot subscribers to allow re-entrant subscribe/unsubscribe inside
    // a callback without affecting iteration. Errors in one subscriber
    // must not prevent the others from running.
    const snap = Array.from(subscribers);
    for (const fn of snap) {
      try {
        fn();
      } catch (err) {
        console.error('[scheduler-clock] subscriber error', err);
      }
    }
  }

  let usingWorker = false;
  try {
    if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
      // Revoke the blob URL once the worker is constructed; the worker
      // already has the script.
      URL.revokeObjectURL(url);
      worker.onmessage = (e: MessageEvent) => {
        const data = e.data as { type?: string } | undefined;
        if (data?.type === 'tick') dispatch();
      };
      worker.onerror = (err) => {
        console.warn('[scheduler-clock] worker error, falling back to setInterval', err);
        worker?.terminate();
        worker = null;
        usingWorker = false;
        startFallback();
      };
      worker.postMessage({ type: 'start', ms: TICK_MS });
      usingWorker = true;
    }
  } catch (err) {
    console.warn('[scheduler-clock] worker unavailable, using setInterval fallback', err);
    worker = null;
    usingWorker = false;
  }

  function startFallback(): void {
    if (fallbackTimer !== null) return;
    fallbackTimer = setInterval(dispatch, TICK_MS);
  }
  if (!worker) startFallback();

  return {
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    get usingWorker() {
      return usingWorker;
    },
    dispose() {
      subscribers.clear();
      if (worker) {
        try { worker.postMessage({ type: 'stop' }); } catch { /* noop */ }
        try { worker.terminate(); } catch { /* noop */ }
        worker = null;
      }
      if (fallbackTimer !== null) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
      usingWorker = false;
    },
  };
}

/**
 * Get (or lazily construct) the process-wide scheduler clock singleton.
 * Subscribers are called every TICK_MS milliseconds. The first subscribe
 * lazily constructs the underlying Worker; teardown is via `dispose()`
 * (test only — production never disposes).
 */
export function getSchedulerClock(): SchedulerClock {
  if (!SINGLETON) SINGLETON = buildClock();
  return SINGLETON;
}

/**
 * Reset the singleton. Test-only — gives a clean slate between specs.
 * Production callers should never reach this.
 */
export function __resetSchedulerClockForTests(): void {
  if (SINGLETON) {
    SINGLETON.dispose();
    SINGLETON = null;
  }
}

/** Exposed for tests — verifies the constant a module's tick() expects. */
export const SCHEDULER_TICK_MS = TICK_MS;
