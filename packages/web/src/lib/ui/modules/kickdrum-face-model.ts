// packages/web/src/lib/ui/modules/kickdrum-face-model.ts
//
// THE PURE MODEL BEHIND KICK DRUM's FACEPLATE — every number the faceplate
// prints or draws, derived here and nowhere else.
//
// WHY A MODEL AND NOT A DRAWING. The faceplate's hero is an amplitude + pitch
// -sweep graph, with the hero readouts `TAIL 398 ms · SWEEP +24 st · SETTLES TO
// 50 Hz` beside it. A hand-drawn curve with hardcoded numbers would be a
// PICTURE OF A KICK, not a picture of THIS kick: it would sit still while the
// knobs moved, and the one thing a producer reads it for — "how long is this
// tail, and how far does the punch chirp" — would be a lie the moment anybody
// turned SUB DEC. So the curve and the tail figure are computed from the LIVE
// param values through the WORKLET'S OWN FUNCTIONS:
//
//   `decayCoeff`      — the −60 dB envelope law (kickdrum-dsp.ts)
//   `kickSubFreqHz`   — the sub's settle law
//   `kickBodyFreqHz`  — the body's 909 sweep law (+ the tension glide)
//
// imported by RELATIVE path, exactly as cube.ts / sample-hold.ts import their
// DSP cores and for the same reason (worktrees may not symlink the workspace
// package; the TS-source alias does not resolve reliably out of node_modules).
// A change to the decay law in the worklet therefore MOVES THIS GRAPH — which
// is the property that makes it an instrument rather than an illustration, and
// it is negative-controlled in `kickdrum-face-model.test.ts`.
//
// ⚠ NO RANGES, NO LABELS, NO PRESET TABLES ARE RE-TYPED HERE. This module takes
// the live values it is given and returns geometry + numbers. Everything about
// what a param IS (min/max/curve/units/label) belongs to the def, per CLAUDE
// .md's "a control's range must come from ONE place"; the presets, the signal
// flow, the crossover split and the sidebar copy are DECLARED on the def's
// `face` and painted by the platform, not modelled here.
//
// The one thing this file DOES read off the def is `defaultValue`, in
// `kickdrumEnvelopeParams`, for the params a fresh node has not stored yet —
// read from the def rather than re-typed, for exactly the reason above.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import {
  decayCoeff,
  kickBodyFreqHz,
  kickSubFreqHz,
  type KickdrumP1Params,
} from '../../../../../dsp/src/lib/kickdrum-dsp';
import { kickdrumDef } from '$lib/audio/modules/kickdrum';

export {
  fmtAmount,
  fmtBipolar,
  fmtDb,
  fmtHz,
  fmtMs,
  fmtSemitones,
} from '$lib/audio/modules/kickdrum-format';

/**
 * The subset of KICK DRUM's params the faceplate's hero graph reads, keyed by
 * DEF param id (not the worklet's camelCase). The component hands over live
 * values straight off the node; ranges stay with the def.
 */
export interface KickdrumEnvelopeParams {
  tune: number;
  pitch_amt: number;
  pitch_time: number;
  tension: number;
  sub_decay: number;
  body_decay: number;
  click_len: number;
  sub_level: number;
  body_level: number;
  click_level: number;
}

/** The ten param ids the hero graph reads, in the order the interface lists
 *  them. Exported so a rename of one of them fails a test rather than silently
 *  falling back to a default. */
export const KICKDRUM_ENVELOPE_PARAM_IDS = [
  'tune', 'pitch_amt', 'pitch_time', 'tension',
  'sub_decay', 'body_decay', 'click_len',
  'sub_level', 'body_level', 'click_level',
] as const satisfies readonly (keyof KickdrumEnvelopeParams)[];

