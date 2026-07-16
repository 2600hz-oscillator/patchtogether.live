// packages/web/src/lib/audio/modules/clip-automation-engine.ts
//
// The real-time record + playback CORES for the clip automation lane (task #183),
// kept PURE + injectable so they unit-test deterministically (fake clock, fake
// param driver) — no AudioContext / Yjs needed. The clipplayer tick() adapter
// wires these to the real engine (`PatchEngine.setParam`, store tap) + clock.
//
// PLAYBACK is scheduled through the SAME per-lane while-loop the note lanes use
// (integer step at `emitAt` over `laneDur`, up to LOOKAHEAD_S ahead), so
// automation is sample-accurate + jank-immune + time-aligned to the notes — the
// non-negotiable fix the adversarial review demanded (applying at `currentTime`
// stair-steps + desyncs). `stepRampPoints` returns the ramp targets for one step,
// preserving SUB-step breakpoints (a fast wiggle inside one long/slow step).
//
// RECORD buffers to JS memory through a decimation gate (min |Δvalue| OR max Δt)
// so a continuous knob sweep can't flood the durable store; the pass commits ONCE
// (mergeAutomationOverdub → whole-clip plain reassign) at punch-out.

import {
  automationValueAt,
  automationLinearAt,
  type AutomationEvent,
  type AutomationTrack,
} from './clip-types';

// ---------------------------------------------------------------------------
// PLAYBACK — lookahead ramp scheduling (pure)
// ---------------------------------------------------------------------------

/** One scheduled param write: `value` at audio time `at`. `ramp` true ⇒ a
 *  linear ramp to it (continuous); false ⇒ a hard step (discrete/hold). */
export interface RampPoint {
  value: number;
  at: number;
  ramp: boolean;
}

/** De-zipper glide across an unavoidable automation SEAM (loop-wrap or a
 *  clip-switch INTO an automating clip). 12 ms — within the 8–15 ms window the
 *  param-jump policy specifies: long enough to kill the click, short enough to
 *  read as instant. The step-0 anchor becomes a short `linearRamp` from the
 *  incoming value instead of a hard `setValueAtTime` step. */
export const SEAM_GLIDE_S = 0.012;

/**
 * Ramp targets to schedule for ONE track across the integer step
 * `[stepIndex, stepIndex+1)` — emitted at audio time `emitAt`, lasting `laneDur`.
 *
 *  - `interp='hold'` (or a discrete param): hard `setValueAtTime` steps.
 *  - else linear: a ramp anchor at the step start + a ramp to each SUB-step
 *    breakpoint at its fractional audio time + a ramp to the value at the next
 *    step boundary (so the segment to the next step is smooth).
 *
 * Returns [] when the envelope has no value yet at this step (before the first
 * breakpoint — the param is left at its live value). All values are the stored
 * normalized 0..1; the caller denormalizes (curve-aware) before driving.
 *
 * SEAM GLIDE: `seamGlideS > 0` marks this step as the entry to an unavoidable
 * discontinuity — a LOOP-WRAP (last-step→step-0) or a CLIP-SWITCH INTO an
 * automating clip. Instead of the hard `setValueAtTime(v0, emitAt)` anchor
 * (which clicks whenever the loop's start value != its end value — the norm with
 * the owner's coprime/different-length loops), the anchor becomes a short
 * `linearRamp` reaching `v0` at `emitAt + seamGlideS`, gliding from the incoming
 * value. Only meaningful for LINEAR tracks — a discrete/hold param steps on
 * purpose, so the flag is ignored there.
 */
