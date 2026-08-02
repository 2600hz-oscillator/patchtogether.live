// packages/web/src/lib/ui/modules/kickdrum-face-model.ts
//
// THE PURE MODEL BEHIND KICK DRUM's FACEPLATE — every number the faceplate
// prints or draws, derived here and nowhere else.
//
// WHY A MODEL AND NOT A DRAWING. The faceplate's hero is an amplitude + pitch
// -sweep graph captioned `tail ≈ 398 ms · +24 st → 50 Hz`. A hand-drawn curve
// with a hardcoded caption would be a PICTURE OF A KICK, not a picture of THIS
// kick: it would sit still while the knobs moved, and the one thing a producer
// reads it for — "how long is this tail, and how far does the punch chirp" —
// would be a lie the moment anybody turned SUB DEC. So the curve and the
// caption are computed from the LIVE param values through the WORKLET'S OWN
// FUNCTIONS:
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
// ⚠ NO RANGES, NO LABELS, NO DEFAULTS ARE RE-TYPED HERE. This module takes the
// live values it is given and returns geometry + strings. Everything about what
// a param IS (min/max/curve/units/label) belongs to the def and is read from it
// by the components (`paramSpec`), per CLAUDE.md's "a control's range must come
// from ONE place". The ONE exception is `KICKDRUM_PRESETS`, which is by
// definition a table of values — and `kickdrum-face-model.test.ts` asserts every
// preset key is a declared param and every value is inside that param's declared
// min/max, so the table cannot drift out of the contract it stamps into.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import {
  decayCoeff,
  kickBodyFreqHz,
  kickSubFreqHz,
  type KickdrumP1Params,
} from '../../../../../dsp/src/lib/kickdrum-dsp';
// The def's own readout vocabulary — the SAME functions its params carry as
// `ParamDef.format`, so the hero caption and the knob under it can never print
// one value two ways.
import { fmtHz, fmtMs, fmtSemitones } from '$lib/audio/modules/kickdrum-format';

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

/**
 * THE HERO CAPTION — `tail ≈ 398 ms · +24 st → 50 Hz`.
 *
 * Every one of those three numbers moves with the knobs (see kickdrumTailMs /
 * kickdrumSweep). `≈` is honest rather than decorative: the tail is measured to
 * a stated floor on the PRE-BUS envelope, so a hot CEILING or a lifted SUSTAIN
 * shifts the audible tail a little past it.
 */
