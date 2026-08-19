// packages/web/src/lib/ui/modules/charlottes-echos-face-model.ts
//
// The PURE model behind the CHARLOTTE'S ECHOS faceplate — five derived values
// and the arithmetic that makes none of them a knob relabelled.
//
// WHY A MODEL FOR A FIVE-KNOB DELAY. Because the five knobs cannot say the
// three things that decide what this module DOES, and every one of them is a
// JOIN no single readback can perform:
//
//   TAIL    how long one hit rings — or whether it ever stops. The four stages
//           are in SERIES and the in-loop tanh DRIVE is a function of DECAY, so
//           the loop gain is `FEEDBACK · 0.995 · (1 + DECAY·(1+stage)·0.8)`:
//           a FEEDBACK readback is blind to DECAY and a DECAY readback is blind
//           to FEEDBACK, and past the point where that product reaches 1 the
//           module never stops at all. DELAY is the third input — not to
//           WHETHER it stops, but to HOW FAST (the round trip is DELAY/4).
//   CLIMB   the ascending shimmer, in CENTS. Content that traverses stages 1-3
//           is transposed by (1+PITCH)^(1+2+3), so the dial's `0.10` is a
//           +990 ¢ climb — most of an octave — and nothing on a 0..0.2 linear
//           scale says so.
//   SPACING the EFFECTIVE first-echo time. It is DELAY exactly (measured ratio
//           1.000 from 3 ms up) — until PITCH leaves 0, at which point the
//           three engaged VarispeedShifters each insert half a grain window and
//           the first echo jumps +45 ms. A `paramId: 'delay'` readout prints
//           the same number on both sides of that step and is wrong by 45 ms on
//           one of them.
//
// …plus two sidebar numbers that are DIFFERENT KINDS OF NUMBER on purpose:
//   LOOP GAIN  the closed form above, exactly derivable from the source.
//   MARGIN     how far the two dials are from the boundary, in DIAL UNITS —
//              the number you act on, in the units of the thing you turn.
//
// ⚠ WHAT THE LAW IS, AND WHAT IT IS NOT. `ceLoopGain` is the SMALL-SIGNAL gain
// of one stage's own feedback loop: `DriveStage` computes `tanh(y · (1 +
// driveGain))`, whose derivative at y = 0 is `1 + driveGain`, and
// `charlottes-echos.ts` sets `driveGain = decay · (1 + k) · 0.8`. It therefore
// IGNORES the large-signal compression of the same tanh, the tone filter's
// in-band loss and the eased read pointer. Measured against the shipping
// worklet the linearised rate is right to about ±25 % and the STABILITY
// BOUNDARY it predicts (gain = 1) is exact at every DELAY — both are re-derived
// from the real processor on every run by
// `art/scenarios/charlottes-echos/face-law.test.ts`, so a DSP change turns
// these claims RED rather than leaving the faceplate insisting on the old law.
//
// ⚠ AND THE BOUNDARY IS *NOT* A FUNCTION OF `delay`. The batch-6 spec asserted
// that it was, off a table bisected with a LEVEL threshold ("is the last 2 s of
// a 12 s render above −100 dBFS"). That instrument cannot separate "does not
// decay" from "decays slowly", and a longer tape decays slower in wall-clock
// time by construction — so it reported a boundary sliding from 0.318 to 0.174
// of DECAY across the DELAY travel, and heading to ~0 at 1.5 s. Re-measured
// with a RATE instrument (dB/s between two late windows, which is invariant to
// how long you waited) the boundary sits at loop gain 1.000 at 0.02 s, 0.15 s,
// 0.6 s AND 1.5 s. The margin below is a closed form because of that
// correction; had the spec been believed it would have been a 3-D interpolation
// over a measurement artifact.
//
// PURE: no DOM, no engine, no store, no fs. Every function is a total function
// of the live params.

import { CHARLOTTES_ECHOS_RANGES, charlottesEchosDef } from '$lib/audio/modules/charlottes-echos';

// ── THE DSP's OWN CONSTANTS ─────────────────────────────────────────────────
//
// ⚠ THESE ARE RE-TYPED FROM THE DSP, DELIBERATELY, AND THAT IS WHY THE ART
// SCENARIO EXISTS. The worklet entry (`packages/dsp/src/charlottes-echos.ts`)
// cannot export them: a top-level `export` in a worklet ENTRY survives esbuild
// into `dist/<name>.js`, which the ART harness evals as a classic script, and
// moving them into a new shared lib would change the entry's own bytes and
// re-pin all three ART baselines for a UI change. So the numbers are copied
// with their source line named — and every one of them is asserted against the
// SHIPPING processor by measurement in
// `art/scenarios/charlottes-echos/face-law.test.ts`, which is a stronger check
// than an import: an import proves the constants match, a measurement proves
// the LAW does.

