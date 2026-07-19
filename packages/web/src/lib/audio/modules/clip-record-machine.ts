// packages/web/src/lib/audio/modules/clip-record-machine.ts
//
// The KEYS live-record STATE MACHINE — a PURE view + transition set over the
// synced `NoteRecState` (`clip-types.ts`). Redesign §2.1: a real
//   idle → armed → recording → overdubbing → (stop) idle
// machine with ARMING DECOUPLED from the capture instant. The launchpad binding
// owns the side effects (Y.Doc writes, transport auto-start, audition); this
// module owns the DECISIONS so they can be unit-pinned without an engine.
//
// WHY (owner problem 1b): the old code punched in ONLY when the 25 ms poll
// happened to observe step 0 — so a skipped step 0 at fast tempo meant recording
// silently never started. The machine here punches in on the FIRST of {a note is
// played, a loop wrap is observed} (Deluge §1 "capture starts on the note"), so
// arming reliably becomes recording regardless of poll phase.
//
// The `overdub` flag no longer gates a per-step ERASE (the removed
// "replace-as-you-play" — owner-locked: overdub is ADDITIVE LAYERING, erase is a
// separate explicit gesture). Both `recording` and `overdubbing` ADD notes; the
// distinction is only the loop-length semantics (first-pass-sets-length vs fixed
// loop) + the endless-vs-one-pass intent surfaced on the cursor.

import type { NoteRecState } from './clip-types';

/** The four record phases the cursor + LEDs render. */
export type RecPhase = 'idle' | 'armed' | 'recording' | 'overdubbing';

/** Derive the record phase from the synced state. `overdubbing` is a sub-state
 *  of recording (additive layering onto a fixed loop). PURE. */
export function recPhase(s: NoteRecState | null | undefined): RecPhase {
  if (!s) return 'idle';
  if (s.recording) return s.overdub ? 'overdubbing' : 'recording';
  if (s.armed) return 'armed';
  return 'idle';
}

/** Actively capturing notes into the clip (recording OR overdubbing). */
export function isCapturing(s: NoteRecState | null | undefined): boolean {
  return !!s && s.recording;
}

/**
 * Did the audible playhead cross the loop wrap between two successive polled
 * integer steps? True when the step went BACKWARDS (…→len-1→0→…), which catches
 * a wrap even when the 25 ms poll SKIPPED step 0 at fast tempo (owner problem
 * 1b — the old `step === 0 && prev !== 0` missed a skipped step 0 and never
 * punched in). `prevStep < 0` (first service) is never a wrap. PURE.
 */
export function crossedLoopWrap(prevStep: number, step: number): boolean {
  if (prevStep < 0 || step < 0) return false;
  return step < prevStep;
}

/**
 * ARM transition (KEYS/QUEUE-REC tap): idle → armed, or re-tap while armed →
 * cancel (armed → idle). Returns the patch to apply, or null for "no state
 * change" (already recording — arming is a no-op there; EXIT stops a take, not
 * arm). Capture does NOT begin here — that is the whole point of the decoupling.
 */
export function armTransition(s: NoteRecState | null | undefined): Partial<NoteRecState> | null {
  if (!s) return null;
  if (s.recording) return null; // recording: arm is a no-op (EXIT stops it)
  if (s.armed) return { armed: false }; // re-tap cancels the arm
  return { armed: true };
}

/**
 * PUNCH-IN transition: armed → recording. Fired by the FIRST of a played note
 * or an observed loop wrap (arm-decoupled capture). Returns the patch, or null
 * if not armed / already recording (idempotent — a note and a wrap in the same
 * window won't double-punch). The `overdub` flag is PRESERVED (set at entry).
 */
export function punchInTransition(s: NoteRecState | null | undefined): Partial<NoteRecState> | null {
  if (!s) return null;
  if (!s.armed || s.recording) return null;
  return { armed: false, recording: true };
}

/**
 * STOP transition: recording/armed → idle-in-KEYS (armed:false, recording:false).
 * Returns the patch, or null when already idle. (The launchpad additionally
 * flushes held-note spans + clears transient capture state; those are side
 * effects, not machine state.)
 */
export function stopTransition(s: NoteRecState | null | undefined): Partial<NoteRecState> | null {
  if (!s) return null;
  if (!s.armed && !s.recording) return null;
  return { armed: false, recording: false };
}

/** Result of toggling OVERDUB while in KEYS. `stopAtWrap` tells the launchpad to
 *  finish the current loop then stop (owner: an endless overdub toggled OFF
 *  mid-record stops cleanly at the loop end). */
export interface OverdubToggle {
  patch: Partial<NoteRecState>;
  stopAtWrap: boolean;
}

/**
 * OVERDUB toggle: flips the additive-layer intent. When toggled ON→OFF WHILE
 * overdubbing, the take finishes the current loop then stops (`stopAtWrap`).
 * Every other toggle just flips the flag. PURE — the launchpad applies the patch
 * + honours `stopAtWrap` in its wrap servicing.
 */
export function overdubToggle(s: NoteRecState | null | undefined): OverdubToggle | null {
  if (!s) return null;
  const next = !s.overdub;
  const stopAtWrap = s.recording && s.overdub && !next; // ON→OFF mid-record
  return { patch: { overdub: next }, stopAtWrap };
}