/**
 * Collect the envelope params from a live reader, resolving the DEF DEFAULT for
 * anything the reader has no answer for.
 *
 * ⚠ THE DEFAULT FALLBACK IS THE WHOLE POINT. `node.params` is a SPARSE OVERLAY
 * of what has been TOUCHED, not the module's state — a freshly spawned kick has
 * an empty map. Reading it bare would compute the graph and the tail figure
 * from zeros, i.e. print a picture of silence over a voice that is perfectly
 * audible. Every other surface (the card kit's `paramVal`, the sidebar's
 * `readParam`) resolves the same way, and the def is the ONE place the numbers
 * live. A missing param id THROWS rather than defaulting to 0: that is a
 * rename, and it must be loud.
 */
export function kickdrumEnvelopeParams(
  read: (paramId: string) => number | undefined,
): KickdrumEnvelopeParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = kickdrumDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`kickdrum-face-model: kickdrum has no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    tune: val('tune'),
    pitch_amt: val('pitch_amt'),
    pitch_time: val('pitch_time'),
    tension: val('tension'),
    sub_decay: val('sub_decay'),
    body_decay: val('body_decay'),
    click_len: val('click_len'),
    sub_level: val('sub_level'),
    body_level: val('body_level'),
    click_level: val('click_level'),
  };
}

/**
 * The reference rate the geometry is evaluated at. The envelope law is
 * sample-rate calibrated (`decayCoeff` divides by `sr`), so ANY rate returns
 * the same curve in the TIME domain — this constant only fixes how many
 * per-sample multiplies a millisecond is worth. 48 kHz because that is the rate
 * the app pins its AudioContext to.
 */
const MODEL_SR = 48000;

/**
 * The floor the TAIL figure is measured to: −60 dB below the voice's own peak.
 *
 * Stated as a constant because the number is an editorial choice and the
 * caption must not be able to disagree with it. −60 dB is the same floor the
 * worklet's own decay knobs are calibrated to ("Amp-decay knobs are calibrated
 * as TIME TO −60 dB", kickdrum-dsp.ts), so "tail" and "SUB DEC" are measured
 * with one ruler — a producer who sets SUB DEC to 450 ms and reads a tail of
 * 398 ms is seeing the layer MIX, not two different definitions of decay.
 */
export const KICK_TAIL_FLOOR_DB = -60;

/** Amplitude ratio of the tail floor (10^(−60/20) = 0.001). */
const TAIL_FLOOR_RATIO = Math.pow(10, KICK_TAIL_FLOOR_DB / 20);

/** ms → the DSP's per-sample multiplier, raised to `t` ms. */
function envAt(decayMs: number, tMs: number): number {
  if (tMs <= 0) return 1;
  return Math.pow(decayCoeff(decayMs, MODEL_SR), (tMs / 1000) * MODEL_SR);
}

/**
 * The three layer envelopes at time `t` ms after the strike, each already
 * scaled by its own mix level — so the sum is exactly the amplitude envelope
 * the voice presents to the DRIVE stage (pre-bus, which is the stage the
 * generator sections on this faceplate control).
 */
export function kickdrumLayerAmps(
  p: KickdrumEnvelopeParams,
  tMs: number,
): { sub: number; body: number; click: number; sum: number } {
  const sub = p.sub_level * envAt(p.sub_decay, tMs);
  const body = p.body_level * envAt(p.body_decay, tMs);
  const click = p.click_level * envAt(p.click_len, tMs);
  return { sub, body, click, sum: sub + body + click };
}

/**
 * THE TAIL FIGURE, in ms: how long until the summed voice falls below
 * `KICK_TAIL_FLOOR_DB` of its own peak.
 *
 * Solved by BISECTION rather than closed form: a sum of three exponentials with
 * different time constants has no analytic inverse, and the sum is strictly
 * decreasing in `t` (every term is), so bisection is exact to the tolerance and
 * cannot be fooled by a local minimum. 30 halvings over a 0..8000 ms bracket
 * resolves to well under a microsecond — far finer than the integer ms the
 * caption prints.
 *
 * Returns 0 when every layer is muted (peak 0): a silent voice has no tail, and
 * the alternative (dividing by a zero peak) prints `NaN ms`.
 */
export function kickdrumTailMs(p: KickdrumEnvelopeParams): number {
  const peak = kickdrumLayerAmps(p, 0).sum;
  if (!(peak > 0)) return 0;
  const target = peak * TAIL_FLOOR_RATIO;
  let lo = 0;
  let hi = 8000;
  if (kickdrumLayerAmps(p, hi).sum > target) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (kickdrumLayerAmps(p, mid).sum > target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The PITCH SWEEP the caption's `+24 st → 50 Hz` half describes: where the body
 * starts, where the whole voice settles, and the depth in semitones.
 *
 * `endHz` is the SUB's settled fundamental (`kickSubFreqHz` at env 0), not the
 * body's — that is the pitch the kick is heard AT once the chirp is over, and
 * it is the number TUNE is labelled with. `startHz` is the body at the strike
 * (`kickBodyFreqHz` at env 1), which is where the sweep audibly begins.
 *
 * ACCENT is passed 0: the caption describes the voice AS TUNED, and accent is a
 * per-hit latch off `accent_in` that deepens the sweep by up to 50 %. A caption
 * that moved with an incoming CV would be unreadable while a sequence played.
 */
export function kickdrumSweep(p: KickdrumEnvelopeParams): {
  startHz: number;
  endHz: number;
  semitones: number;
} {
  const dsp = toDspParams(p);
  const endHz = kickSubFreqHz(dsp, 0);
  const startHz = kickBodyFreqHz(dsp, 1, p.tension * p.body_level, 0);
  return { startHz, endHz, semitones: dsp.pitchAmt };
}

/** DEF-id params → the worklet's own param shape, for the imported laws. */
function toDspParams(p: KickdrumEnvelopeParams): KickdrumP1Params {
  return {
    tune: p.tune,
    pitchAmt: p.pitch_amt,
    pitchTime: p.pitch_time,
    tension: p.tension,
    subDecay: p.sub_decay,
    bodyDecay: p.body_decay,
    subLevel: p.sub_level,
    bodyLevel: p.body_level,
    bodyShape: 0,
    pitchCv: 0,
    clickLen: p.click_len,
    clickTone: 0,
    clickLevel: p.click_level,
    drive: 0,
    hard: 0,
    subEq: 0,
    bodyEq: 0,
    attackEq: 0,
    tilt: 0,
    translate: 0,
    attack: 0,
    sustain: 0,
    glue: 0,
    ceiling: 0,
    level: 0,
    width: 0,
  };
}

/**
 * THE TIME AXIS IS WARPED — `t = x² · windowMs`, not `t = x · windowMs`.
 *
 * MEASURED, on the def's own defaults: the click is 12 ms, the pitch chirp
 * 30 ms, the body 120 ms and the sub's tail 398 ms. On a LINEAR axis inside the
 * 600 ms window the entire chirp — the thing `pitch_amt` and `pitch_time`
 * exist to shape, and half of what the caption is about — occupies the first
 * **5 %** of the plot's width, i.e. about five of 96 sample points. It renders
 * as a vertical tick against the y-axis and is, for practical purposes, not
 * drawn. The remaining 95 % is the sub decaying, and most of that is silence.
 *
 * A square-root axis puts t = 30 ms at x = 0.22 and t = 400 ms at x = 0.82, so
 * the chirp and the tail are both legible in one picture without a second plot
 * or a second window. It is the same reason a spectrum analyser is drawn on a
 * log frequency axis: the events under inspection span two and a half decades
 * of time and a linear ruler can only show one of them.
 *
 * ⚠ THE MARKER MUST USE THE SAME WARP. `tailX` is `√(tail / window)`, not
 * `tail / window` — a marker computed on the linear axis would sit at 0.66 while
 * the curve it points at is at 0.82, which is the "a wrong metric reads exactly
 * like a finding" trap drawn in pixels. Both come from `warpX` below so they
 * cannot diverge.
 */
export function warpX(tMs: number, windowMs: number): number {
  if (!(windowMs > 0)) return 0;
  return Math.sqrt(Math.min(1, Math.max(0, tMs / windowMs)));
}

/** The inverse: plot x → time in ms. */
export function unwarpX(x: number, windowMs: number): number {
  return x * x * windowMs;
}

/** One sampled point of the hero graph, in NORMALISED [0,1] plot space. */
export interface KickdrumGraphPoint {
  /** 0 at the strike → 1 at the right edge of the window (WARPED — see warpX). */
  x: number;
  /** Summed amplitude ÷ peak. 1 at the strike. */
  amp: number;
  /** Body frequency mapped log-wise between the settled pitch and the start. */
  pitch: number;
}

/** The hero graph's full geometry + the numbers its caption prints. */
export interface KickdrumGraph {
  points: KickdrumGraphPoint[];
  /** The plotted time span, ms — what x=1 means. */
  windowMs: number;
  /** Tail figure, ms (see kickdrumTailMs). */
  tailMs: number;
  /** x of the tail marker inside the window, or null when it falls outside. */
  tailX: number | null;
  startHz: number;
  endHz: number;
  semitones: number;
  /**
   * The plot height at which the BODY comes to rest — which is NOT 0.
   *
   * The body is an octave above the sub by construction (`kickBodyFreqHz`
   * starts from `2 × tune`), so a trace normalised against the sub's
   * fundamental settles at `log(2)/log(startHz/endHz)`, not at the floor. That
   * gap is the single most useful thing this picture teaches — "the punch does
   * not land on the fundamental, it lands an octave up" — so the panel draws a
   * baseline here rather than the model hiding it by re-normalising the trace
   * to end at zero.
   */
  bodySettledY: number;
}

/**
 * Sample the hero graph.
 *
 * `windowMs` is chosen by the CALLER (the panel offers a 2-position zoom), not
 * derived from the tail: an auto-window would rescale the picture on every knob
 * move, so a 20 % longer tail would look IDENTICAL — the curve is invariant to
 * the very quantity the caption is about. A fixed window means a longer tail
 * visibly reaches further right, which is the whole point of drawing it.
 *
 * `pitch` is normalised LOGARITHMICALLY between the SUB's settled fundamental
 * (y = 0, the pitch the caption ends with) and the sweep start (y = 1), because
 * pitch is perceived in ratios: on a linear axis a +24 st sweep from 100 Hz to
 * 400 Hz would spend three quarters of its height in the first two semitones.
 *
 * ⚠ THE TRACE DOES NOT END AT 0, and that is the point — see `bodySettledY`.
 * A degenerate span (start == end, i.e. `pitch_amt` 0 with the sub's own settle
 * multiplier also collapsed) plots flat rather than dividing by log(1).
 */
export function kickdrumGraph(
  p: KickdrumEnvelopeParams,
  windowMs: number,
  points = 96,
): KickdrumGraph {
  const peak = kickdrumLayerAmps(p, 0).sum;
  const dsp = toDspParams(p);
  const { startHz, endHz, semitones } = kickdrumSweep(p);
  const span = startHz > 0 && endHz > 0 ? Math.log(startHz / endHz) : 0;
  const n = Math.max(2, Math.round(points));
  const out: KickdrumGraphPoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const tMs = unwarpX(x, windowMs);
    const amp = peak > 0 ? kickdrumLayerAmps(p, tMs).sum / peak : 0;
    const bodyEnv = envAt(p.pitch_time, tMs);
    const hz = kickBodyFreqHz(dsp, bodyEnv, p.tension * p.body_level * envAt(p.body_decay, tMs), 0);
    const pitch = span > 0 && endHz > 0 ? Math.min(1, Math.max(0, Math.log(hz / endHz) / span)) : 0;
    out.push({ x, amp, pitch });
  }
  const tailMs = kickdrumTailMs(p);
  return {
    points: out,
    windowMs,
    tailMs,
    tailX: tailMs <= windowMs ? warpX(tailMs, windowMs) : null,
    startHz,
    endHz,
    semitones,
    // The body rests one octave over the sub; in a log-normalised span that is
    // log(2)/log(start/end). A degenerate span pins it to the trace's own flat
    // level (1) so the baseline never renders above the curve.
    bodySettledY: span > 0 ? Math.min(1, Math.log(2) / span) : 1,
  };
}
