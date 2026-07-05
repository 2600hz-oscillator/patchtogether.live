// packages/web/src/lib/ui/controls/cc-commit.ts
//
// Coalescing pump for STREAMING MIDI-CC → param writes (the CC-storm
// render-starvation fix). Sibling of `createDragCommit` (drag-commit.ts) —
// same problem class, different event source and cadence:
//
//   - Pointer drags fire at 120–240 Hz but only while the pointer is down,
//     and the pointerup flush gives a hard end-of-gesture. createDragCommit
//     rAF-coalesces them (≤ 60 store writes/s).
//   - Hardware CC streams (an Electra One encoder twist) arrive at
//     100–300 msg/s with NO end-of-gesture signal, and each store write
//     detonates the full per-transaction cascade: synchronous whole-snapshot
//     rebuild (graph/snapshot.ts), full flowNodes/flowEdges rebuild fed to
//     SvelteFlow (Canvas.svelte), a reconciler pass, and every mounted
//     card's ydoc-update version pump. At CC rate that starves the video
//     rAF loop ("twisting Electra knobs murders video rendering") and the
//     audio scheduler. Gamepad CV at 60 Hz is free because it never writes
//     the store — the difference is the store write, not the message rate.
//
// createCcCommit makes the CC hot path store-free the same way (the
// gamepad / cv-bridge / #719 transient-render-state pattern):
//
//   - `push(value)` per CC message runs the TRANSIENT callback every time
//     (engine handle write + local knob visual — both zero-Y.Doc), then
//     coalesces the DURABLE store commit: an immediate leading-edge commit
//     when the stream is cold (a single CC poke behaves exactly like
//     today — one immediate store write), then at most one commit per
//     `activeCommitMs` while the stream is hot, plus a trailing settle
//     flush `settleMs` after the last message. The last value ALWAYS lands
//     (collab peers + persistence converge on the settled position).
//   - `flush()` force-commits any pending value (save/export hooks,
//     visibilitychange). `dispose()` flushes + cancels timers (unmount).
//
// Timers are setTimeout-based (NOT rAF): rAF is suspended in background
// tabs while hardware MIDI keeps arriving — a background twist must still
// commit. All timer/now dependencies are injectable for unit tests.

export interface CcCommit {
  /** Feed one CC message's scaled value: transient-applies it immediately
   *  and stages the coalesced durable commit. */
  push(value: number): void;
  /** Force-commit any pending value now (save/export/visibility hooks).
   *  Leaves the stream state alone — a continuing twist keeps coalescing. */
  flush(): void;
  /** Flush + cancel all timers + deactivate. Call on unmount/unregister. */
  dispose(): void;
  /** True while a CC stream is actively driving this control (from the
   *  first push until the settle flush). Consumers gate their store→visual
   *  follow on this, mirroring the pointer-drag `dragging` guard, so the
   *  control never snaps back to a not-yet-committed store value. */
  readonly active: boolean;
}

export interface CcCommitOpts {
  /** The durable store write (the card's real onchange — one Yjs
   *  transaction per call). Called with the latest value at commit time. */
  commit: (value: number) => void;
  /** Per-message transient apply (engine handle write / local knob visual).
   *  MUST NOT touch the Y.Doc — that's the whole point. */
  transient?: (value: number) => void;
  /** Stream went hot (first push) / cold (settle or dispose). */
  onActiveChange?: (active: boolean) => void;
  /** Minimum gap between durable commits while the stream is hot. The
   *  default keeps mid-stream store traffic at ~7 writes/s (collab peers
   *  see coarse live motion) while the transient leg carries the full-rate
   *  motion locally. */
  activeCommitMs?: number;
  /** Trailing flush delay after the last message — the settled commit. */
  settleMs?: number;
  // ── test seams (fake timers) ──
  now?: () => number;
  schedule?: (cb: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export const CC_ACTIVE_COMMIT_MS = 150;
export const CC_SETTLE_MS = 200;

/** Live pumps — flushed together by save/export paths + visibilitychange so
 *  a snapshot taken mid-twist always captures the latest value. */
const livePumps = new Set<CcCommit>();

/** Flush every live CC pump synchronously. Call before makeEnvelope-driven
 *  saves/exports so persistence never captures a value the stream has
 *  already moved past. */
export function flushAllCcCommits(): void {
  for (const pump of [...livePumps]) pump.flush();
}

let visibilityHooked = false;
function ensureVisibilityFlush(): void {
  // Defensive feature-detect (not just typeof): some unit environments stub
  // a partial `document` without addEventListener — the flush hook is a
  // browser nicety, never load-bearing for correctness (dispose/settle
  // flushes still land values).
  if (
    visibilityHooked
    || typeof document === 'undefined'
    || typeof document.addEventListener !== 'function'
  ) return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAllCcCommits();
  });
}

export function createCcCommit(opts: CcCommitOpts): CcCommit {
  const activeCommitMs = opts.activeCommitMs ?? CC_ACTIVE_COMMIT_MS;
  const settleMs = opts.settleMs ?? CC_SETTLE_MS;
  const now: () => number =
    opts.now
    ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
  const schedule: (cb: () => void, ms: number) => unknown =
    opts.schedule ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel: (h: unknown) => void =
    opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let pending: number | null = null;
  let lastCommitAt = -Infinity;
  let throttleTimer: unknown = null;
  let settleTimer: unknown = null;
  let active = false;
  let disposed = false;

  function setActive(a: boolean): void {
    if (active === a) return;
    active = a;
    opts.onActiveChange?.(a);
  }

  function commitPending(): void {
    if (pending === null) return;
    const v = pending;
    pending = null;
    lastCommitAt = now();
    opts.commit(v);
  }

  function clearThrottle(): void {
    if (throttleTimer !== null) {
      cancel(throttleTimer);
      throttleTimer = null;
    }
  }
  function clearSettle(): void {
    if (settleTimer !== null) {
      cancel(settleTimer);
      settleTimer = null;
    }
  }

  function onSettle(): void {
    settleTimer = null;
    clearThrottle();
    commitPending();
    setActive(false);
  }

  const pump: CcCommit = {
    push(value: number): void {
      opts.transient?.(value);
      if (disposed) {
        // Post-dispose push (setter raced an unmount): degrade to the
        // uncoalesced direct write — never lose a value, never re-arm timers.
        opts.commit(value);
        return;
      }
      pending = value;
      setActive(true);
      // Trailing settle flush re-arms on every message.
      clearSettle();
      settleTimer = schedule(onSettle, settleMs);
      const since = now() - lastCommitAt;
      if (since >= activeCommitMs) {
        // Leading edge: a cold stream commits IMMEDIATELY (a single CC poke
        // keeps today's semantics — the store never lags a lone message).
        clearThrottle();
        commitPending();
      } else if (throttleTimer === null) {
        throttleTimer = schedule(() => {
          throttleTimer = null;
          commitPending();
        }, activeCommitMs - since);
      }
    },
    flush(): void {
      clearThrottle();
      commitPending();
    },
    dispose(): void {
      clearThrottle();
      clearSettle();
      commitPending();
      setActive(false);
      disposed = true;
      livePumps.delete(pump);
    },
    get active(): boolean {
      return active;
    },
  };

  livePumps.add(pump);
  ensureVisibilityFlush();
  return pump;
}
