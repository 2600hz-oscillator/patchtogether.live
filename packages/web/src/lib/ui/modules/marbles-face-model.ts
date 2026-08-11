// packages/web/src/lib/ui/modules/marbles-face-model.ts
//
// The PURE MODEL behind the MARBLES faceplate — every number the hero, the
// readouts and the loop picture print, derived from the DSP's OWN laws rather
// than measured off one seeded render.
//
// ⚠ WHY THAT DISTINCTION IS THE WHOLE FILE. marbles is the hardest module in
// this repo to measure honestly, because a wrong answer about a random source
// looks exactly like a finding. The face spec that preceded this file
// (`.myrobots/plans/face-specs-batch-4-marbles.md`) says so itself — it got the
// module wrong three times and called the third wrong answer "the most
// convincing" — and it was still wrong about four things when this face was
// built, every one of them an artifact of probing a random process at one seed
// on a coarse grid. The corrections are recorded on the def.
//
// So NOTHING here is a fitted curve. Each law is read out of
// `$lib/audio/modules/marbles-engine` — the host mirror the worklet shares its
// core with — and each is then re-derived from `marblesMath` (a real render of
// that engine) by an ORACLE leg in marbles-face-model.test.ts. A DSP change
// therefore turns a stale claim RED instead of leaving the faceplate insisting
// on it.
//
// THE FOUR LAWS, and where they live in the engine:
//
//   CLOCK       `TGenerator.processSample` → `rateRangeMul · 2^(rate/12)` with
//               `rateRangeMul = 2`, so f = 2 Hz · 2^(RATE/12) exactly, and the
//               `clk` output is `masterPhase < 0.5`, i.e. 50 % duty at every
//               setting. (Measured across the whole fader: 0.0625 Hz at −60 to
//               64.0000 Hz at +60, every point exact to 5 dp.)
//
//   DÉJÀ VU     `RandomSequence.nextValue` → `p = (2·dv − 1)²`, and the SAME
//               number means two different things on the two sides of 0.5:
//               below it, `p` is the probability that this step RE-ROLLS a new
//               random value into the loop; above it, `p` is the probability
//               that the step JUMPS to a random position of the loop it already
//               has. ONE formula, one class, both sections.
//
//   QUANTISER   `OutputChannel.processSample` + `Quantizer.process` →
//               `steps < 0.5` is a PORTAMENTO (`smoothness = 1 − 2·steps`) and
//               `steps ≥ 0.5` is a hard step quantised at
//               `level = round((2·steps − 1) · 7)`, level 0 meaning no
//               quantisation at all. A level keeps the scale degrees whose
//               WEIGHT clears `MARBLES_QUANT_THRESHOLDS[level − 1]`.
//
//   X SHAPE     `OutputChannel.generateNewVoltage` → two degenerate ends.
//               `degenerate = clamp(1.25 − 25·spread, 0, 1)` pulls the value to
//               `10·BIAS − 5` volts, and `bernoulli = clamp(25·spread − 23.75,
//               0, 1)` pushes it to a two-level ±5 V coin flip.
//
// ⚠ EVERY `*Text` FUNCTION HERE RETURNS A BARE VALUE, NOT A SENTENCE — owner
// directive 2026-08-11, after the clouds faceplate: *"we should prefer almost
// zero AI authored text… i want to lose all the ai text, and bring back right
// click → annotate based on authored docs"*. So a readout is a number and its
// unit (`120.0 BPM`, `7 of 12`, `DC 0.00 V`), never a claim about what the
// number means. marbles is the module most tempted to narrate — randomness is
// genuinely hard to read off knob positions — and the answer is to pick values
// that state the fact BY THEMSELVES rather than captions that explain a value
// that does not. `T random` going 100 % → 0 % → 100 % across DÉJÀ VU's travel
// IS this module's headline; it needs no sentence beside it.
//
// The explanations live where they can be asked for rather than always painted:
// the def's `docs` (right-click → annotate), these comments, and the PR body.
//
// PURE: no DOM, no engine handle, no store.