/** `NUM_STAGES` — charlottes-echos.ts. Four AnalogDelayCores in SERIES. */
export const CE_STAGES = 4;
/** `FEEDBACK_MAX` — analog-delay-core.ts. Every stage's feedback is scaled by it. */
export const CE_FEEDBACK_MAX = 0.995;
/** `s.driveGain = decay * (1 + k) * 0.8` — charlottes-echos.ts, per stage k. */
export const CE_DRIVE_PER_STAGE = 0.8;
/** `s.wetVolume = Math.pow(1 - decay * 0.6, k)` — charlottes-echos.ts. */
export const CE_WET_TAPER = 0.6;
/** `Math.max(-2, Math.min(2, sig))` — charlottes-echos.ts. The only limiter. */
export const CE_WET_CLAMP = 2;
/** VarispeedShifter is an EXACT bypass below `|rate − 1| < 1e-9`. */
export const CE_SHIFTER_BYPASS_EPS = 1e-9;
/** The shifter seeds `lag = window/2` and its window is 30 ms — so engaging it
 *  inserts 15 ms of read lag PER ENGAGED STAGE (stage 0 always runs at rate 1). */
export const CE_GRAIN_LAG_MS = 15;

/**
 * The cumulative transpose EXPONENT at the last head: content that traverses
 * stages 1..S−1 is multiplied by (1+p)^1 · (1+p)^2 · … — DERIVED from the stage
 * count, never the literal `6`, so a fifth stage would flow through untouched.
 */
export const CE_CLIMB_EXPONENT = Array.from({ length: CE_STAGES - 1 }, (_, i) => i + 1).reduce(
  (a, b) => a + b,
  0,
);

/** How far the tail model will look before it gives up, in SECONDS of audio.
 *  A declared horizon, not a population count: past it the readout says so. */
export const CE_TAIL_HORIZON_S = 60;

// ── THE LIVE PARAMS ─────────────────────────────────────────────────────────

export interface CharlottesEchosFaceParams {
  /** Tap time, seconds. */
  delay: number;
  feedback: number;
  decay: number;
  pitchUp: number;
  mix: number;
}

function spec(id: string): { min: number; max: number; defaultValue: number } {
  const p = CHARLOTTES_ECHOS_RANGES[id];
  if (!p) throw new Error(`charlottes-echos-face-model: '${id}' is not a declared param`);
  return { min: p.min, max: p.max, defaultValue: p.defaultValue };
}

/**
 * Read the face's params off a live reader.
 *
 * TOTAL, and every clause is load-bearing on a real render:
 *   * `node.params` is a SPARSE overlay of what has been TOUCHED, so an
 *     un-read param falls back to the DEF DEFAULT.
 *   * a non-finite value (a NaN mid-drag, an ±Infinity from a corrupt save)
 *     falls back to the default rather than propagating — this runs on every
 *     animation frame and a throw takes the faceplate down mid-drag.
 *   * a finite value is CLAMPED to the def's own range, because that is what
 *     the AudioParam does to it; a readout that believed an out-of-range save
 *     would print a tail the module cannot produce.
 */
export function charlottesEchosFaceParams(
  read: (paramId: string) => number | undefined,
): CharlottesEchosFaceParams {
  const one = (id: string): number => {
    const s = spec(id);
    const v = read(id);
    if (typeof v !== 'number' || !Number.isFinite(v)) return s.defaultValue;
    return Math.min(s.max, Math.max(s.min, v));
  };
  return {
    delay: one('delay'),
    feedback: one('feedback'),
    decay: one('decay'),
    pitchUp: one('pitchUp'),
    mix: one('mix'),
  };
}

// ── THE LOOP ────────────────────────────────────────────────────────────────

/** Stage `k`'s own in-loop small-signal gain. */
export function ceStageLoopGain(p: CharlottesEchosFaceParams, k: number): number {
  return p.feedback * CE_FEEDBACK_MAX * (1 + p.decay * (1 + k) * CE_DRIVE_PER_STAGE);
}