export function stepRampPoints(
  events: readonly AutomationEvent[],
  stepIndex: number,
  laneDur: number,
  emitAt: number,
  interp: 'linear' | 'hold',
  seamGlideS = 0,
): RampPoint[] {
  const read = interp === 'hold' ? automationValueAt : automationLinearAt;
  const v0 = read(events, stepIndex);
  if (v0 == null) return []; // before first breakpoint → leave live value
  // De-zipper the seam: a short ramp to v0 instead of a hard step. Clamp the
  // glide below half the step AND below the earliest sub-step breakpoint, so
  // the ramp anchor never overruns a following point (which would schedule the
  // envelope out of order).
  let glide = 0;
  if (interp === 'linear' && seamGlideS > 0) {
    let earliestSub = laneDur; // next-step boundary is the hard ceiling
    for (const e of events) {
      if (e.step > stepIndex && e.step < stepIndex + 1) {
        earliestSub = Math.min(earliestSub, (e.step - stepIndex) * laneDur);
      }
    }
    glide = Math.min(seamGlideS, laneDur * 0.5, earliestSub * 0.5);
  }
  const out: RampPoint[] = [{ value: v0, at: emitAt + glide, ramp: glide > 0 }];
  if (interp === 'hold') {
    // Step to each breakpoint inside (stepIndex, stepIndex+1] at its time.
    for (const e of events) {
      if (e.step > stepIndex && e.step <= stepIndex + 1) {
        out.push({ value: e.value, at: emitAt + (e.step - stepIndex) * laneDur, ramp: false });
      }
    }
    return dedupeByTime(out);
  }
  // linear: ramp through each sub-step breakpoint, then to the next step's value.
  for (const e of events) {
    if (e.step > stepIndex && e.step < stepIndex + 1) {
      out.push({ value: e.value, at: emitAt + (e.step - stepIndex) * laneDur, ramp: true });
    }
  }
  const v1 = automationLinearAt(events, stepIndex + 1);
  if (v1 != null) out.push({ value: v1, at: emitAt + laneDur, ramp: true });
  return dedupeByTime(out);
}

/** Drop points that collide on time (keep the last), preserving order — two
 *  writes at the same audio time would fight; the later value wins. */
function dedupeByTime(points: RampPoint[]): RampPoint[] {
  const out: RampPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.at - p.at) < 1e-9) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** The interpolation mode for a track given its explicit `interp` and the
 *  target param's curve (discrete params default to hold — a fractional ramp
 *  through integer steps would be wrong). */
export function trackInterp(
  track: Pick<AutomationTrack, 'interp'>,
  paramCurve: string | undefined,
): 'linear' | 'hold' {
  if (track.interp) return track.interp;
  return paramCurve === 'discrete' ? 'hold' : 'linear';
}

// ---------------------------------------------------------------------------
// RECORD — decimation gate + ring buffer (stateful, injectable)
// ---------------------------------------------------------------------------

export interface RecordGateOpts {
  /** Min |Δvalue| (normalized 0..1) to emit a new point mid-sweep. */
  minValueDelta?: number;
  /** Max step gap before a point is emitted even if the value barely moved (so
   *  slow drifts still get sampled). In fractional STEPS (timebase-independent). */
  maxStepGap?: number;
  /** For a discrete param, gate in value-UNITS instead (Δ≥1 step) — pass the
   *  normalized size of one unit so a single-unit move isn't swallowed. */
  unitDelta?: number;
}

const DEFAULT_MIN_VALUE_DELTA = 0.004; // ~0.4% of range (below 7-bit MIDI 1/127)
const DEFAULT_MAX_STEP_GAP = 0.5; // half a step

/**
 * Real-time decimation gate for one recorded track. Feed it `(fracStep, value)`
 * each tick while armed; it keeps a point only when the value moved enough OR too
 * long passed — bounding density (~30 pts/s) so the committed array stays small.
 * Always keeps the FIRST and (via `close`) the LAST sample so the pass is anchored.
 */
export class RecordGate {
  private pts: AutomationEvent[] = [];
  private lastVal = NaN;
  private lastStep = -Infinity;
  private last: AutomationEvent | null = null;
  private readonly minDelta: number;
  private readonly maxGap: number;

