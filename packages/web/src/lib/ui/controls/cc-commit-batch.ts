// packages/web/src/lib/ui/controls/cc-commit-batch.ts
//
// GLOBAL two-lane batcher for streaming-CC store commits (phase 2 of the
// MIDI-CC render-starvation fix). #1030's createCcCommit gave each
// (moduleId, paramId) its own pump with a PRIVATE throttle timer — N
// simultaneously-twisted knobs therefore produced N independent ~6.7/s
// Y.Doc transaction streams, each detonating the full per-transaction
// cascade. This module replaces the private timers with ONE shared ticker
// + per-window queues that drain ALL due pump commits into at most TWO
// ydoc.transact calls per 150ms window:
//
//   - the UNDOABLE lane (midi-learn → card onchange → setNodeParam under
//     LOCAL_ORIGIN) — wrapped in one LOCAL_ORIGIN transaction. Yjs nested
//     `transact` reuses the outer transaction and the OUTER origin wins,
//     so the nested setNodeParam transacts stay ONE tracked transaction.
//   - the BARE lane (Electra host.writeParam's deliberately NON-undoable
//     raw proxy writes) — wrapped in one CC_STREAM_ORIGIN transaction
//     (NOT in the UndoManager's trackedOrigins), so SyncedStore's internal
//     no-origin transact is absorbed WITHOUT being promoted to undoable.
//
// Mixing lanes in one transact is impossible by construction: a bare
// write nested under LOCAL_ORIGIN would silently flood the undo stack,
// and an undoable write nested under a bare wrapper would silently lose
// undo — the exact promotion hazards the two-lane split exists to prevent.
//
// PURE + injectable (zero Y imports): the Y.Doc binding lives in
// cc-batch-store.ts (the CcBatchSink), mirroring cc-commit.ts's test-seam
// style. Timers are setTimeout-based (NOT rAF — background tabs still
// receive hardware MIDI); the microtask queue merges the LEADING commits
// of N knobs whose first CC lands in the same task into one transaction.

export type CcLane = 'undoable' | 'bare';

export interface CcBatchSink {
  /** Run all queued commit thunks for ONE lane inside ONE store
   *  transaction (the sink owns the transact + per-thunk try/catch). */
  runLane(lane: CcLane, thunks: Array<() => void>): void;
}

/** A hot pump on the shared ticker: each tick the batcher takes its due
 *  commit thunk (clearing the pump's pending value), or null. */
export interface CcTickClient {
  readonly lane: CcLane;
  takeDue(): (() => void) | null;
}

export interface CcBatcher {
  /** Queue one commit thunk; arms a queueMicrotask flush so all thunks
   *  enqueued in the same task drain into ≤1 transaction per lane. */
  enqueue(lane: CcLane, run: () => void): void;
  /** Join the shared throttle ticker (stream went hot). Idempotent. */
  markHot(client: CcTickClient): void;
  /** Leave the ticker (settled / disposed). Idempotent. */
  markCold(client: CcTickClient): void;
  /** Synchronously drain every hot client + both queues (save/export/
   *  visibilitychange — persistence must never lag the stream). */
  flushNow(): void;
}

export interface CcBatcherOpts {
  /** Shared throttle window; defaults to CC_ACTIVE_COMMIT_MS (150). */
  tickMs?: number;
  // ── test seams (fake timers) ──
  schedule?: (cb: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  queueTask?: (cb: () => void) => void;
}

const LANES: readonly CcLane[] = ['undoable', 'bare'];
const DEFAULT_TICK_MS = 150;

export function createCcBatcher(sink: CcBatchSink, opts: CcBatcherOpts = {}): CcBatcher {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const schedule: (cb: () => void, ms: number) => unknown =
    opts.schedule ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel: (h: unknown) => void =
    opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const queueTask: (cb: () => void) => void =
    opts.queueTask
    ?? (typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (cb) => void Promise.resolve().then(cb));

  const queues: Record<CcLane, Array<() => void>> = { undoable: [], bare: [] };
  const hot = new Set<CcTickClient>();
  let microtaskArmed = false;
  let tickTimer: unknown = null;

  /** Run one lane through the sink, isolated so a throwing sink can't kill
   *  the ticker chain or drop the other lane. */
  function runLane(lane: CcLane, thunks: Array<() => void>): void {
    if (thunks.length === 0) return;
    try {
      sink.runLane(lane, thunks);
    } catch (err) {
      console.error('[cc-batch] sink.runLane threw:', err);
    }
  }

  /** Drain the enqueue() queues (≤1 transaction per lane). */
  function drainQueues(): void {
    for (const lane of LANES) {
      if (queues[lane].length === 0) continue;
      const thunks = queues[lane];
      queues[lane] = [];
      runLane(lane, thunks);
    }
  }

  /** Collect due thunks from every hot client, bucketed by lane. */
  function collectDue(): Record<CcLane, Array<() => void>> {
    const due: Record<CcLane, Array<() => void>> = { undoable: [], bare: [] };
    for (const client of [...hot]) {
      const t = client.takeDue();
      if (t) due[client.lane].push(t);
    }
    return due;
  }

  function tick(): void {
    tickTimer = null;
    // Merge queued + due thunks so one window = one transaction per lane
    // even when leading-edge enqueues and hot drains coincide.
    const due = collectDue();
    for (const lane of LANES) {
      const thunks = [...queues[lane], ...due[lane]];
      queues[lane] = [];
      runLane(lane, thunks);
    }
    if (hot.size > 0) tickTimer = schedule(tick, tickMs);
  }

  return {
    enqueue(lane: CcLane, run: () => void): void {
      queues[lane].push(run);
      if (!microtaskArmed) {
        microtaskArmed = true;
        queueTask(() => {
          microtaskArmed = false;
          drainQueues();
        });
      }
    },
    markHot(client: CcTickClient): void {
      hot.add(client);
      if (tickTimer === null) tickTimer = schedule(tick, tickMs);
    },
    markCold(client: CcTickClient): void {
      hot.delete(client);
      if (hot.size === 0 && tickTimer !== null) {
        cancel(tickTimer);
        tickTimer = null;
      }
    },
    flushNow(): void {
      const due = collectDue();
      for (const lane of LANES) {
        const thunks = [...queues[lane], ...due[lane]];
        queues[lane] = [];
        runLane(lane, thunks);
      }
    },
  };
}