/** The LARGEST of them — stage `CE_STAGES − 1`, always, since the drive term
 *  grows with k. Derived by scanning rather than asserted, so a sign change in
 *  the drive law cannot leave this reading the wrong stage. */
export function ceLoopGain(p: CharlottesEchosFaceParams): number {
  let g = 0;
  for (let k = 0; k < CE_STAGES; k++) g = Math.max(g, ceStageLoopGain(p, k));
  return g;
}

/** Does the module stop? `false` here means the echoes never decay. */
export function ceDecays(p: CharlottesEchosFaceParams): boolean {
  return ceLoopGain(p) < 1;
}

/** One round trip of ONE stage, in seconds: the four are in series and each
 *  runs at `delay / CE_STAGES`, so the cascade's first echo lands at `delay`. */
export function ceRoundTripS(p: CharlottesEchosFaceParams): number {
  return p.delay / CE_STAGES;
}

/**
 * How long one hit rings, in seconds — `Infinity` when the loop gain reaches 1.
 *
 * ⚠ IT IS NOT `60 / (dB per round trip)`. The four stages are in SERIES, so the
 * cascade's impulse response is the CONVOLUTION of four geometric decays, not
 * one — and when their gains are close (they are IDENTICAL at DECAY 0, where
 * the drive is an exact bypass) that convolution has a repeated pole and rings
 * FAR longer than the dominant-pole estimate. Measured at DECAY 0 / FEEDBACK
 * 0.95 the module is still at −22.8 dBFS twelve seconds after a 60 ms hit,
 * while the dominant-pole form predicts −156 dB. So the model runs the actual
 * four-stage recurrence at one step per round trip and reads the −60 dB point
 * off it.
 */
export function ceTailSeconds(p: CharlottesEchosFaceParams): number {
  if (!ceDecays(p)) return Number.POSITIVE_INFINITY;
  const rt = ceRoundTripS(p);
  if (!(rt > 0)) return 0;
  const steps = Math.min(200_000, Math.ceil(CE_TAIL_HORIZON_S / rt));
  const g: number[] = [];
  for (let k = 0; k < CE_STAGES; k++) g.push(ceStageLoopGain(p, k));
  // a[k] is stage k's accumulator; one step = one round trip, and each stage
  // hands its output to the next on the NEXT step (that is the series delay).
  const a = new Float64Array(CE_STAGES);
  let peak = 0;
  let last = 0;
  const trace: number[] = [];
  let inject = 1; // the impulse, injected once at step 0
  for (let n = 0; n <= steps; n++) {
    for (let k = CE_STAGES - 1; k >= 0; k--) {
      const feed = k === 0 ? inject : a[k - 1]!;
      a[k] = g[k]! * a[k]! + feed;
    }
    inject = 0;
    const out = Math.abs(a[CE_STAGES - 1]!);
    trace.push(out);
    if (out > peak) peak = out;
    if (!Number.isFinite(out)) break;
  }
  if (!(peak > 0)) return 0;
  const floor = peak * 1e-3; // −60 dB below the loudest tap
  for (let n = trace.length - 1; n >= 0; n--) {
    if (trace[n]! > floor) {
      last = n;
      break;
    }
  }
  const t = last * rt;
  return t >= CE_TAIL_HORIZON_S ? Number.POSITIVE_INFINITY : t;
}

/**
 * How much further DECAY can travel before the loop gain reaches 1, in DIAL
 * UNITS. `Infinity` when the top of the dial does not get there.
 */
export function ceDecayMargin(p: CharlottesEchosFaceParams): number {
  const s = spec('decay');
  const base = p.feedback * CE_FEEDBACK_MAX;
  if (!(base > 0)) return Number.POSITIVE_INFINITY;
  const at = (1 / base - 1) / (CE_STAGES * CE_DRIVE_PER_STAGE);
  if (!(at <= s.max)) return Number.POSITIVE_INFINITY;
  return at - p.decay;
}

/** The same, in FEEDBACK units. */
export function ceFeedbackMargin(p: CharlottesEchosFaceParams): number {
  const s = spec('feedback');
  const at = 1 / (CE_FEEDBACK_MAX * (1 + p.decay * CE_STAGES * CE_DRIVE_PER_STAGE));
  if (!(at <= s.max)) return Number.POSITIVE_INFINITY;
  return at - p.feedback;
}

// ── THE SHIMMER ─────────────────────────────────────────────────────────────