export function kickdrumHeroCaption(p: KickdrumEnvelopeParams): string {
  const { semitones, endHz } = kickdrumSweep(p);
  return `tail ≈ ${fmtMs(kickdrumTailMs(p))} · ${fmtSemitones(semitones)} → ${fmtHz(endHz)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// THE SIGNAL FLOW — what the sidebar diagram draws
// ─────────────────────────────────────────────────────────────────────────

/** One stage of the serial bus, as the sidebar draws it. */
export interface KickdrumFlowStage {
  /** Uppercase stage name (`DRIVE·HARD`). */
  id: string;
  /** Which half of the module it belongs to — the legend's two colours. */
  kind: 'generator' | 'bus' | 'out';
  /**
   * TRUE for a stage that is not inline: it taps the bus earlier and rejoins
   * it, so the diagram must draw it as a branch or it teaches a chain the DSP
   * does not have. Exactly one stage is parallel today (TRANSLATE).
   */
  parallel?: boolean;
  /** One-line "what this stage does", for the stage legend under the diagram. */
  note: string;
}

/**
 * The bus, in DSP order.
 *
 * ⚠ TRANSLATE IS DRAWN AS A BRANCH, and this is the one place the faceplate
 * knowingly differs from the flat arrow-chain in the design mock. The exciter
 * "taps a copy of the raw sub layer (pre-drive) … and sums them into the bus
 * just ahead of the EQ" (kickdrum.ts docs.explanation, and the worklet agrees),
 * so drawing `EQ·TILT → TRANSLATE → DYNAMICS` inline would teach a producer
 * that turning TRANSLATE up excites the DRIVEN, EQ'd signal — it does not, it
 * excites the clean sub, which is precisely why it survives a small speaker.
 * The stage list and its order are the mock's; only the branch mark is added.
 *
 * ⚠ THE ORDER IS THE DSP'S, NOT THE RANKING'S. `kickdrumVoiceStep` applies
 * LEVEL last of all and `kickdrumStepStereo`'s `tanh` (CEILING) is genuinely
 * the final stage — so the chain ends `… → STEREO·WIDTH → OUT L·R` with the
 * ceiling inside the output stage, and `kickdrum-face.test.ts` reads the DSP
 * source to keep that honest.
 */
export const KICKDRUM_FLOW: readonly KickdrumFlowStage[] = [
  { id: 'SUB', kind: 'generator', note: 'pure sine at TUNE — the air-moving fundamental, always mono' },
  { id: 'BODY', kind: 'generator', note: 'morphable wave an octave up with the fast 909 downward sweep' },
  { id: 'CLICK', kind: 'generator', note: 'band-passed noise burst — the leading transient, seeded-deterministic' },
  { id: 'DRIVE·HARD', kind: 'bus', note: 'oversampled saturator; HARD swaps tanh warmth for a wavefolder' },
  { id: 'EQ·TILT', kind: 'bus', note: 'the 3-band kick EQ (sub shelf / body bell / attack bell) plus a spectral tilt' },
  {
    id: 'TRANSLATE',
    kind: 'bus',
    parallel: true,
    note: 'PARALLEL branch: excites a copy of the RAW sub so phones reconstruct the fundamental',
  },
  { id: 'DYNAMICS', kind: 'bus', note: 'transient shaper + a glue compressor whose detector ignores the sub' },
  { id: 'STEREO·WIDTH', kind: 'bus', note: 'M/S width above the crossover only — the low end stays coherent' },
  { id: 'OUT L·R', kind: 'out', note: 'LEVEL, then the per-channel true-peak CEILING — genuinely last' },
];

/** The two-entry legend under the diagram (generator half vs bus half). */
export const KICKDRUM_LEGEND: readonly { kind: 'generator' | 'bus'; label: string; note: string }[] = [
  { kind: 'generator', label: 'generator', note: 'three decoupled layers, struck together' },
  { kind: 'bus', label: 'bus stage', note: 'one serial mastering chain' },
];

/**
 * THE STEREO CROSSOVER visual.
 *
 * The number is the worklet's, not a design choice: the stereo split sits at
 * 120 Hz (`kickdrum-dsp.ts` phase 5 — "ONLY the >120 Hz side content widens …
 * the sub stays phase-coherent MONO"). It is stated ONCE, here, and the
 * component draws it; `kickdrum-face-model.test.ts` greps the DSP source for
 * the constant so a worklet change cannot leave the picture behind.
 */
export const KICK_CROSSOVER_HZ = 120;

/** The crossover picture: how much of the band above the split is widened. */
export function kickdrumCrossover(width: number): {
  hz: number;
  /** 0..1 — the M/S spread applied above the split. */
  spread: number;
  monoLabel: string;
  wideLabel: string;
} {
  const spread = Math.min(1, Math.max(0, width));
  return {
    hz: KICK_CROSSOVER_HZ,
    spread,
    monoLabel: `mono ‹ ${KICK_CROSSOVER_HZ} Hz`,
    wideLabel: `M/S › ${KICK_CROSSOVER_HZ} Hz`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PRESETS — five voices, and they SELECT
// ─────────────────────────────────────────────────────────────────────────

/**
 * A preset STAMPS values into params (the sixstrum shape), it does not point at
 * a stored patch: this voice has no `node.data` roster, so "recall" is a commit
 * through the normal param path and every stamped knob stays live afterwards.
 *
 * Each entry lists ONLY the params that make it that voice; everything it omits
 * keeps whatever the player had. That is deliberate — a preset that silently
 * reset all 25 params would throw away the bus settings a producer had dialled
 * for their mix, which is the reason hardware kick modules have "sound" presets
 * rather than "patch" presets.
 */
export interface KickdrumPreset {
  /** Stable id — what lands in `node.data.kickPreset`. */
  id: string;
  /** Display name, as the sidebar lists it. */
  label: string;
  /** The one-line "why you'd pick this". */
  note: string;
  /** DEF param id → value. Every key + value is gated by the model's test. */
  values: Readonly<Record<string, number>>;
}

export const KICKDRUM_PRESETS: readonly KickdrumPreset[] = [
  {
    id: 'deep-club',
    label: 'DEEP CLUB',
    note: '50 Hz',
    values: {
      tune: 50, sub_decay: 520, sub_level: 0.95, sub_eq: 2, translate: 0.35,
      pitch_amt: 20, pitch_time: 34, body_decay: 110, body_level: 0.6, body_shape: 0.2, body_eq: 2,
      click_len: 10, click_tone: 2400, click_level: 0.3, attack_eq: 1,
      drive: 0.35, hard: 0, tilt: -0.1,
      attack: 0.15, sustain: 0.1, glue: 0.35, level: 0, width: 0.2, ceiling: 0.5,
    },
  },
  {
    id: 'techno-punch',
    label: 'TECHNO PUNCH',
    note: 'hard',
    values: {
      tune: 55, sub_decay: 300, sub_level: 0.85, sub_eq: 0, translate: 0.3,
      pitch_amt: 30, pitch_time: 22, body_decay: 90, body_level: 0.85, body_shape: 0.5, body_eq: 4,
      click_len: 9, click_tone: 3400, click_level: 0.5, attack_eq: 3,
      drive: 0.75, hard: 1, tilt: 0.2,
      attack: 0.5, sustain: -0.1, glue: 0.45, level: 0, width: 0.25, ceiling: 0.7,
    },
  },
  {
    id: '909-classic',
    label: '909 CLASSIC',
    note: '62 Hz',
    values: {
      tune: 62, sub_decay: 380, sub_level: 0.8, sub_eq: 0, translate: 0.25,
      pitch_amt: 24, pitch_time: 30, body_decay: 130, body_level: 0.75, body_shape: 0.3, body_eq: 3,
      click_len: 12, click_tone: 2800, click_level: 0.45, attack_eq: 2,
      drive: 0.4, hard: 0, tilt: 0,
      attack: 0.25, sustain: 0, glue: 0.3, level: 0, width: 0.2, ceiling: 0.5,
    },
  },
  {
    id: 'sub-boom',
    label: 'SUB BOOM',
    note: '38 Hz',
    values: {
      tune: 38, sub_decay: 720, sub_level: 1, sub_eq: 4, translate: 0.6,
      pitch_amt: 14, pitch_time: 45, body_decay: 150, body_level: 0.45, body_shape: 0.1, body_eq: 0,
      click_len: 8, click_tone: 1800, click_level: 0.2, attack_eq: 0,
      drive: 0.25, hard: 0, tilt: -0.35,
      attack: 0, sustain: 0.3, glue: 0.5, level: -2, width: 0.1, ceiling: 0.6,
    },
  },
  {
    id: 'lo-fi-thump',
    label: 'LO-FI THUMP',
    note: 'crush',
    values: {
      tune: 58, sub_decay: 240, sub_level: 0.7, sub_eq: -3, translate: 0.15,
      pitch_amt: 18, pitch_time: 26, body_decay: 80, body_level: 0.8, body_shape: 0.85, body_eq: 5,
      click_len: 18, click_tone: 1500, click_level: 0.55, attack_eq: -2,
      drive: 0.9, hard: 1, tilt: -0.5,
      attack: 0.35, sustain: -0.3, glue: 0.7, level: -1, width: 0.35, ceiling: 0.85,
    },
  },
];

/** Look one up by id (undefined for an unknown id — a stale saved slot). */
export function kickdrumPreset(id: string | undefined): KickdrumPreset | undefined {
  return KICKDRUM_PRESETS.find((p) => p.id === id);
}