// ⚠ NEITHER IMPORT REACHES `marbles.ts`, DELIBERATELY. The def imports its
// worklet as `…?url`, which Node cannot resolve, so anything importing the def
// is unloadable from a Playwright process — and `marbles-face.spec.ts` needs
// these exact functions to check the DOM against what the model computes,
// rather than against re-typed strings. `marbles-engine` and `marbles-names`
// are both import-free of the def. The one thing that costs is `DEFAULTS`
// below, which is anchored to the def by an assertion in the model test.
import { PRESET_SCALES } from '$lib/audio/modules/marbles-engine';
import {
  MARBLES_SCALE_NAMES,
  MARBLES_T_MODEL_NAMES,
} from '$lib/audio/modules/marbles-names';

// ── THE CLOCK ───────────────────────────────────────────────────────────────

/** `rateRangeMul` — the multiplier the host passes `TGenerator.processSample`,
 *  so RATE 0 is 2 Hz rather than 1. */
export const MARBLES_BASE_HZ = 2;

// ── DÉJÀ VU ─────────────────────────────────────────────────────────────────

/** The one value at which `p` is exactly zero: the loop plays back verbatim.
 *  NOT the top of the knob — see `marblesDejaVuP`. */
export const MARBLES_DEJAVU_LOCK = 0.5;

/**
 * How locked counts as LOCKED. `p` is per STEP, so a loop survives a whole
 * pass with probability `(1 − p)^length`; at `p = 0.002` and the shipped
 * length 8 that is 98.4 %, which is a loop a player hears as fixed. Named
 * rather than inlined because it is the one number here that is a judgement
 * and not a law.
 */
export const MARBLES_LOCKED_P = 0.002;

// ── THE QUANTISER ───────────────────────────────────────────────────────────

/** `Quantizer.init`'s weight thresholds, one per LEVEL. A level keeps the scale
 *  degrees whose weight clears its threshold, so level 1 keeps every degree and
 *  level 7 keeps only the weight-255 root. */
export const MARBLES_QUANT_THRESHOLDS = [0, 16, 32, 64, 128, 192, 255] as const;

/** `K_NUM_THRESHOLDS` — the number of quantiser levels. */
export const MARBLES_QUANT_LEVELS = MARBLES_QUANT_THRESHOLDS.length;

/**
 * The lowest STEPS at which `level` reaches 1 and the quantiser does anything
 * at all: `round((2s − 1)·7) ≥ 1` ⇔ `s ≥ 0.5 + 1/28`.
 *
 * ⚠ THE SHIPPED DEFAULT IS 0.5, WHICH IS BELOW IT. So marbles spawns with its
 * X quantiser section — STEPS *and* SCALE — in a state where neither does
 * anything: the portamento has just been switched off at 0.5 and the quantiser
 * does not switch on until 0.536. That 3.6 %-wide gap is the module's single
 * most confusing shipped state and no surface said so before this face.
 */
export const MARBLES_QUANT_MIN_STEPS = 0.5 + 1 / 28;

/** STEPS at or above which the portamento path is replaced by hard steps
 *  (`OutputChannel.processSample`'s `steps >= 0.5` branch). */
export const MARBLES_STEP_MIN_STEPS = 0.5;

// ── THE X SHAPE ─────────────────────────────────────────────────────────────

/** `generateNewVoltage`'s output range before the host's `/5` normalisation. */
export const MARBLES_CV_VOLTS = 5;

// ── PARAMS ──────────────────────────────────────────────────────────────────

export interface MarblesFaceParams {
  rate: number;
  t_model: number;
  t_bias: number;
  t_jitter: number;
  deja_vu: number;
  length: number;
  pw_mean: number;
  spread: number;
  x_bias: number;
  steps: number;
  x_deja_vu: number;
  x_length: number;
  scale: number;
}

/** The def's own defaults, as the LAST-RESORT fallback when a reader returns
 *  nothing. ⚠ A COPY, because this module deliberately does not import the def
 *  (see the note on the imports) — so `marbles-face-model.test.ts` asserts it
 *  equals `marblesDef.params` entry for entry, which is the anchor that keeps
 *  the copy from going stale. */
