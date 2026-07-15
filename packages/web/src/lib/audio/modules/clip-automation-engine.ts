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
 */
export function stepRampPoints(
  events: readonly AutomationEvent[],
  stepIndex: number,
  laneDur: number,
  emitAt: number,
  interp: 'linear' | 'hold',
): RampPoint[] {
  const read = interp === 'hold' ? automationValueAt : automationLinearAt;
  const v0 = read(events, stepIndex);
  if (v0 == null) return []; // before first breakpoint → leave live value
  const out: RampPoint[] = [{ value: v0, at: emitAt, ramp: false }];
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
 * A recorder that arms, then PUNCHES IN when the clip playhead next wraps to its
 * start (loop boundary) and PUNCHES OUT one full loop later — the owner's
 * workflow: "start recording when the playhead goes off ... stop at the end of my
 * automation clip". Detects the wrap by watching the fractional-step playhead
 * decrease (len → 0). Pure state machine; the adapter feeds it the playhead each
 * tick and reacts to the returned transitions.
 */
export type RecordPhase = 'idle' | 'armed' | 'recording' | 'done';

export class QuantizedRecordWindow {
  private phase: RecordPhase = 'idle';
  private prevStep = -1;
  private startedAtWraps = 0;
  private wraps = 0;

  arm(): void {
    if (this.phase === 'idle' || this.phase === 'done') this.phase = 'armed';
  }
  disarm(): void {
    this.phase = 'idle';
    this.prevStep = -1;
    this.wraps = 0;
  }
  get state(): RecordPhase {
    return this.phase;
  }

  /**
   * Feed the current fractional-step playhead. Returns a transition:
   *  - 'punch-in'  : recording just began (armed → recording at a loop wrap)
   *  - 'punch-out' : one full loop elapsed (recording → done) — commit now
   *  - null        : no transition
   */
  advance(fracStep: number): 'punch-in' | 'punch-out' | null {
    // Wrap = the playhead moved backward past the loop boundary.
    const wrapped = this.prevStep >= 0 && fracStep < this.prevStep;
    this.prevStep = fracStep;
    if (wrapped) this.wraps++;

    if (this.phase === 'armed' && wrapped) {
      this.phase = 'recording';
      this.startedAtWraps = this.wraps;
      return 'punch-in';
    }
    if (this.phase === 'recording' && wrapped && this.wraps > this.startedAtWraps) {
      this.phase = 'done';
      return 'punch-out';
    }
    return null;
  }
}
