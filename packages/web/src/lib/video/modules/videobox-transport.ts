// packages/web/src/lib/video/modules/videobox-transport.ts
//
// Pure-functional transport helpers for VIDEOBOX: the varispeed knob map,
// the START/END playback-window logic, END-CV normalling, and the
// loop-vs-one-shot decision at the end of the window.
//
// These are split out so the math is unit-coverable without a real
// HTMLVideoElement — the card wires the results into <video>.playbackRate
// + currentTime each frame, and the engine module declares the matching
// params. Keeping the rules here means a single source of truth that both
// the card (runtime) and the tests assert against.

// ---------------------------------------------------------------------------
// 1. Varispeed knob → speed multiplier
// ---------------------------------------------------------------------------
//
// The speed knob behaves like an analog-clock face, but ASYMMETRIC: the
// dead-centre (12:00) is +1× forward, NOT 0. The two halves span different
// magnitudes:
//
//   knob 0.0  (7:00, full-left)   → -4×   (reverse, 4× speed)
//   knob 0.5  (12:00, centre)     → +1×   (normal forward)
//   knob 1.0  (5:00, full-right)  → +4×   (forward, 4× speed)
//
// Piecewise-linear so it hits exactly -4 / +1 / +4 at 0 / 0.5 / 1:
//   left  half [0, 0.5]:  -4  ..  +1   (span 5 over 0.5 → slope 10)
//   right half [0.5, 1]:  +1  ..  +4   (span 3 over 0.5 → slope 6)
//
// Note the slope differs across the centre (10 vs 6) — that asymmetry is
// intentional and is what produces the "-4..+1 left, +1..+4 right" feel.

export function speedKnobToMultiplier(knob: number): number {
  const k = Math.max(0, Math.min(1, knob));
  if (k < 0.5) {
    // -4 at 0 → +1 at 0.5
    return -4 + k * 10;
  }
  // +1 at 0.5 → +4 at 1.0
  return 1 + (k - 0.5) * 6;
}

// ---------------------------------------------------------------------------
// 2. CV summing for the speed knob
// ---------------------------------------------------------------------------
//
// CV is bipolar -1..+1 and (per the project convention) ±1 sweeps the param
// through its full range. The speed knob's natural range is the normalized
// 0..1 knob domain, so CV sums into the knob position (clamped to 0..1)
// BEFORE the piecewise map. ±1 CV therefore sweeps the full reverse→forward
// span centred on the user's knob setting.

export function effectiveSpeedKnob(knob: number, cv: number): number {
  // halfSpan of the 0..1 knob domain is 0.5, so cv*0.5 sweeps ±half-range.
  const v = knob + cv * 0.5;
  return Math.max(0, Math.min(1, v));
}

// ---------------------------------------------------------------------------
// 3. START / END window
// ---------------------------------------------------------------------------
//
// START + END are fractions of duration in [0, 1].
//   - START default 0 (full-left slider) = beginning; it is BOTH the play
//     start point AND the reset-to point.
//   - END default 1 (full-right slider) = end of video.
//
// CV semantics (bipolar -1..+1, summed into the slider, then clamped 0..1):
//   - START CV normals to 0 (unpatched ⇒ no offset, slider rules).
//   - END   CV normals to +1: an UNPATCHED end input must behave as
//     full-duration. We implement that by only summing CV when a cable is
//     connected; an unpatched END therefore stays at the slider's default 1.
//     When patched, the CV adds to the slider, so a bipolar LFO dipping
//     below 0 pulls the END point leftward (earlier). See
//     effectiveEndFraction below.

export interface PlaybackWindow {
  /** Window start in seconds (the reset-to point + play-from point). */
  startSec: number;
  /** Window end in seconds. */
  endSec: number;
  /** False when START >= END (empty window): no playback. */
  hasWindow: boolean;
}

/** Effective START fraction = slider + (connected ? cv : 0), clamped 0..1.
 *  START CV normals to 0, so an unpatched input contributes nothing. */
export function effectiveStartFraction(slider: number, cv: number, cvConnected: boolean): number {
  const v = slider + (cvConnected ? cv : 0);
  return clamp01(v);
}

/** Effective END fraction. END CV normals to +1 — i.e. an UNPATCHED end
 *  input means "play to the very end" (the slider default is 1). Only a
 *  connected cable contributes its bipolar offset; to pull the end earlier
 *  the user patches NEGATIVE CV. Result clamped 0..1. */
export function effectiveEndFraction(slider: number, cv: number, cvConnected: boolean): number {
  const v = slider + (cvConnected ? cv : 0);
  return clamp01(v);
}

/** Resolve the [start, end] window (in seconds) for a given duration and the
 *  effective start/end fractions. If start >= end the window is empty and
 *  hasWindow is false (caller holds the last frame / shows black + does not
 *  advance). A non-finite or zero duration also yields no window. */
export function resolveWindow(
  durationSec: number,
  startFraction: number,
  endFraction: number,
): PlaybackWindow {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { startSec: 0, endSec: 0, hasWindow: false };
  }
  const startSec = clamp01(startFraction) * durationSec;
  const endSec = clamp01(endFraction) * durationSec;
  // START dragged past END → empty window, no playback.
  const hasWindow = startSec < endSec;
  return { startSec, endSec, hasWindow };
}

// ---------------------------------------------------------------------------
// 4. Loop / one-shot at the window edge
// ---------------------------------------------------------------------------
//
// When the playhead reaches (or passes) END:
//   - LOOP     → jump back to START + keep playing.
//   - ONE-SHOT → stop (pause) at END.
// Reverse playback (negative speed) hits the START edge instead; the same
// rule applies mirrored (loop → jump to END; one-shot → stop at START).

export type EdgeAction =
  | { kind: 'none' }
  | { kind: 'loop'; seekTo: number }
  | { kind: 'stop'; clampTo: number };

/** Given the current position, the resolved window, play direction, and the
 *  loop flag, decide what to do at the window edge. `forward` is true when
 *  the effective speed is >= 0. */
export function decideEdgeAction(
  positionSec: number,
  window: PlaybackWindow,
  forward: boolean,
  loop: boolean,
): EdgeAction {
  if (!window.hasWindow) return { kind: 'none' };
  if (forward) {
    if (positionSec < window.endSec) return { kind: 'none' };
    return loop
      ? { kind: 'loop', seekTo: window.startSec }
      : { kind: 'stop', clampTo: window.endSec };
  }
  // Reverse: edge is the START point.
  if (positionSec > window.startSec) return { kind: 'none' };
  return loop
    ? { kind: 'loop', seekTo: window.endSec }
    : { kind: 'stop', clampTo: window.startSec };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
