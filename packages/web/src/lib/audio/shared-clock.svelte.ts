// packages/web/src/lib/audio/shared-clock.svelte.ts
//
// Phase 0 of the shared-state-sync plan: a Svelte 5 rune-store hook that
// exposes the rack epoch and a sharedTimeNow() function so SyncedModule
// implementations can compute their state deterministically across clients.
//
// Internally we wire three things together:
//   1. A ClockSyncEstimator that consumes heartbeats observed via Awareness.
//   2. The Yjs `meta` map (`epoch_ms`, `rngSeed`) — one-write-only on first
//      access; resetEpoch() (owner-only) overwrites it for explicit reset.
//   3. A 5 s drift-compensation re-anchor with 200 ms smoothing, so any
//      subscriber gets clock alignment without per-module bookkeeping.
//
// The hook returns a frozen object whose `.epoch_ms` and `.snapshot` fields
// are reactive Svelte $state, plus pure-function getters `sharedTimeNow()`
// and `resetEpoch()`. It is safe to call sharedTimeNow() from worklets'
// init paths (it's synchronous) but the ongoing rune reactivity is
// only meaningful inside Svelte components.

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import {
  ClockSyncEstimator,
  toSharedTime,
  type ClockSyncSnapshot,
} from '$lib/multiplayer/clock-sync';

// Mirror the server-side constant; duplicated as a string literal so the
// web package doesn't import @patchtogether.live/server.
export const HEARTBEAT_AWARENESS_FIELD = '__heartbeat';
const META_MAP_NAME = 'meta';
const META_EPOCH_FIELD = 'epoch_ms';
const META_SEED_FIELD = 'rngSeed';

/** Drift-compensation tunables — see plan §6 / brief decision #4. */
export const RESYNC_INTERVAL_MS = 5000;
export const RESYNC_SMOOTHING_MS = 200;

interface HeartbeatPayload {
  tick: number;
  ts_ms: number;
}

export interface SharedClockHandle {
  /** Current rack epoch in shared-time ms (a single fixed instant). Reactive. */
  readonly epoch_ms: number | null;
  /** Live snapshot of the clock-sync estimator. Reactive. */
  readonly snapshot: ClockSyncSnapshot;
  /** Counter incremented every time the resync logic re-anchors the offset.
   *  Subscribers (worklets, SyncedModuleDef instances) can listen to this
   *  to know "the offset has been smoothly updated; pull the new value". */
  readonly resyncCount: number;

  /** Map a perf.now() reading to shared-time ms. Returns null until the
   *  first heartbeat has converged. */
  sharedTimeAt(perfNowMs: number): number | null;

  /** Convenience: shared-time ms at the moment of the call. */
  sharedTimeNow(): number | null;

  /** Owner-only: write a fresh `meta.epoch_ms` to the Yjs doc, snapping
   *  the clock back to "now" (in shared-time). Other clients see the
   *  epoch change via Yjs and re-anchor smoothly. */
  resetEpoch(): void;

  /** Subscribe to epoch resets (local or remote). Returns an unsubscribe
   *  function. Modules whose worklets need a hard re-init on reset
   *  (LFO, sequencer, …) wire through this. */
  onReset(fn: () => void): () => void;

  /** Read the rack-wide PRNG seed. Lazily initialised on first access. */
  rngSeed(): number;

  /** Tear down the heartbeat subscriber + resync timer. Call on unmount. */
  destroy(): void;
}

interface InternalDeps {
  now(): number;
  perfNow(): number;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(t: ReturnType<typeof setInterval>): void;
  randomU32(): number;
}

const browserDeps: InternalDeps = {
  now: () => Date.now(),
  perfNow: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
  randomU32: () => Math.floor(Math.random() * 0x100000000) | 0,
};

export interface CreateSharedClockOptions {
  /** Hocuspocus provider — we read its `.awareness` to receive heartbeats.
   *  Pass null for tests / single-user mode; the hook becomes a no-op
   *  shell that returns null for everything. */
  provider: HocuspocusProvider | null;
  /** The Yjs document whose `meta` map carries the epoch + seed. */
  ydoc: Y.Doc | null;
  /** Test-only deps override. */
  deps?: Partial<InternalDeps>;
}