/** Is the VarispeedShifter running at all? Below `1e-9` it is an EXACT bypass —
 *  a genuine discontinuity, not a rounding threshold. */
export function ceShifterEngaged(p: CharlottesEchosFaceParams): boolean {
  return Math.pow(1 + p.pitchUp, 1) - 1 >= CE_SHIFTER_BYPASS_EPS;
}

/** The last head's cumulative transpose RATIO. */
export function ceClimbRatio(p: CharlottesEchosFaceParams): number {
  if (!ceShifterEngaged(p)) return 1;
  return Math.pow(1 + p.pitchUp, CE_CLIMB_EXPONENT);
}

/** …in cents. 0 when the shifter is bypassed. */
export function ceClimbCents(p: CharlottesEchosFaceParams): number {
  const r = ceClimbRatio(p);
  return r > 0 ? 1200 * Math.log2(r) : 0;
}

/** The read lag engaging the shifter inserts, in ms: `CE_GRAIN_LAG_MS` per
 *  engaged stage (stage 0 always runs at rate 1, so `CE_STAGES − 1` of them). */
export function ceGrainLagMs(p: CharlottesEchosFaceParams): number {
  return ceShifterEngaged(p) ? (CE_STAGES - 1) * CE_GRAIN_LAG_MS : 0;
}

/** The effective first-echo time, in MILLISECONDS. ⚠ The param is in SECONDS —
 *  the two differ by 1000×, which is why every caller states the unit. */
export function ceSpacingMs(p: CharlottesEchosFaceParams): number {
  return p.delay * 1000;
}

// ── WHAT THE FACEPLATE PRINTS ───────────────────────────────────────────────

function fmtSeconds(t: number): string {
  if (t < 1) return `${Math.round(t * 1000)} ms`;
  if (t < 10) return `${t.toFixed(1)} s`;
  return `${Math.round(t)} s`;
}

/** `1.9 s` · `NEVER DECAYS · loop 1.05` · `> 60 s`. */
export function ceTailText(p: CharlottesEchosFaceParams): string {
  const g = ceLoopGain(p);
  if (g >= 1) return `NEVER DECAYS · loop ${g.toFixed(2)}`;
  const t = ceTailSeconds(p);
  if (!Number.isFinite(t)) return `> ${CE_TAIL_HORIZON_S} s`;
  return fmtSeconds(t);
}

/** `at pitch` · `+990 ¢ by head 4`. */
export function ceClimbText(p: CharlottesEchosFaceParams): string {
  if (!ceShifterEngaged(p)) return 'at pitch';
  return `+${Math.round(ceClimbCents(p))} ¢ by head ${CE_STAGES}`;
}

/**
 * `400 ms` · `400 ms + grain`.
 *
 * ⚠ IT REFUSES TO PRINT A TOTAL once the shifter is engaged, and that is the
 * finding rather than a cop-out. The added offset is exactly +45.000 ms as
 * PITCH → 0⁺ and then lands ANYWHERE in 16.6–25.2 ms thereafter, because it
 * depends on where the free-running grain sweep sits when the transient
 * arrives — which is not a function of any parameter. Printing `416.6 ms` would
 * invent precision the DSP does not have.
 */
export function ceSpacingText(p: CharlottesEchosFaceParams): string {
  const ms = ceSpacingMs(p);
  const base = ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();
  return ceShifterEngaged(p) ? `${base} ms + grain` : `${base} ms`;
}

/** `0.82x` · `1.05x PAST` — the closed form, exactly derivable from the source. */
export function ceLoopText(p: CharlottesEchosFaceParams): string {
  const g = ceLoopGain(p);
  return g >= 1 ? `${g.toFixed(2)}x PAST` : `${g.toFixed(2)}x`;
}

/** `DECAY +0.11 · FBK +0.11` · `PAST` — distance to the boundary, in dial units. */
export function ceMarginText(p: CharlottesEchosFaceParams): string {
  if (!ceDecays(p)) return 'PAST';
  const d = ceDecayMargin(p);
  const f = ceFeedbackMargin(p);
  const one = (label: string, v: number) =>
    Number.isFinite(v) ? `${label} +${v.toFixed(2)}` : `${label} —`;
  return `${one('DECAY', d)} · ${one('FBK', f)}`;
}

/** The def's own declaration order, for tests that assert the ranking. */
export const CHARLOTTES_ECHOS_PARAM_IDS: readonly string[] = charlottesEchosDef.params.map(
  (p) => p.id,
);
