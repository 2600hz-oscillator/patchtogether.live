// packages/web/src/lib/audio/fourplexer-select.ts
//
// Pure selector-advance logic for 4PLEXER, shared between the UI (gate-
// advance preview, direct knob clicks) and the unit test. The DSP worklet
// (packages/dsp/src/fourplexer.ts) carries an inlined mirror of
// fourplexerNextSelector — this is the canonical, unit-tested definition.

/** Number of signal inputs (and therefore selector positions). */
export const FOURPLEXER_INPUTS = 4;

/**
 * Advance a selector index to the NEXT input, wrapping 3 → 0
 * (1-based: 1→2→3→4→1). `cur` is the 0-based index 0..3; non-integer or
 * out-of-range values are normalised first so a corrupt saved value can't
 * desync the selector. Returns the next 0-based index 0..3.
 */
export function fourplexerNextSelector(cur: number): number {
  const norm = ((Math.round(cur) % FOURPLEXER_INPUTS) + FOURPLEXER_INPUTS) % FOURPLEXER_INPUTS;
  return (norm + 1) % FOURPLEXER_INPUTS;
}

/** Clamp + round an arbitrary number into a valid selector index 0..3. */
export function fourplexerClampSelector(idx: number): number {
  if (!Number.isFinite(idx)) return 0;
  return ((Math.round(idx) % FOURPLEXER_INPUTS) + FOURPLEXER_INPUTS) % FOURPLEXER_INPUTS;
}

/**
 * Apply `n` gate pulses to a selector starting at `start`, returning the
 * resulting 0-based index. Used by tests to assert multi-pulse wrap
 * behaviour deterministically.
 */
export function fourplexerAdvanceBy(start: number, n: number): number {
  let cur = fourplexerClampSelector(start);
  for (let i = 0; i < n; i++) cur = fourplexerNextSelector(cur);
  return cur;
}

// ---------------- Store-write coalescing ----------------
//
// ⚠ THE GATE INPUTS ARE AUDIO-RATE PORTS AND EVERY RISING EDGE USED TO BECOME
// A Y.DOC WRITE.
//
// The worklet posts `{type:'sel', out, idx}` on every gate rising edge and the
// factory wrote it straight into `livePatch.nodes[id].params[selN]`. The rate
// of that write is therefore the rate of the CABLE, and `gate1..4` are ordinary
// signal inputs that a user is invited to patch anything into:
//
//     musical clock, 8 Hz        8 writes/s
//     LFO, 30 Hz                30 writes/s
//     AUDIO, 440 Hz saw        440 writes/s
//     AUDIO, 2 kHz sine       2000 writes/s      ← per output
//
// The selector advances on a 4-cycle so EVERY message changes the value and
// none is absorbed by the `!==` guard. On a shared rackspace that is thousands
// of synced param writes a second, plus a reconciler pass each, from one cable
// — the `cv-modulation-live-store-write-storm` failure class, reached through a
// documented use of a documented port.
//
// The selector genuinely IS persisted state ("the advanced position is saved
// like a knob turn"), so the answer is not "stop writing" — it is to write at a
// bounded rate and always write the LATEST value. This committer is pure and
// takes its clock and timer by injection, so the unit test drives it with no
// fake timers and no AudioContext.

/** Minimum spacing between store writes for ONE output. 50 ms caps an
 *  audio-rate gate at 20 writes/s per output while leaving any musical clock
 *  (a 16th at 300 bpm is 50 ms) writing through untouched on the leading
 *  edge. */
export const FOURPLEXER_COMMIT_INTERVAL_MS = 50;

export interface SelectorCommitterOptions {
  /** Monotonic milliseconds. */
  now: () => number;
  /** Schedule `fn` after `ms`; returns a handle for `cancel`. */
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** Actually write the index into the store. */
  commit: (out: number, idx: number) => void;
  intervalMs?: number;
}

export interface SelectorCommitter {
  /** The worklet announced `idx` for output `out`. */
  post(out: number, idx: number): void;
  /** Write any pending values immediately (call on dispose, so the final
   *  selector position always persists even if it landed mid-window). */
  flush(): void;
  dispose(): void;
}

/**
 * Throttle per output with a LEADING and a TRAILING edge.
 *
 * Leading: the first announcement after a quiet period commits immediately, so
 * a musical clock feels instant and behaves exactly as it did before.
 * Trailing: anything arriving inside the window is remembered, and the LAST
 * value in that window is committed when it closes — so the store always
 * converges on where the selector actually ended up, never on a stale
 * intermediate position.
 */
export function createSelectorCommitter(opts: SelectorCommitterOptions): SelectorCommitter {
  const interval = opts.intervalMs ?? FOURPLEXER_COMMIT_INTERVAL_MS;
  const pending = new Map<number, number>();
  const lastCommitAt = new Map<number, number>();
  let timer: unknown = null;
  let disposed = false;

  function commitOne(out: number, idx: number, at: number): void {
    lastCommitAt.set(out, at);
    pending.delete(out);
    opts.commit(out, idx);
  }

  function drain(): void {
    timer = null;
    if (disposed) return;
    const at = opts.now();
    let soonest = Infinity;
    for (const [out, idx] of [...pending]) {
      const last = lastCommitAt.get(out) ?? -Infinity;
      const due = last + interval;
      if (at >= due) commitOne(out, idx, at);
      else soonest = Math.min(soonest, due - at);
    }
    // An output whose window has not closed yet keeps the timer alive.
    if (pending.size > 0 && soonest !== Infinity) {
      timer = opts.schedule(drain, Math.max(1, Math.ceil(soonest)));
    }
  }

  return {
    post(out, idx) {
      if (disposed) return;
      const at = opts.now();
      const last = lastCommitAt.get(out) ?? -Infinity;
      if (at - last >= interval) {
        commitOne(out, idx, at);
        return;
      }
      pending.set(out, idx);
      if (timer === null) {
        timer = opts.schedule(drain, Math.max(1, Math.ceil(last + interval - at)));
      }
    },
    flush() {
      if (disposed) return;
      const at = opts.now();
      for (const [out, idx] of [...pending]) commitOne(out, idx, at);
      if (timer !== null) {
        opts.cancel(timer);
        timer = null;
      }
    },
    dispose() {
      disposed = true;
      pending.clear();
      if (timer !== null) {
        opts.cancel(timer);
        timer = null;
      }
    },
  };
}