/**
 * Construct a SharedClockHandle. Designed to be called from a Svelte
 * component (so the returned `$state`-backed fields trigger re-render),
 * but works as a plain JS object outside of one too — the runes degrade
 * to plain values when the Svelte runtime is absent.
 */
export function createSharedClock(opts: CreateSharedClockOptions): SharedClockHandle {
  const deps: InternalDeps = { ...browserDeps, ...(opts.deps ?? {}) };
  const estimator = new ClockSyncEstimator();

  let snapshot = $state<ClockSyncSnapshot>(estimator.snapshot());
  let epoch_ms = $state<number | null>(null);
  let resyncCount = $state<number>(0);

  // Pull/initialize the meta map. We don't mutate it on read — only
  // resetEpoch() and the bootstrap path below write.
  const meta: Y.Map<unknown> | null = opts.ydoc?.getMap(META_MAP_NAME) ?? null;

  function bootstrapEpoch(): void {
    if (!meta) return;
    const existing = meta.get(META_EPOCH_FIELD);
    if (typeof existing === 'number') {
      epoch_ms = existing;
      return;
    }
    // No epoch yet. We can't write one until we have a stable shared-time
    // reading — defer until the estimator has converged.
    const sn = estimator.snapshot();
    if (sn.offsetMs === null) return;
    const nowShared = (deps.perfNow() + sn.offsetMs) | 0;
    opts.ydoc!.transact(() => {
      // Re-check inside the transact: another client may have written
      // between our last check and now.
      if (typeof meta.get(META_EPOCH_FIELD) !== 'number') {
        meta.set(META_EPOCH_FIELD, nowShared);
      }
      if (typeof meta.get(META_SEED_FIELD) !== 'number') {
        meta.set(META_SEED_FIELD, deps.randomU32());
      }
    });
    const v = meta.get(META_EPOCH_FIELD);
    if (typeof v === 'number') epoch_ms = v;
  }

  // --- Heartbeat subscription ---
  const provider = opts.provider;
  let lastEmittedOffset: number | null = null;
  let smoothing: { from: number; to: number; startedPerfMs: number } | null = null;

  function applySnapshot(sn: ClockSyncSnapshot): void {
    snapshot = sn;
    if (sn.offsetMs === null) return;
    if (lastEmittedOffset === null) {
      lastEmittedOffset = sn.offsetMs;
      bootstrapEpoch();
      return;
    }
    const delta = sn.offsetMs - lastEmittedOffset;
    if (Math.abs(delta) < 0.05) return; // sub-100µs noise
    smoothing = {
      from: lastEmittedOffset,
      to: sn.offsetMs,
      startedPerfMs: deps.perfNow(),
    };
    lastEmittedOffset = sn.offsetMs;
    resyncCount += 1;
    bootstrapEpoch();
  }

  function effectiveOffset(): number | null {
    if (lastEmittedOffset === null) return snapshot.offsetMs;
    if (!smoothing) return lastEmittedOffset;
    const t = (deps.perfNow() - smoothing.startedPerfMs) / RESYNC_SMOOTHING_MS;
    if (t >= 1) {
      const final = smoothing.to;
      smoothing = null;
      return final;
    }
    return smoothing.from + (smoothing.to - smoothing.from) * Math.max(0, Math.min(1, t));
  }

  function onAwarenessChange(): void {
    if (!provider) return;
    const states = provider.awareness?.getStates();
    if (!states) return;
    let newest: HeartbeatPayload | null = null;
    for (const [, state] of states) {
      const hb = (state as Record<string, unknown>)[HEARTBEAT_AWARENESS_FIELD] as
        | HeartbeatPayload
        | undefined;
      if (!hb || typeof hb.tick !== 'number' || typeof hb.ts_ms !== 'number') continue;
      if (!newest || hb.tick > newest.tick) newest = hb;
    }
    if (!newest) return;
    const sn = estimator.observe({
      tick: newest.tick,
      serverTs: newest.ts_ms,
      clientRecvTs: deps.perfNow(),
    });
    applySnapshot(sn);
  }

  let awarenessUnsub: (() => void) | null = null;
  if (provider?.awareness) {
    const aw = provider.awareness;
    aw.on('update', onAwarenessChange);
    aw.on('change', onAwarenessChange);
    awarenessUnsub = () => {
      aw.off('update', onAwarenessChange);
      aw.off('change', onAwarenessChange);
    };
  }

  const resetListeners = new Set<() => void>();

  // Yjs meta-map observer: another client (the owner) can resetEpoch();
  // we should react to that.
  let metaUnsub: (() => void) | null = null;
  let lastObservedEpoch = epoch_ms;
  if (meta) {
    const onMetaChange = (): void => {
      const v = meta.get(META_EPOCH_FIELD);
      if (typeof v !== 'number') return;
      const changed = v !== lastObservedEpoch;
      lastObservedEpoch = v;
      epoch_ms = v;
      if (changed) {
        for (const fn of resetListeners) fn();
      }
    };
    onMetaChange();
    meta.observe(onMetaChange);
    metaUnsub = () => meta.unobserve(onMetaChange);
  }

  // Drift-compensation re-anchor: every 5 s, pull the latest estimator
  // snapshot and feed it through the smoothing layer. The estimator is
  // already updated on every heartbeat receipt (inside onAwarenessChange);
  // this timer just makes sure the smoothing layer flushes a re-anchor
  // even when the heartbeat-derived offset is stable enough to skip the
  // mid-flight applySnapshot path.
  const resyncTimer = deps.setInterval(() => {
    const sn = estimator.snapshot();
    if (sn.offsetMs !== null && lastEmittedOffset !== null) {
      const delta = Math.abs(sn.offsetMs - lastEmittedOffset);
      if (delta > 0) applySnapshot(sn);
    }
  }, RESYNC_INTERVAL_MS);

  function sharedTimeAt(perfNowMs: number): number | null {
    const off = effectiveOffset();
    if (off === null) return null;
    return perfNowMs + off;
  }

  function rngSeed(): number {
    if (!meta) return 0;
    const existing = meta.get(META_SEED_FIELD);
    if (typeof existing === 'number') return existing;
    const fresh = deps.randomU32();
    if (opts.ydoc) {
      opts.ydoc.transact(() => {
        if (typeof meta.get(META_SEED_FIELD) !== 'number') {
          meta.set(META_SEED_FIELD, fresh);
        }
      });
    }
    const v = meta.get(META_SEED_FIELD);
    return typeof v === 'number' ? v : fresh;
  }

  return {
    get epoch_ms() {
      return epoch_ms;
    },
    get snapshot() {
      return snapshot;
    },
    get resyncCount() {
      return resyncCount;
    },
    sharedTimeAt,
    sharedTimeNow() {
      return sharedTimeAt(deps.perfNow());
    },
    resetEpoch() {
      if (!opts.ydoc || !meta) return;
      const off = effectiveOffset();
      if (off === null) return;
      const fresh = (deps.perfNow() + off) | 0;
      opts.ydoc.transact(() => {
        meta.set(META_EPOCH_FIELD, fresh);
      });
      epoch_ms = fresh;
      // Notify SyncedModule listeners (LFO etc.) to snap; this is the
      // "Anyone listening will hear a moment of silence" moment from
      // the confirm dialog.
      for (const fn of resetListeners) fn();
    },
    rngSeed,
    onReset(fn) {
      resetListeners.add(fn);
      return () => {
        resetListeners.delete(fn);
      };
    },
    destroy() {
      awarenessUnsub?.();
      metaUnsub?.();
      resetListeners.clear();
      deps.clearInterval(resyncTimer);
    },
  };
}

// Helper: useful for tests + ART harnesses that don't have a real provider.
// Mirrors toSharedTime() but exposes it from this module so callers don't
// also have to import from the multiplayer package.
export { toSharedTime };