  constructor(opts: RecordGateOpts = {}) {
    this.minDelta = opts.unitDelta != null ? Math.max(opts.unitDelta * 0.5, 1e-6) : (opts.minValueDelta ?? DEFAULT_MIN_VALUE_DELTA);
    this.maxGap = opts.maxStepGap ?? DEFAULT_MAX_STEP_GAP;
  }

  /** Feed one sample. Returns true if it was committed as a breakpoint. */
  sample(fracStep: number, value: number): boolean {
    const v = Math.max(0, Math.min(1, value));
    this.last = { step: fracStep, value: v };
    const first = this.pts.length === 0;
    const movedEnough = Math.abs(v - this.lastVal) >= this.minDelta;
    const gappedEnough = fracStep - this.lastStep >= this.maxGap;
    if (first || movedEnough || gappedEnough) {
      this.pts.push({ step: fracStep, value: v });
      this.lastVal = v;
      this.lastStep = fracStep;
      return true;
    }
    return false;
  }

  /** Finish the pass: ensure the final sample is recorded (so a slow tail isn't
   *  clipped), then return the buffered points (step-sorted). */
  close(): AutomationEvent[] {
    if (this.last && (this.pts.length === 0 || this.pts[this.pts.length - 1]!.step !== this.last.step)) {
      this.pts.push(this.last);
    }
    return this.pts.slice().sort((a, b) => a.step - b.step);
  }

  get length(): number {
    return this.pts.length;
  }
}

// ---------------------------------------------------------------------------
// RECORD WINDOW — quantized punch-in / punch-out (pure helpers)
// ---------------------------------------------------------------------------

/**
 * CONTINUOUS-OVERDUB recorder (owner's chosen model, 2026-07-15). Arms, PUNCHES
 * IN when the automation clip's OWN playhead next wraps to its start (a clean
 * first pass, quantized to THIS clip's loop — never the song bar), then keeps
 * recording EVERY loop: each wrap is a pass boundary (commit the just-finished
 * pass + start a fresh one) and it KEEPS GOING until the user disarms (manual
 * stop). There is NO auto punch-out / no 'done' phase — that stuck-light machinery
 * is gone (the one-shot punch-out that never cleared arm was the stuck-light bug).
 *
 * Boundaries key off the automation clip's OWN loop period (its fractional-step
 * playhead decreasing len → 0), so a coprime-length clip drifts against the other
 * clips by design — the generative-desync feature; nothing realigns it to a bar.
 *
 * Pure state machine; the adapter feeds it the playhead each tick and reacts to
 * the returned transitions.
 */
export type RecordPhase = 'idle' | 'armed' | 'recording';

export class QuantizedRecordWindow {
  private phase: RecordPhase = 'idle';
  private prevStep = -1;

  arm(): void {
    if (this.phase === 'idle') this.phase = 'armed';
  }
  /** Stop recording (manual stop = press ARM again). Returns true iff a pass was
   *  IN FLIGHT (recording) so the caller commits the PARTIAL pass; false when it
   *  was only armed/idle (nothing captured → nothing to commit). */
  disarm(): boolean {
    const wasRecording = this.phase === 'recording';
    this.phase = 'idle';
    this.prevStep = -1;
    return wasRecording;
  }
  get state(): RecordPhase {
    return this.phase;
  }

  /**
   * Feed the current fractional-step playhead. Returns a transition:
   *  - 'punch-in' : recording just began (armed → recording at the clip's own wrap)
   *  - 'wrap'     : a loop wrapped WHILE recording — commit this pass + start the
   *                 next one (continuous overdub); recording CONTINUES
   *  - null       : no transition
   */
  advance(fracStep: number): 'punch-in' | 'wrap' | null {
    // Wrap = the playhead moved backward past the clip's OWN loop boundary.
    const wrapped = this.prevStep >= 0 && fracStep < this.prevStep;
    this.prevStep = fracStep;

    if (this.phase === 'armed' && wrapped) {
      this.phase = 'recording';
      return 'punch-in';
    }
    if (this.phase === 'recording' && wrapped) {
      return 'wrap'; // stay recording — overdub continues
    }
    return null;
  }
}