export const MARBLES_FACE_DEFAULTS: MarblesFaceParams = {
  rate: 0,
  t_model: 0,
  t_bias: 0.5,
  t_jitter: 0,
  deja_vu: 0,
  length: 8,
  pw_mean: 0.5,
  spread: 0.5,
  x_bias: 0.5,
  steps: 0.5,
  x_deja_vu: 0,
  x_length: 8,
  scale: 0,
};

/** Read the thirteen params through the caller's reader (which already resolves
 *  def defaults for untouched params). TOTAL — a missing or non-finite read
 *  falls back to the def's own default, never to NaN. */
export function marblesFaceParams(
  read: (paramId: string) => number | undefined,
): MarblesFaceParams {
  const out = { ...MARBLES_FACE_DEFAULTS };
  for (const k of Object.keys(MARBLES_FACE_DEFAULTS) as (keyof MarblesFaceParams)[]) {
    const v = read(k);
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

// ── CLOCK ───────────────────────────────────────────────────────────────────

/** The `clk` frequency in Hz. `f = 2 Hz · 2^(RATE/12)`, exact. */
export function marblesClockHz(rate: number): number {
  return MARBLES_BASE_HZ * 2 ** (rate / 12);
}

/** One `clk` pulse per beat, so BPM is just 60·f: 3.75 BPM at RATE −60 and
 *  3840 BPM at +60 — a 1024:1 range on a linear fader. */
export function marblesBpm(rate: number): number {
  return 60 * marblesClockHz(rate);
}

/** Seconds per step. At RATE −60 this is 16.00 s, which is what makes the
 *  bottom of the fader look like a broken module for a quarter of a minute. */
export function marblesStepSeconds(rate: number): number {
  return 1 / marblesClockHz(rate);
}

function fmtStep(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
  return `${Math.round(seconds * 1000)} ms`;
}

/**
 * `marbles-bpm` — the hero's clock value.
 *
 * ⚠ IT IS DERIVED, AND ITS NEGATIVE CONTROL IS JITTER. A readout that showed
 * the LAST interval would move with T JITTER; this one must not, because
 * jitter is a zero-mean displacement (measured mean IOI 24000.0 / 23999.6 /
 * 23994.1 / 23968.7 / 23895.4 samples at jitter 0 / .25 / .5 / .75 / 1 — the
 * rate is stable to 0.44 % while the sd goes 0 → 2093). A "0 st" readout on a
 * clock is information-free, which is what the param's own value prints.
 */
export function marblesBpmText(p: MarblesFaceParams): string {
  return `${marblesBpm(p.rate).toFixed(1)} BPM`;
}

/** `marbles-step` — the other half of the same fact, and the one that makes the
 *  bottom of the fader legible: 16.0 s at RATE −60. */
export function marblesStepText(p: MarblesFaceParams): string {
  return fmtStep(marblesStepSeconds(p.rate));
}

// ── DÉJÀ VU ─────────────────────────────────────────────────────────────────

export type MarblesLoopMode = 'free' | 'rerolling' | 'locked' | 'shuffling';

export interface MarblesLoopState {
  mode: MarblesLoopMode;
  /** `p = (2·dv − 1)²`: below the lock the per-step RE-ROLL probability, above
   *  it the per-step JUMP probability. */
  p: number;
  /** The declared loop length — meaningless while `lengthLive` is false. */
  length: number;
  /** Is LENGTH observable at all? Bit-exactly false at `deja_vu === 0`, where
   *  `p = 1` makes every step overwrite the slot it is about to read. */
  lengthLive: boolean;
}

/**
 * `p = (2·dv − 1)²` — `RandomSequence.nextValue`, verbatim.
 *
 * ⚠ THE FUNCTION IS SYMMETRIC ABOUT 0.5 AND THE KNOB IS NOT. Below the lock a
 * "mutation" WRITES a fresh random value into the loop; above it a mutation
 * JUMPS to a random position of the loop it already holds. So the two ends of
 * the knob are two different kinds of disorder around one ordered middle, and
 * the maximum of the behaviour is the MIDDLE of the control.
 */
export function marblesDejaVuP(dejaVu: number): number {
  const s = 2 * clamp(dejaVu, 0, 1) - 1;
  return s * s;
}

/** The loop state of ONE section (T or X — the same `RandomSequence` class
 *  backs both, which is why there is one function and not two). */
export function marblesLoopState(dejaVu: number, length: number): MarblesLoopState {
  const dv = clamp(dejaVu, 0, 1);
  const p = marblesDejaVuP(dv);
  const len = Math.round(clamp(length, 1, 16));
  if (dv <= 0) return { mode: 'free', p, length: len, lengthLive: false };
  if (p < MARBLES_LOCKED_P) return { mode: 'locked', p, length: len, lengthLive: true };
  return {
    mode: dv < MARBLES_DEJAVU_LOCK ? 'rerolling' : 'shuffling',
    p,
    length: len,
    lengthLive: true,
  };
}

/** A bare percentage. EXACT zero prints `0 %` rather than `0.00 %`, because at
 *  the DÉJÀ VU lock that value is the headline and `0.00 %` reads as a rounded
 *  approximation of something small rather than as nothing. */
function pct(x: number): string {
  const v = x * 100;
  if (v <= 0) return '0 %';
  if (v >= 10) return `${Math.round(v)} %`;
  if (v >= 1) return `${v.toFixed(1)} %`;
  return `${v.toFixed(2)} %`;
}

/**
 * `marbles-t-loop` / `marbles-x-loop` — the LENGTH the section is actually
 * running, or `free`.
 *
 * ⚠ IT MUST NOT PRINT A LENGTH AT `deja_vu 0`, and that is a correctness
 * requirement rather than a style one: LENGTH is BIT-EXACTLY inert there
 * (measured — one distinct t1 stream across lengths 1/2/3/4/5/8/16), so a
 * readout showing "8" would be advertising a control that does nothing, at the
 * module's own shipped default.
 */
export function marblesLoopText(dejaVu: number, length: number): string {
  const s = marblesLoopState(dejaVu, length);
  return s.lengthLive ? `${s.length} steps` : 'free';
}

/**
 * `marbles-t-random` / `marbles-x-random` — `p`, as a bare percentage, and it
 * is the single most useful number this faceplate prints.
 *
 * ⚠ IT IS NON-MONOTONE IN THE KNOB, BECAUSE THE MODULE IS, and stating it as a
 * value rather than a sentence is what makes the behaviour teachable without
 * prose: turn DÉJÀ VU up from 0 and this falls to 0 % at the middle, then
 * climbs back to 100 % at the top. Measured period-8 repetition at the shipped
 * length 8 — T 49.4 / 59.9 / 76.0 / 99.7 / 77.2 / 65.1 / 64.4 / 62.5 % and X
 * 0.0 / 18.3 / 67.9 / 99.7 / 64.7 / 18.6 / 11.5 / 10.6 % at DÉJÀ VU 0 / .25 /
 * .4 / .5 / .6 / .75 / .9 / 1 — both peak at exactly 0.5 and both fall away
 * above it, which is the shape of this number inverted.
 */
export function marblesRandomText(dejaVu: number): string {
  return pct(marblesDejaVuP(dejaVu));
}

// ── THE T SECTION ───────────────────────────────────────────────────────────

/**
 * The index of the T model that is NOT IMPLEMENTED.
 *
 * `marbles-engine.ts` / `marbles-core.ts`, `configureSlaveRamps`:
 *
 *     case T_MODEL.CLUSTERS:
 *     case T_MODEL.DIVIDER:
 *       // Simplified divider/cluster: treat as Bernoulli with bias for v1.
 *       this.scheduleOutputPulses(v, this.generateComplementaryBernoulli(v));
 *
 * So CLUSTERS is a NAMED STUB that falls through to COIN, in both the worklet
 * core and the host mirror. Measured: bit-identical `t1` AND `t2` at T BIAS
 * 0.2 / 0.3 / 0.5 / 0.7 / 0.8, with DRUMS differing at every one of them as the
 * negative control. The fix is porting the firmware's cluster generator, which
 * changes audio and belongs in its own PR — so this face NAMES it instead.
 */
export const MARBLES_STUB_MODEL = 1;

/** The model CLUSTERS currently behaves as. */
export const MARBLES_STUB_MODEL_ALIAS = 0;

export function marblesModelIndex(p: MarblesFaceParams): number {
  return Math.round(clamp(p.t_model, 0, MARBLES_T_MODEL_NAMES.length - 1));
}

export function marblesModelName(p: MarblesFaceParams): string {
  return MARBLES_T_MODEL_NAMES[marblesModelIndex(p)]!;
}

/**
 * `marbles-model` — the model the DSP is RUNNING, which is not always the model
 * the selector names.
 *
 * A `paramId: 't_model'` readout prints `1.00`; a plain name readout prints
 * `CLUSTERS`, which is worse, because it asserts a behaviour the shipping DSP
 * does not have. This prints the resolution — `CLUSTERS → COIN` — which is a
 * mapping, not a sentence.
 */
export function marblesModelText(p: MarblesFaceParams): string {
  const i = marblesModelIndex(p);
  if (i === MARBLES_STUB_MODEL) {
    return `${MARBLES_T_MODEL_NAMES[i]} → ${MARBLES_T_MODEL_NAMES[MARBLES_STUB_MODEL_ALIAS]}`;
  }
  return MARBLES_T_MODEL_NAMES[i]!;
}

/**
 * `marbles-t-split` — the t1 / t2 percentages, and it is MODEL-DEPENDENT.
 *
 * For the two Bernoulli models the law is exact and readable off
 * `generateComplementaryBernoulli` / `generateIndependentBernoulli`: bit 0 is
 * `u > bias`, so `P(t1) = 1 − BIAS` per channel. Measured t1 share 1.0000 /
 * 0.7684 / 0.4842 / 0.2421 / 0.0105 at BIAS 0 / .25 / .5 / .75 / 1.
 *
 * ⚠ THE OTHER THREE MODELS HAVE NO CLOSED FORM — DRUMS reads a pattern table,
 * 3-STATE has a no-gate outcome, MARKOV a logistic over its own history — so
 * this prints `—` there rather than a number that would be wrong. A blank is
 * honest; a plausible figure is not.
 */
export function marblesSplitText(p: MarblesFaceParams): string {
  const i = marblesModelIndex(p);
  const b = clamp(p.t_bias, 0, 1);
  if (i === 0 || i === MARBLES_STUB_MODEL || i === 3) {
    return `${Math.round((1 - b) * 100)} / ${Math.round(b * 100)}`;
  }
  return '—';
}

/**
 * The `t1`/`t2` gate width as a fraction of the step.
 * `TGenerator.randomPulseWidth`: `pulseWidthStd` is never set by this module,
 * so the `=== 0` early return is the only path and the width is
 * `0.05 + 0.9 · PW` for EVERY gate — a fixed fraction, not a random one.
 */
export function marblesGateWidth(pwMean: number): number {
  return 0.05 + 0.9 * clamp(pwMean, 0, 1);
}

/**
 * `marbles-gate-width` — the t1/t2 gate width as a percentage of the step.
 *
 * ⚠ `clk` IS NOT AFFECTED, and the faceplate says so by printing `clk` as its
 * own fixed `50 %` entry beside this one rather than by explaining it. `clk` is
 * `masterPhase < 0.5`, a 50 % square at every PW and every RATE (measured
 * 50.0000 % at all five PW settings) — so a player who sets PW to 0.05 for a
 * tight trigger and then clocks a downstream module from `clk` gets a 50 %
 * gate. Two adjacent numbers that disagree say that without a sentence.
 */
export function marblesGateWidthText(p: MarblesFaceParams): string {
  return `${Math.round(marblesGateWidth(p.pw_mean) * 100)} %`;
}

// ── THE X QUANTISER ─────────────────────────────────────────────────────────

/**
 * `Quantizer.process`'s `level_quantizer`: `round(clamp(2·steps − 1, 0, 1) · 7)`.
 * 0 means the `if (level > 0)` guard fails and the voltage passes through
 * unquantised.
 */
export function marblesQuantLevel(steps: number): number {
  const amount = clamp(2 * clamp(steps, 0, 1) - 1, 0, 1);
  return Math.min(MARBLES_QUANT_LEVELS, Math.round(amount * MARBLES_QUANT_LEVELS));
}

/** The scale degrees (in volts within one octave) a given quantiser level keeps
 *  — the weights that clear `MARBLES_QUANT_THRESHOLDS[level − 1]`. Empty at
 *  level 0. Read straight off `PRESET_SCALES`, never re-typed. */
export function marblesActiveDegrees(scaleIndex: number, steps: number): number[] {
  const level = marblesQuantLevel(steps);
  if (level < 1) return [];
  const scale = PRESET_SCALES[Math.round(clamp(scaleIndex, 0, PRESET_SCALES.length - 1))]!;
  const threshold = MARBLES_QUANT_THRESHOLDS[level - 1]!;
  return scale.degree
    .slice(0, scale.numDegrees)
    .filter((d) => d.weight >= threshold)
    .map((d) => d.voltage);
}

/** Every degree of a scale, active or not — the picture's faint ring. */
export function marblesAllDegrees(scaleIndex: number): number[] {
  const scale = PRESET_SCALES[Math.round(clamp(scaleIndex, 0, PRESET_SCALES.length - 1))]!;
  return scale.degree.slice(0, scale.numDegrees).map((d) => d.voltage);
}

export function marblesScaleName(p: MarblesFaceParams): string {
  return MARBLES_SCALE_NAMES[Math.round(clamp(p.scale, 0, MARBLES_SCALE_NAMES.length - 1))]!;
}

/**
 * The GLIDE, as a fraction of one clock step.
 *
 * ⚠ A FRACTION, NOT A TIME, and that is measured rather than assumed:
 * `LagProcessor.process` derives its one-pole coefficient from the PHASE
 * INCREMENT, so the same STEPS setting glides for the same fraction of the step
 * at every RATE (measured within 0.6 pp across RATE 12 / 24 / 36, i.e. across a
 * 4× tempo range).
 *
 * The curve is a pinned TABLE rather than a formula because the settling time
 * of `lpState + (interp − lpState)·interpAmount` through a raised-cosine warp
 * has no useful closed form — and the table is re-derived from a real
 * `marblesMath` render on every run by the oracle in the model test, so it
 * cannot go stale. Non-monotone at the very bottom on purpose: the
 * `smoothness <= 0.05` branch adds frequency back, so STEPS 0 glides slightly
 * LESS than STEPS 0.1.
 */
export const MARBLES_GLIDE_TABLE: readonly (readonly [steps: number, fraction: number])[] = [
  [0.0, 0.908],
  [0.1, 0.964],
  [0.2, 0.933],
  [0.25, 0.89],
  [0.3, 0.758],
  [0.35, 0.52],
  [0.4, 0.322],
  [0.45, 0.198],
  [0.475, 0.156],
  [0.49, 0.0],
  [0.5, 0.0],
];

export function marblesGlideFraction(steps: number): number {
  const s = clamp(steps, 0, 1);
  if (s >= MARBLES_STEP_MIN_STEPS) return 0;
  const t = MARBLES_GLIDE_TABLE;
  for (let i = 1; i < t.length; i++) {
    const [x1, y1] = t[i]!;
    if (s <= x1) {
      const [x0, y0] = t[i - 1]!;
      const k = x1 === x0 ? 0 : (s - x0) / (x1 - x0);
      return y0 + (y1 - y0) * k;
    }
  }
  return 0;
}

/**
 * `marbles-quantiser` — how many of the selected scale's degrees survive, or
 * `off`.
 *
 * STEPS has TWO regimes with a DEAD GAP between them, and the module ships in
 * the gap:
 *
 *   STEPS < 0.5      PORTAMENTO. The X outputs GLIDE between values, for
 *                    ~91–96 % of a step at the bottom, falling to zero by 0.49.
 *   0.5 … 0.536      HARD STEPS, NO QUANTISATION. The default 0.5 is here.
 *   STEPS ≥ 0.536    quantised, at one of seven levels.
 *
 * The faceplate states that with THREE adjacent values rather than a sentence:
 * `glide` (a percentage that reaches 0 before this one leaves `off`), this one,
 * and `scales`. The prose belongs in `docs`.
 *
 * ⚠ THE DEF'S OWN PROSE HAD THE FIRST REGIME BACKWARDS until this PR ("0 jumps
 * instantly between values, higher values glide smoothly between them" — it is
 * the other way round). Corrected there, not narrated here.
 */
export function marblesQuantiserText(p: MarblesFaceParams): string {
  if (marblesQuantLevel(p.steps) < 1) return 'off';
  const active = marblesActiveDegrees(p.scale, p.steps).length;
  const all = marblesAllDegrees(p.scale).length;
  return `${active} of ${all}`;
}

/** `marbles-glide` — the portamento, as a percentage of one step. Reaches 0 at
 *  STEPS 0.49, which is BEFORE the quantiser wakes at 0.536: the two values
 *  read `0 %` and `off` together at the shipped default, which is the gap. */
export function marblesGlideText(p: MarblesFaceParams): string {
  return `${Math.round(marblesGlideFraction(p.steps) * 100)} %`;
}

/**
 * How many of the six scales are DISTINGUISHABLE at this quantiser level —
 * derived by comparing the active DEGREE SETS, not asserted.
 *
 * At level 1 every degree of every scale is active, so the WEIGHTS — the only
 * thing that separates C major from C minor from Pentatonic — are ignored and
 * those three collapse into one, as do the two Raags. At level 7 only the
 * weight-255 root survives and all six collapse to octaves. In between, all six
 * differ. Measured against a real render at STEPS 0.54 … 0.99: 3 / 6 / 6 / 6 /
 * 6 / 3 / 1 distinct outputs at levels 1…7, exactly as this predicts.
 */
export function marblesScaleVariants(steps: number): number {
  const level = marblesQuantLevel(steps);
  if (level < 1) return 1;
  const sets = new Set<string>();
  for (let i = 0; i < PRESET_SCALES.length; i++) {
    sets.add(marblesActiveDegrees(i, steps).map((v) => v.toFixed(6)).join(','));
  }
  return sets.size;
}

/** The STEPS window inside which all six scales are distinguishable — quantiser
 *  levels 2 through 5, i.e. `[0.5 + 1.5/14, 0.5 + 5.5/14)`. */
export const MARBLES_SCALE_BAND: readonly [number, number] = [0.5 + 1.5 / 14, 0.5 + 5.5 / 14];

/**
 * `marbles-scales` — how many of the six SCALES produce different output at the
 * current STEPS, as `N of 6`.
 *
 * ⚠ IT MUST BE INVARIANT TO `scale` ITSELF. That is the negative control and it
 * is the whole content of the readout: below the quantiser threshold every
 * scale produces bit-identical output, so a readout that changed when you
 * turned SCALE would be reporting the knob rather than the module. `1 of 6`
 * beside a SCALE selector showing `Raag Bhairav` is the entire fact.
 */
export function marblesScaleLiveText(p: MarblesFaceParams): string {
  return `${marblesScaleVariants(p.steps)} of ${PRESET_SCALES.length}`;
}

// ── THE X SHAPE ─────────────────────────────────────────────────────────────

/** `generateNewVoltage`: `clamp(1.25 − 25·spread, 0, 1)` — how hard the value
 *  is pulled onto the DC constant. 1 at SPREAD ≤ 0.01, 0 from 0.05. */
export function marblesDegenerateAmount(spread: number): number {
  return clamp(1.25 - 25 * clamp(spread, 0, 1), 0, 1);
}

/** `generateNewVoltage`: `clamp(25·spread − 23.75, 0, 1)` — how hard the value
 *  is pushed onto a two-level ±5 V coin flip. 0 below 0.95, 1 from 0.99. */
export function marblesBernoulliAmount(spread: number): number {
  return clamp(25 * clamp(spread, 0, 1) - 23.75, 0, 1);
}

/** The DC the degenerate end collapses onto: `ScaleOffset(10, −5).apply(bias)`. */
export function marblesDcVolts(bias: number): number {
  return 10 * clamp(bias, 0, 1) - MARBLES_CV_VOLTS;
}

/**
 * `marbles-x-shape` — BOTH ends of SPREAD are degenerate, and the spec this
 * face was built from had the mechanism attached to the wrong knob.
 *
 * It reported "X BIAS at either end pins the output to a DC constant". Measured
 * at the shipped SPREAD 0.5, X BIAS 0 gives 48 DISTINCT values and X BIAS 1
 * gives 48 — not a constant, a skew with about half the samples on the host's
 * ±1 rail. The DC collapse is SPREAD's doing; BIAS only chooses WHERE it lands
 * (measured exactly `10·BIAS − 5` volts, to 6 dp, at SPREAD 0 and 0.01, for
 * BIAS 0 / .25 / .5 / .75 / 1).
 *
 * And the OTHER end, which the spec never looked at, is just as degenerate: at
 * SPREAD ≥ 0.99 the three CV outputs stop being voltages and become a two-level
 * COIN FLIP between −5 V and +5 V with P(+5 V) = BIAS (measured: exactly two
 * output values).
 */
export function marblesXShapeText(p: MarblesFaceParams): string {
  const deg = marblesDegenerateAmount(p.spread);
  const ber = marblesBernoulliAmount(p.spread);
  if (deg >= 1) return `DC ${marblesDcVolts(p.x_bias).toFixed(2)} V`;
  if (ber >= 1) return '2-level ±5 V';
  if (deg > 0) return `${Math.round(deg * 100)} % → DC`;
  if (ber > 0) return `${Math.round(ber * 100)} % → 2-level`;
  return 'random ±5 V';
}

// ── THE HERO PICTURE ────────────────────────────────────────────────────────

export type MarblesRingAxis = 'step' | 'time';

export interface MarblesRingSection {
  /** Slot count = the section's loop length. */
  slots: number;
  state: MarblesLoopState;
}

export interface MarblesLoopPlan {
  t: MarblesRingSection;
  x: MarblesRingSection;
  /** Active scale degrees in volts within one octave — the tick ring. Empty
   *  when the quantiser is off, which is the shipped default and is the point. */
  degrees: readonly number[];
  /** Every degree of the selected scale, so the picture can draw the ones the
   *  current level THREW AWAY as well as the ones it kept. */
  allDegrees: readonly number[];
  quantLevel: number;
  scaleName: string;
}

/** Everything `MarblesLoopPanel` draws, as a pure function of the live params.
 *  No clock, no analyser: the picture is identical on a running graph, a frozen
 *  one and a silent rack, which is what makes the VRT tile deterministic
 *  without depending on #1420's freeze. */
export function marblesLoopPlan(p: MarblesFaceParams): MarblesLoopPlan {
  const t = marblesLoopState(p.deja_vu, p.length);
  const x = marblesLoopState(p.x_deja_vu, p.x_length);
  return {
    t: { slots: t.lengthLive ? t.length : 1, state: t },
    x: { slots: x.lengthLive ? x.length : 1, state: x },
    degrees: marblesActiveDegrees(p.scale, p.steps),
    allDegrees: marblesAllDegrees(p.scale),
    quantLevel: marblesQuantLevel(p.steps),
    scaleName: marblesScaleName(p),
  };
}

/**
 * The ring's slot caption under the picture, in one of two labellings.
 *
 * ⚠ THIS IS THE PANEL'S OPERABILITY PROBE TARGET, so the two modes must NEVER
 * render the same string — otherwise a dead button would pass a `text` probe.
 * They cannot: `time` always carries a unit suffix and `step` never does, which
 * `marbles-face-model.test.ts` asserts over every slot at every rate rather
 * than arguing here.
 */
export function marblesRingCaption(
  slot: number,
  p: MarblesFaceParams,
  axis: MarblesRingAxis,
): string {
  if (axis === 'step') return String(slot + 1);
  return fmtStep(slot * marblesStepSeconds(p.rate));
}
