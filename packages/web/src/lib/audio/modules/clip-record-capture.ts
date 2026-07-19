// packages/web/src/lib/audio/modules/clip-record-capture.ts
//
// DETERMINISTIC live-record CAPTURE math for the dual-Launchpad KEYS recorder
// (redesign: .myrobots/plans/clipplayer-live-record-overdub-redesign-2026-07-19.md
// §4.1). PURE + engine-free: given a pad event's own timestamp + the recording
// lane's published audio-clock PHASE, it returns the NEAREST quantized step the
// note should land on — replacing the old "floor to the lagging 25 ms-stale
// audible integer step" (`getLanePlayhead`) that dropped a musician's
// anticipation onto the PREVIOUS step and skipped steps at fast tempo.
//
// WHY (owner problem 1a): the recorder read `getLanePlayhead` — the AUDIBLE,
// up-to-25 ms-stale integer step — and `Math.floor`ed onto it, so a note played
// a hair before a downbeat recorded on the step BEFORE it, and a note played
// mid-step never rounded to the nearer neighbour. Here we instead project the
// event's own time onto the audio clock (the same `performance.now()`→
// `AudioContext.currentTime` projection the MIDI bridges use, `midi-timing.ts`
// `measureCtxOffset`), convert to a FRACTIONAL step position from the lane's
// known phase, and round to the NEAREST grid step. This removes the staleness
// AND the floor bias in one move, and it is driven by the EVENT (read at the
// keypress), not the 25 ms poll — so fast tempo can't skip the capture.

import { measureCtxOffset } from '$lib/audio/midi-timing';

/** The recording lane's published audio-clock phase — enough to project a pad
 *  event's time onto a fractional step position. Published each scheduler tick
 *  by the clipplayer factory (see clip-lane-phase.ts) and read by the launchpad
 *  binding at each keypress. All times share the ONE main-thread clock pair
 *  (`AudioContext.currentTime` ↔ `performance.now()`), so the projection is
 *  coherent regardless of handler-dispatch lag. */
export interface LaneCapturePhase {
  /** The integer step whose gate is currently SOUNDING (audible), or -1 when
   *  the lane isn't sounding yet (nothing scheduled has elapsed). */
  anchorStep: number;
  /** The `AudioContext.currentTime` (s) at which `anchorStep`'s gate was
   *  scheduled to sound (the audible onset time of the current step). */
  anchorTime: number;
  /** The lane's current step DURATION (s) — bpm × step-div × per-lane rate/div. */
  laneDur: number;
  /** The clip's loop length in steps (wrap modulus). */
  lengthSteps: number;
  /** `AudioContext.currentTime` (s) sampled at publish — pairs with `perfNow`
   *  to recover the ctx↔perf offset (both tick at real-time). */
  ctxTime: number;
  /** `performance.now()` (ms) sampled at the SAME publish instant as `ctxTime`. */
  perfNow: number;
}

/** Default record-quantize grid, in STEPS. A note clip's steps ARE the 1/16
 *  grid, so 1 step = 1/16 = the owner-locked default ("quantize = 1/16 grid, ON
 *  by default"). A coarser value (2 = 1/8, 4 = 1/4) snaps to every Nth step; the
 *  recorder passes this so the grid stays a single settable knob. */
export const RECORD_GRID_STEPS_DEFAULT = 1;

/**
 * Project a pad event (its `performance.now()`-relative ms timestamp) onto a
 * FRACTIONAL step position on the recording lane, from the lane's published
 * phase. Returns null when the phase can't support a projection (lane silent,
 * bogus durations, or the event projects absurdly far outside one loop — a
 * stale/backgrounded burst), so the caller falls back to the audible step.
 *
 * Coherent under handler-dispatch lag: `eventMs` and `phase.perfNow` are BOTH
 * `performance.now()` readings, and `phase.ctxTime`/`phase.perfNow` recover the
 * ctx↔perf offset, so the event's true audio-clock time is recovered no matter
 * how late the handler ran.
 */
export function eventFracStep(eventMs: number, phase: LaneCapturePhase | null): number | null {
  if (!phase) return null;
  if (phase.anchorStep < 0) return null;
  if (!(phase.laneDur > 0) || !(phase.lengthSteps > 0)) return null;
  if (!Number.isFinite(eventMs)) return null;
  const ctxOffsetS = measureCtxOffset(phase.ctxTime, phase.perfNow);
  const eventAudioTime = eventMs / 1000 + ctxOffsetS;
  const deltaSteps = (eventAudioTime - phase.anchorTime) / phase.laneDur;
  if (!Number.isFinite(deltaSteps)) return null;
  // Guard a bogus projection: a real live keypress is within a step or two of
  // the anchor. A |delta| beyond one loop means a stale/backgrounded-tab burst
  // or a wrong clock domain — fall back to the audible step (null).
  if (Math.abs(deltaSteps) > phase.lengthSteps + 1) return null;
  return phase.anchorStep + deltaSteps;
}

/**
 * Round a fractional step position to the NEAREST step on a `gridSteps` grid,
 * wrapped into `[0, lengthSteps)`. This is the real record-quantize: a note
 * played a hair EARLY rounds UP to the intended step (never floored back onto
 * the previous one — owner problem 1a). `gridSteps` ≥ 1; a coarser grid snaps
 * to every Nth step. PURE.
 */
export function quantizeStep(
  fracStep: number,
  lengthSteps: number,
  gridSteps: number = RECORD_GRID_STEPS_DEFAULT,
): number {
  const len = Math.max(1, Math.round(lengthSteps));
  const g = Math.max(1, Math.round(gridSteps));
  const snapped = Math.round(fracStep / g) * g;
  return ((snapped % len) + len) % len;
}

/**
 * The full capture: project the event → fractional step → nearest quantized
 * step, or null when the phase can't support a projection (caller falls back to
 * the audible integer step). `gridSteps` defaults to the 1/16 (=1 step) grid.
 */
export function captureStep(
  eventMs: number,
  phase: LaneCapturePhase | null,
  gridSteps: number = RECORD_GRID_STEPS_DEFAULT,
): number | null {
  const frac = eventFracStep(eventMs, phase);
  if (frac === null) return null;
  return quantizeStep(frac, phase!.lengthSteps, gridSteps);
}
