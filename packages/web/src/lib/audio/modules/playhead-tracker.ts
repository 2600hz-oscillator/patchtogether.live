// packages/web/src/lib/audio/modules/playhead-tracker.ts
//
// Bridge between a sequencer's lookahead-scheduled step events and the visual
// "sounding now" highlight. Sequencers schedule emit events up to 200 ms in
// the future (LOOKAHEAD_S); naively setting `currentStep = stepIndex` after
// advancing the scheduler index makes the UI show the step that is ABOUT to
// play, not the step currently sounding — the classic off-by-one playhead lag
// that this helper exists to eliminate.
//
// Usage:
//   const playhead = createPlayheadTracker();
//   // In emitStep(idx, atTime, ...):
//   playhead.schedule(idx, atTime);
//   // In the host's read(key) hook:
//   if (key === 'currentStep') return playhead.currentAt(ctx.currentTime);
//   // On RESET (transport CV / play-edge / queued-slot swap):
//   playhead.reset();
//
// The tracker keeps a tiny FIFO of scheduled (idx, atTime) entries. On read,
// it walks the queue and returns the most recent entry whose atTime has
// already passed in audio time — i.e. the step the audio thread is actually
// playing. Entries that have aged out (older than the most recently sounding
// one) are dropped to keep the queue bounded.
//
// Why not just `setTimeout` to update `currentStep` at `atTime`? setTimeout
// is main-thread; under drag/render jank it can lag by 50–200 ms — exactly
// the kind of stutter we already absorb in the audio thread with the
// lookahead window. A queue + audio-time read is jitter-immune.

export interface ScheduledStep {
  idx: number;
  /** Audio-context time at which the step starts sounding. */
  atTime: number;
}

export interface PlayheadTracker {
  /** Record that step `idx` was scheduled to start at `atTime`. */
  schedule(idx: number, atTime: number): void;
  /** Return the step currently sounding at `now` (the most recent scheduled
   *  entry whose atTime <= now). Returns 0 if nothing has played yet. */
  currentAt(now: number): number;
  /** Drop all queued entries. Call on transport reset / play-edge / slot swap
   *  so the next schedule() starts a fresh playhead trail. */
  reset(): void;
  /** Test-only: snapshot of the internal queue. */
  __peek(): ReadonlyArray<ScheduledStep>;
}

/** Like PlayheadTracker but each scheduled entry carries an arbitrary
 *  payload (e.g. a note id). Used by SCORE, which highlights notes by id
 *  rather than by linear step index. */
export interface PlayheadTrackerOf<T> {
  schedule(value: T, atTime: number): void;
  /** Return the most recent payload whose atTime <= now, or `initial` if
   *  nothing has played yet. */
  currentAt(now: number, initial: T): T;
  reset(): void;
  __peek(): ReadonlyArray<{ value: T; atTime: number }>;
}

export function createPlayheadTracker(): PlayheadTracker {
  // Bound the queue so a long-running sequence doesn't accumulate forever.
  // 64 entries comfortably covers any LOOKAHEAD_S (200 ms) at any practical
  // BPM (300 bpm 16th-notes = 50 ms/step → 4 entries in flight). We GC
  // aggressively on every read past the leading edge, so this is mostly
  // a defensive cap.
  const MAX_ENTRIES = 64;
  const queue: ScheduledStep[] = [];
  let lastSounding = 0;

  return {
    schedule(idx, atTime) {
      queue.push({ idx, atTime });
      if (queue.length > MAX_ENTRIES) queue.splice(0, queue.length - MAX_ENTRIES);
    },
    currentAt(now) {
      // Walk forward, advancing lastSounding to the latest entry whose
      // atTime has passed. Discard everything strictly before that entry
      // (we never need to look backward).
      let dropTo = 0;
      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i]!;
        if (entry.atTime <= now) {
          lastSounding = entry.idx;
          dropTo = i;
        } else {
          break;
        }
      }
      if (dropTo > 0) queue.splice(0, dropTo);
      return lastSounding;
    },
    reset() {
      queue.length = 0;
      lastSounding = 0;
    },
    __peek() {
      return queue.slice();
    },
  };
}

/** Generic variant. Same semantics as createPlayheadTracker() but carries an
 *  arbitrary payload. Used by SCORE for note-id highlighting. */
export function createPlayheadTrackerOf<T>(): PlayheadTrackerOf<T> {
  const MAX_ENTRIES = 64;
  const queue: { value: T; atTime: number }[] = [];
  let lastSounding: T | undefined;

  return {
    schedule(value, atTime) {
      queue.push({ value, atTime });
      if (queue.length > MAX_ENTRIES) queue.splice(0, queue.length - MAX_ENTRIES);
    },
    currentAt(now, initial) {
      let dropTo = 0;
      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i]!;
        if (entry.atTime <= now) {
          lastSounding = entry.value;
          dropTo = i;
        } else {
          break;
        }
      }
      if (dropTo > 0) queue.splice(0, dropTo);
      return lastSounding === undefined ? initial : lastSounding;
    },
    reset() {
      queue.length = 0;
      lastSounding = undefined;
    },
    __peek() {
      return queue.slice();
    },
  };
}
