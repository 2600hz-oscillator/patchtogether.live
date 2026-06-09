// packages/web/src/lib/audio/modules/twotracks-transport.ts
//
// TWOTRACKS transport state machine — pure (no AudioContext deps), unit-testable.
//
// Two ORTHOGONAL axes:
//   Axis 1 — write mode: 'destructive' (REC) vs 'additive' (OVERDUB).
//             Controlled by overdubFlag. Independent of loop mode.
//   Axis 2 — loop vs one-shot: controlled by 'mode' param.
//             Independent of overdub.
//
// All 4 combinations are valid:
//   loop  + destructive → records loop, overwrites each pass
//   loop  + additive    → records loop, adds/blends each pass
//   oneshot + destructive → records one pass then plays, no decay-blend
//   oneshot + additive  → single additive pass then stops (PLAY)
//
// States:
//   idle    — no playback, no recording
//   play    — playback running (no write)
//   armed   — waiting for cursor to cross `start` before entering rec/overdub
//   rec     — destructive write + playback
//   overdub — additive write + playback
//
// Events that drive transitions:
//   start()     — begin play (from idle or armed; no-op from play)
//   stop()      — halt everything → idle
//   arm()       — enter ARMED (waits for loop-start crossing to begin recording)
//   beginRec()  — immediately enter REC or OVERDUB (based on overdubFlag)
//   cursorCrossedStart() — called by the DSP loop when cursor wraps to start:
//                          fires the ARMED→rec/overdub transition, and applies
//                          decay for overdub new-pass logic
//   reachedEnd()  — called in one-shot mode: rec/overdub → play; play → idle
//   toggleOverdub() — flip overdubFlag; swap rec↔overdub if currently recording
//
// This module is a PURE state machine with no side effects. The caller
// (the worklet or a unit test) drives it by feeding events; it returns a
// new state object each time (functional update, no mutation).

/** The write mode axis. */
export type WriteMode = 'destructive' | 'additive';

/** The loop mode axis (mirrors the `mode` AudioParam: 0=one-shot, 1=loop). */
export type LoopMode = 'loop' | 'oneshot';

/** The transport state. */
export type TapeState = 'idle' | 'play' | 'armed' | 'rec' | 'overdub';

export interface TwoTracksTransport {
  /** Current state. */
  state: TapeState;
  /** Write mode flag. True = additive (overdub). False = destructive (rec). */
  overdubFlag: boolean;
  /** The loop/oneshot axis. */
  loopMode: LoopMode;
  /** Whether a decay pass is pending at the next recording start. */
  pendingDecay: boolean;
}

/** Create a fresh idle transport. */
export function createTransport(loopMode: LoopMode = 'loop'): TwoTracksTransport {
  return {
    state: 'idle',
    overdubFlag: false,
    loopMode,
    pendingDecay: false,
  };
}

/** Transition: begin play. No-op from 'play'. From 'idle' → 'play'. */
export function transportPlay(t: TwoTracksTransport): TwoTracksTransport {
  if (t.state === 'play') return t;
  if (t.state === 'idle') return { ...t, state: 'play' };
  return t; // armed/rec/overdub stay as-is
}

/** Transition: stop everything → idle. */
export function transportStop(t: TwoTracksTransport): TwoTracksTransport {
  return { ...t, state: 'idle', pendingDecay: false };
}

/** Transition: enter ARMED — next cursor-crosses-start fires rec/overdub. */
export function transportArm(t: TwoTracksTransport): TwoTracksTransport {
  if (t.state === 'rec' || t.state === 'overdub') return t; // recording already → no-op
  return { ...t, state: 'armed', pendingDecay: true };
}

/**
 * Transition: immediately begin recording (no arm wait).
 * Enters REC (destructive) or OVERDUB (additive) based on overdubFlag.
 * In oneshot mode, resets the decay pending flag so it fires once per pass.
 */
export function transportBeginRec(t: TwoTracksTransport): TwoTracksTransport {
  const next: TapeState = t.overdubFlag ? 'overdub' : 'rec';
  return { ...t, state: next, pendingDecay: true };
}

/**
 * Cursor crossed `start` (loop wrap or armed-trigger).
 * - ARMED → enters rec/overdub (fire!)
 * - OVERDUB (loop mode) → apply decay for next pass (set pendingDecay)
 * - REC (loop mode) → no decay needed (destructive overwrites)
 */
export function transportCursorCrossedStart(t: TwoTracksTransport): TwoTracksTransport {
  if (t.state === 'armed') {
    const next: TapeState = t.overdubFlag ? 'overdub' : 'rec';
    return { ...t, state: next, pendingDecay: true };
  }
  if (t.state === 'overdub' && t.loopMode === 'loop') {
    // Start of a new overdub pass → decay will be applied.
    return { ...t, pendingDecay: true };
  }
  return t;
}

/**
 * Cursor reached `end` (one-shot boundary).
 * - rec/overdub → PLAY (recording pass complete)
 * - play → IDLE (playback pass complete)
 * - loop mode: no-op (cursor wraps, handled by cursorCrossedStart)
 */
export function transportReachedEnd(t: TwoTracksTransport): TwoTracksTransport {
  if (t.loopMode === 'loop') return t; // loop wraps, not stops
  if (t.state === 'rec' || t.state === 'overdub') {
    return { ...t, state: 'play', pendingDecay: false };
  }
  if (t.state === 'play') {
    return { ...t, state: 'idle', pendingDecay: false };
  }
  return t;
}

/**
 * Toggle the overdub flag.
 * - If currently in REC → enter OVERDUB.
 * - If currently in OVERDUB → enter REC.
 * - Otherwise just flip the flag for next recording.
 */
export function transportToggleOverdub(t: TwoTracksTransport): TwoTracksTransport {
  const next = !t.overdubFlag;
  let state = t.state;
  if (state === 'rec') state = 'overdub';
  else if (state === 'overdub') state = 'rec';
  return { ...t, overdubFlag: next, state };
}

/**
 * Consume the pendingDecay flag (returns true if decay should be applied,
 * then clears it). Call this at the start of a new recording pass.
 */
export function transportConsumePendingDecay(
  t: TwoTracksTransport,
): { transport: TwoTracksTransport; shouldDecay: boolean } {
  if (t.pendingDecay) {
    return { transport: { ...t, pendingDecay: false }, shouldDecay: true };
  }
  return { transport: t, shouldDecay: false };
}

/**
 * Change the loop mode axis. If currently in one-shot and switching to loop,
 * transport stays in its current state (no forced transition).
 */
export function transportSetLoopMode(
  t: TwoTracksTransport,
  loopMode: LoopMode,
): TwoTracksTransport {
  return { ...t, loopMode };
}

/** Compute the decay factor from the [0..1] decay param.
 *  0 → 0.90 (gentle), 1 → 0.50 (heavy). */
export function computeDecayFactor(decayParam: number): number {
  const clamped = Math.max(0, Math.min(1, decayParam));
  return 0.90 - clamped * 0.40;
}

/** Whether the transport is actively writing (rec or overdub state). */
export function isRecording(t: TwoTracksTransport): boolean {
  return t.state === 'rec' || t.state === 'overdub';
}

/** Whether the transport is producing audio (any state except idle). */
export function isActive(t: TwoTracksTransport): boolean {
  return t.state !== 'idle';
}
