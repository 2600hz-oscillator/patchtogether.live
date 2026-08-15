// packages/web/src/lib/ui/modules/sidecar-face-model.ts
//
// The PURE model behind the SIDECAR faceplate — the arithmetic for its four
// derived readouts.
//
// WHY A MODEL AT ALL. SIDECAR is a stereo sidechain DUCKER: the MAIN pair is
// the trigger and passes through untouched, the SC pair is the signal that gets
// pushed down and summed back in. Four things a player needs to know about that
// are NOT any one knob, and each is a different knob's blind spot:
//
//   · WHERE ducking starts. `threshold` prints `-18.00 dB` and that is not the
//     level at which anything happens, for TWO independent reasons the knob is
//     invariant to. The detector is `|aL| + |aR|` — a stereo-linked SUM of
//     rectifiers — so a mono main normalled to both channels reads exactly
//     `20·log10(2) = 6.0206 dB` above its own peak; and the soft KNEE begins
//     `knee/2` BELOW the threshold. At the shipped defaults ducking begins at a
//     main peak of −27.02 dBFS, nine dB from what the dial says.
//   · HOW DEEP it ducks. `ratio` prints `4.00`, and the reduction that buys
//     depends on the threshold. It is also badly non-linear in the dial: the
//     top of the travel buys 1.8 dB more than ratio 8.
//   · HOW LOUD the ducked signal is. `inputLevel` and `makeup` are the SAME
//     DIMENSION — measured bit-identical for four equivalent pairs — so
//     neither readback can print the sidechain's actual gain, and at
//     `inputLevel` 0 the path is dead whatever MAKEUP says.
//   · WHAT THE ENV OUTPUT ACTUALLY DOES. `envMag` is audio-invariant (measured
//     bit-identical output RMS at 0 / 0.5 / 1 / 2) and its output is UNCLAMPED,
//     so ENV exceeds 1.0 whenever the reduction passes 24 dB — at the DEFAULT
//     envMag, not only above it.
//
// EVERY FORMULA HERE MIRRORS `packages/dsp/src/lib/compressor-dsp.ts` AND IS
// RE-DERIVED BY AN ORACLE. `sidecar-face-model.test.ts` imports the shipping
// DSP and asserts each closed form against it across the whole control space,
// with negative controls in both directions — so a DSP change turns a stale
// faceplate claim RED instead of leaving the panel insisting on it.
//
// PURE: no DOM, no engine, no store, no fs. Every function is a pure function
// of the live params.

import { fmtDb } from '$lib/audio/modules/kickdrum-format';
// ⚠ THE SHIPPING GAIN COMPUTER ITSELF — IMPORTED, NEVER MIRRORED. Until the
// transfer-curve panel landed this file carried its own three-region copy of
// `computeGainDb` and a whole-control-space sweep asserting the copy agreed.
// That is a gate over a divergence that should not be representable, and a
// PICTURE makes it worse than a number: a readout that is 0.1 dB stale is
// wrong once, a curve that draws a different law is wrong at every x. The knee
// / ratio / slope arithmetic now exists in exactly one place — `packages/dsp/
// src/lib/compressor-dsp.ts`, the file the worklet is built from — and the
// faceplate, the readouts and the panel are all consumers of it.
//
// RELATIVE path, not the `@patchtogether.live/dsp/src/...` alias, for the
// reason `resofilter-face-model.ts` and `warrensspectrum.ts` both document: a
// worktree may not symlink the workspace package under node_modules, and the TS
// path-alias rules do not reliably resolve TS source out of there.
import {
  computeGainDb,
  envOut,
  DB_PER_LOG2,
  ENV_SCALE_DB,
} from '../../../../../dsp/src/lib/compressor-dsp';

// ── THE DSP CONSTANTS, RE-EXPORTED UNDER THIS FACE'S NAMES ──────────────────

/** `20·log10(2)` — `compressor-dsp.ts` `DB_PER_LOG2`, re-exported rather than
 *  restated. It appears in this module TWICE over and the two uses are
 *  unrelated: it is the log2→dB bridge inside the gain computer, AND it is
 *  exactly the offset a stereo-linked sum of rectifiers adds to a mono main
 *  (`|a| + |a| = 2|a|`) — see `SIDECAR_MONO_SUM_OFFSET_DB`. */
export const SIDECAR_DB_PER_LOG2 = DB_PER_LOG2;

/** `compressor-dsp.ts` `ENV_SCALE_DB` — the reduction at which ENV reaches 1.0
 *  when `envMag` is 1. NOT a knob; a documented constant. */
export const SIDECAR_ENV_SCALE_DB = ENV_SCALE_DB;

/**
 * The detector reading, in dB, that every "at reference" readout is stated AT:
 * a FULL-SCALE MONO MAIN. `audio_r_in` is normalled to `audio_l_in`
 * (`sidecar.ts` inputs note), so a single ±1.0 trigger presents
 * `|aL| + |aR| = 2.0` to the detector — i.e. `+6.0206 dB`, not 0.
 *
 * ⚠ IT HAS TO BE STATED, and the readout LABELS state it (`duck @ FS`,
 * `env @ FS`) rather than leaving the reference implicit. A `FaceReadoutValue`
 * is `(read) => string` and sees only params — it cannot observe what is
 * actually patched into MAIN — so the honest move is to print the answer for
 * ONE named operating point instead of a number that silently assumes another.
 */
export const SIDECAR_REFERENCE_DETECTOR_DB = SIDECAR_DB_PER_LOG2 * Math.log2(2);

/**
 * The SAME operating point, one conversion earlier: the MAIN peak level, in
 * dBFS, that `@ FS` names. The panel plots against MAIN dBFS (the number on the
 * player's meter) and its cursor RESTS here, so the picture and the readout row
 * state the same answer until the player asks a different question.
 *
 * ⚠ Written independently of `SIDECAR_REFERENCE_DETECTOR_DB` rather than
 * derived from it, and the test asserts `sidecarDetectorDb(this)` IS that —
 * which is a real leg, because the two are the readout row's claim and the
 * panel's claim about the same point and nothing else forces them to agree.
 */
export const SIDECAR_REFERENCE_MAIN_DBFS = 0;

/** The `|aL| + |aR|` offset a MONO main incurs, in dB. Identical in value to
 *  `SIDECAR_DB_PER_LOG2` and named separately because it is a different fact —
 *  conflating them is how a refactor would "simplify" one of them away. */
export const SIDECAR_MONO_SUM_OFFSET_DB = 20 * Math.log10(2);

// ── THE LIVE PARAMS ─────────────────────────────────────────────────────────

export interface SidecarFaceParams {
  /** dB, −60..0. Where the gain computer's knee is centred. */
  threshold: number;
  /** 1..20. 1 = no reduction at all. */
  ratio: number;
  /** dB, 0..24. FULL knee width — it reaches `knee/2` either side. */
  knee: number;
  /** 0..2. Sidechain input gain, and the sidechain path's ENABLER at 0. */
  inputLevel: number;
  /** dB, 0..24. Sidechain gain again, in different units. */
  makeup: number;
  /** 0..2. Scales the ENV / ENV INV outputs only — audio-invariant. */
  envMag: number;
}

/** The def's own defaults, restated so a fresh node (whose `node.params` is a
 *  SPARSE overlay of what has been TOUCHED) prints the shipped answer rather
 *  than zeros. Mirrors `sidecarDef.params`; the oracle asserts the mirror. */
export const SIDECAR_DEFAULTS: SidecarFaceParams = {
  threshold: -18,
  ratio: 4,
  knee: 6,
  inputLevel: 1,
  makeup: 0,
  envMag: 1,
};

function finite(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Snap a dB value that is zero AT THE PRINTED PRECISION to exactly zero.
 *
 * ⚠ THIS IS NOT COSMETIC AND IT WAS CAUGHT BY THIS FILE'S OWN ORACLE. `fmtDb`
 * branches on `v > 0`, so a value like −2.8e-10 — which is what
 * `20·log10(0.5) + 6.0206` evaluates to, i.e. one of the exactly-equivalent
 * INPUT LVL / MAKEUP pairs this face exists to show are equivalent — formats as
 * `-0.0 dB` while its twin formats as `0.0 dB`. The faceplate would have
 * printed two different strings for two bit-identical states, which is the
 * precise opposite of the claim the readout is making.
 */
function snapDb(v: number): number {
  return Number.isFinite(v) && Math.abs(v) < 0.05 ? 0 : v;
}

/** Read the face's params off a live reader, defaulting each one INDEPENDENTLY
 *  (a node that has touched only THRESHOLD must still print the right ratio). */
export function sidecarFaceParams(
  read: (paramId: string) => number | undefined,
): SidecarFaceParams {
  return {
    threshold: finite(read('threshold'), SIDECAR_DEFAULTS.threshold),
    ratio: finite(read('ratio'), SIDECAR_DEFAULTS.ratio),
    knee: finite(read('knee'), SIDECAR_DEFAULTS.knee),
    inputLevel: finite(read('inputLevel'), SIDECAR_DEFAULTS.inputLevel),
    makeup: finite(read('makeup'), SIDECAR_DEFAULTS.makeup),
    envMag: finite(read('envMag'), SIDECAR_DEFAULTS.envMag),
  };
}

// ── THE GAIN COMPUTER, MIRRORED ─────────────────────────────────────────────

/**
 * The static soft-knee gain computer (GMR 2012 eq 4), expressed against a
 * DETECTOR level in dB rather than in log2.
 *
 * ⚠ IT IS THE SHIPPING FUNCTION, not a re-statement of it. The whole body is
 * the unit conversion the worklet does one line earlier (`compressor-dsp.ts`
 * step 4 takes `log2(mag)`; step 5 hands it to `computeGainDb`, which
 * immediately multiplies back by `DB_PER_LOG2`). Everything this face and its
 * panel claim about the knee, the slope and the three regions is therefore a
 * claim about the code the audio actually runs through.
 *
 * Returns the gain to APPLY (≤ 0; more negative = more ducking).
 */
export function sidecarGainDb(detectorDb: number, p: SidecarFaceParams): number {
  return computeGainDb(detectorDb / DB_PER_LOG2, p.threshold, p.knee, p.ratio);
}

// ── 1. ONSET — where ducking begins, in MAIN dBFS ───────────────────────────

/**
 * The MAIN peak level, in dBFS, at which this setting first reduces anything —
 * for the mono/centred main the module normals for.
 *
 * `threshold − knee/2` is where the knee opens in DETECTOR dB, and the detector
 * sits `SIDECAR_MONO_SUM_OFFSET_DB` above the main's own peak. THE THRESHOLD
 * READBACK IS BLIND TO BOTH TERMS: it prints `-18.00 dB` at every knee width
 * and would print it whatever the detector summed.
 *
 * ⚠ At `ratio` 1 nothing ducks at any level, and this function does NOT encode
 * that — `sidecarOnsetText` does, because "the knee opens here but the slope is
 * zero" is a real distinction and folding it in here would make the arithmetic
 * untestable against the DSP's own gain computer.
 */
export function sidecarOnsetDbfs(p: SidecarFaceParams): number {
  return p.threshold - Math.max(0, p.knee) * 0.5 - SIDECAR_MONO_SUM_OFFSET_DB;
}

/** `-27.0 dB` at the shipped defaults. `never` at ratio 1, where the slope is
 *  zero and no level ducks at all. */
export function sidecarOnsetText(p: SidecarFaceParams): string {
  if (!(p.ratio > 1)) return 'never';
  const v = sidecarOnsetDbfs(p);
  return Number.isFinite(v) ? fmtDb(snapDb(v)) : '—';
}

// ── 2. DUCK — the reduction at the reference main ───────────────────────────

/**
 * The gain reduction, in dB, at a full-scale mono main.
 *
 * THE RATIO READBACK IS BLIND TO THE THRESHOLD: `4.00` buys −18.02 dB at
 * threshold −18 and a different number at every other threshold. The dial is
 * also badly non-linear in its own top half — 0 / −12.01 / −18.02 / −21.02 /
 * −22.82 dB at ratio 1 / 2 / 4 / 8 / 20 — so the last two thirds of the travel
 * buy 1.8 dB.
 *
 * ⚠ AND IT IS DELIBERATELY KNEE-BLIND, which is what makes it the other
 * readout's negative control. A detector this far above the threshold is past
 * the knee at every width, so `knee` moves `onset` and cannot move this. Two
 * readouts, each invariant to what the other reports.
 */
export function sidecarDuckDb(p: SidecarFaceParams): number {
  return sidecarDuckDbAt(p, SIDECAR_REFERENCE_MAIN_DBFS);
}

/** `-18.0 dB` at the shipped defaults; `none` at ratio 1. */
export function sidecarDuckText(p: SidecarFaceParams): string {
  return sidecarDuckTextAt(p, SIDECAR_REFERENCE_MAIN_DBFS);
}

/** What the `|aL| + |aR|` detector reads, in dB, for a MONO main whose own peak
 *  is `mainDbfs`. THE WHOLE PANEL IS DRAWN AGAINST `mainDbfs`, because that is
 *  the number on the player's meter; the detector's is not on any surface. */
export function sidecarDetectorDb(mainDbfs: number): number {
  return mainDbfs + SIDECAR_MONO_SUM_OFFSET_DB;
}

/** The reduction, in dB, at an arbitrary MAIN peak level. `sidecarDuckDb` is
 *  this at the reference; the panel plots it across the whole window. */
export function sidecarDuckDbAt(p: SidecarFaceParams, mainDbfs: number): number {
  return sidecarGainDb(sidecarDetectorDb(mainDbfs), p);
}

/** ONE vocabulary for the reduction, at the reference and under the cursor
 *  alike — `none` and `—` mean the same thing in both places because they are
 *  the same function. */
export function sidecarDuckTextAt(p: SidecarFaceParams, mainDbfs: number): string {
  const v = sidecarDuckDbAt(p, mainDbfs);
  if (!Number.isFinite(v)) return '—';
  if (v > -0.05) return 'none';
  return fmtDb(snapDb(v));
}

// ── 3. SC GAIN — the sidechain's total gain ─────────────────────────────────

/**
 * The sidechain path's total gain in dB: `20·log10(inputLevel) + makeup`.
 *
 * MEASURED, the two knobs are ONE DIMENSION — `compressor-dsp.ts` step 9 is
 * `sc · inputLevel · duckLin · makeupLin`, and since `duckLin` is computed from
 * the MAIN pair alone the ordering is irrelevant. `inLvl 2 / makeup 0`,
 * `inLvl 1 / makeup 6.0206` and `inLvl 0.5 / makeup 12.0412` all render the same
 * output to the digit. EACH KNOB'S READBACK IS INVARIANT TO THE OTHER.
 *
 * ⚠ `makeup` is NOT an output gain, whatever it is called. It multiplies the
 * ducked sidechain only; the MAIN passthrough is bit-identical at 0, 12 and
 * 24 dB. That is why this readout is labelled `sc gain` and not `makeup`.
 */
export function sidecarScGainDb(p: SidecarFaceParams): number {
  const lvl = Math.max(0, p.inputLevel);
  if (lvl <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(lvl) + p.makeup;
}

/** `0.0 dB` at the shipped defaults. `silent` at `inputLevel` 0 — the enabler
 *  state, where MAKEUP has no authority at all. */
export function sidecarScGainText(p: SidecarFaceParams): string {
  const v = sidecarScGainDb(p);
  if (v === Number.NEGATIVE_INFINITY) return 'silent';
  return Number.isFinite(v) ? fmtDb(snapDb(v)) : '—';
}

// ── 4. ENV — what the CV output actually reaches ────────────────────────────

/**
 * The ENV output's value at the reference main: `(−gainDb / 24) · envMag`,
 * UNCLAMPED, exactly as `compressor-dsp.ts` `envOut` computes it.
 *
 * THE ENVMAG READBACK IS BLIND TO THE ENTIRE DETECTION CHAIN: it prints `1.00`
 * whether the reduction is 0 dB (ENV 0, a dead CV output) or 40 dB (ENV 1.70,
 * a CV output that overshoots the ±1 every consumer expects).
 */
export function sidecarEnvAtRef(p: SidecarFaceParams): number {
  return sidecarEnvAt(p, SIDECAR_REFERENCE_MAIN_DBFS);
}

/** ENV at an arbitrary MAIN peak level — the SHIPPING `envOut`, not a copy of
 *  its formula, for the same reason `sidecarGainDb` is the shipping computer.
 *  `envMag` is floored at 0 here and not in the DSP because a NEGATIVE envMag
 *  is unreachable through the 0..2 ParamDef and a face must be TOTAL over the
 *  hostile reader anyway. */
export function sidecarEnvAt(p: SidecarFaceParams, mainDbfs: number): number {
  return envOut(sidecarDuckDbAt(p, mainDbfs), Math.max(0, p.envMag));
}

/**
 * `0.75` at the shipped defaults; `1.70 over` once it passes 1.0; `off` at
 * `envMag` 0, where ENV is pinned at 0 and ENV INV at 1 no matter what the
 * detector does.
 *
 * ⚠ THE `over` STATE IS THE POINT. The def documented overshoot as something
 * that happens "above 1" envMag; measured, ENV reached 1.70 at envMag = 1 with
 * an ordinary setting. The condition is *reduction > 24 dB*, at any envMag > 0.
 */
export function sidecarEnvText(p: SidecarFaceParams): string {
  return sidecarEnvTextAt(p, SIDECAR_REFERENCE_MAIN_DBFS);
}

/** ONE vocabulary for ENV, at the reference and under the cursor alike — so
 *  `off` and ` over` cannot come to mean two different things on two surfaces
 *  of the same faceplate. */
export function sidecarEnvTextAt(p: SidecarFaceParams, mainDbfs: number): string {
  if (!(p.envMag > 0)) return 'off';
  const v = sidecarEnvAt(p, mainDbfs);
  if (!Number.isFinite(v)) return '—';
  return v > 1 ? `${v.toFixed(2)} over` : v.toFixed(2);
}

// ── 5. THE TRANSFER CURVE — the PANEL's model ───────────────────────────────
//
// WHY A PICTURE AT ALL, on a face that already prints four derived numbers.
// The readouts each answer ONE question at ONE operating point, because that is
// all a `(read) => string` can honestly do. The audit that produced them
// (#1657) found four knobs printing a number that is not the answer, and three
// of the four disagreements are SHAPE facts a single value cannot carry:
//
//   · WHERE the bend is. `onset` prints -27.0 dB and `threshold` prints -18.00.
//     A tick at each, on an axis calibrated in MAIN dBFS, shows the gap AND
//     splits it into its two independent terms — the dial's mark sits at
//     `threshold - 6.02` (the `|aL|+|aR|` sum) and the bend starts another
//     `knee/2` to the left. Two numbers cannot say which of them moved.
//   · HOW STEEP it is. `duck @ FS` prints one reduction at one level. The
//     RATIO's whole non-linearity — 0 / -12.0 / -18.0 / -21.0 / -22.8 dB at
//     1 / 2 / 4 / 8 / 20 — is a slope, and a slope is a picture.
//   · WHAT HAPPENS BETWEEN. Everything at a main level other than full scale,
//     which is every real kick. The cursor is the readouts' own question asked
//     at a level the player chooses, printed in the readouts' own vocabulary.
//
// ⚠ EVERY VALUE BELOW COMES FROM `sidecarGainDb` / `envOut`, i.e. from
// `compressor-dsp.ts`. THE PANEL RE-TYPES NO DSP ARITHMETIC — a curve that
// draws a different law than the module applies is worse than no curve,
// because it is wrong at every x instead of at one, and it looks authoritative.
// `sidecar-face-model.test.ts` guards that at the SOURCE level as well as by
// value, since no runtime gate can see a second copy that happens to agree
// today.

/** The panel's x window, in MAIN peak dBFS — the module's own `threshold`
 *  range, so the curve covers exactly the levels the dial can be set to.
 *  ⚠ A LAYOUT/PHYSICAL constant (the plotted domain), not a population. */
export const SIDECAR_CURVE_MAIN_MIN_DBFS = -60;
export const SIDECAR_CURVE_MAIN_MAX_DBFS = SIDECAR_REFERENCE_MAIN_DBFS;

/**
 * The panel's y window: reduction, 0 dB at the top down to this floor.
 *
 * ⚠ FIXED, NOT AUTO-SCALED, and that is the whole reason the picture is worth
 * looking at twice. An auto-scaled y axis slides under the curve as you turn
 * RATIO, so the trace barely moves and the knob reads as if it does nothing; a
 * fixed window makes the slope change visible, which is the finding. The cost
 * is that the deepest settings run off the bottom — `sidecarCurvePoints`
 * reports `clipped` so the panel can say so rather than draw a flat floor and
 * let it read as a limit the module actually has.
 */
export const SIDECAR_CURVE_DUCK_FLOOR_DB = -48;

/** One plotted sample of the transfer curve. */
export interface SidecarCurvePoint {
  /** MAIN peak level, dBFS. */
  mainDbfs: number;
  /** Reduction applied to the SC path at that level, dB (≤ 0). */
  duckDb: number;
  /** `duckDb` clamped into the drawn window — what the polyline uses. */
  plotDb: number;
}

export interface SidecarCurve {
  points: SidecarCurvePoint[];
  /** True when any sample is deeper than the drawn floor. */
  clipped: boolean;
}

/**
 * `columns + 1` evenly spaced samples of the static gain computer across the
 * window. Pure and total: a hostile param set produces a finite `plotDb` at
 * every x, because a NaN in a polyline takes the whole SVG down mid-drag.
 */
export function sidecarCurvePoints(p: SidecarFaceParams, columns: number): SidecarCurve {
  const n = Math.max(1, Math.floor(columns));
  const span = SIDECAR_CURVE_MAIN_MAX_DBFS - SIDECAR_CURVE_MAIN_MIN_DBFS;
  const points: SidecarCurvePoint[] = [];
  let clipped = false;
  for (let i = 0; i <= n; i++) {
    const mainDbfs = SIDECAR_CURVE_MAIN_MIN_DBFS + (span * i) / n;
    const raw = sidecarDuckDbAt(p, mainDbfs);
    const duckDb = Number.isFinite(raw) ? raw : 0;
    if (duckDb < SIDECAR_CURVE_DUCK_FLOOR_DB) clipped = true;
    points.push({
      mainDbfs,
      duckDb,
      plotDb: Math.min(0, Math.max(SIDECAR_CURVE_DUCK_FLOOR_DB, duckDb)),
    });
  }
  return { points, clipped };
}

/**
 * Where the THRESHOLD DIAL's own number lands on a MAIN-dBFS axis:
 * `threshold - 6.02`, because the detector is a SUM of two rectifiers and a
 * mono main is normalled to both.
 *
 * ⚠ THIS IS NOT WHERE DUCKING STARTS and the panel draws both marks precisely
 * so that is visible. `null` when the mark falls outside the drawn window,
 * which is honest: a tick clamped to the edge would claim a position it does
 * not have.
 */
export function sidecarThresholdMarkDbfs(p: SidecarFaceParams): number | null {
  return inWindow(p.threshold - SIDECAR_MONO_SUM_OFFSET_DB);
}

/**
 * Where ducking actually begins, on the same axis — `sidecarOnsetDbfs`, the
 * value the ONSET readout prints, so the tick and the number cannot disagree.
 *
 * `null` at ratio 1 (nothing ducks at any level, which is what `sidecarOnsetText`
 * prints as `never`) and `null` off-window.
 */
export function sidecarOnsetMarkDbfs(p: SidecarFaceParams): number | null {
  if (!(p.ratio > 1)) return null;
  return inWindow(sidecarOnsetDbfs(p));
}

function inWindow(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  return v >= SIDECAR_CURVE_MAIN_MIN_DBFS && v <= SIDECAR_CURVE_MAIN_MAX_DBFS ? v : null;
}

/** The SC path's output gain at a given MAIN level: its resting gain plus
 *  whatever the main is taking off it. `-Infinity` at INPUT LVL 0. */
export function sidecarScOutDbAt(p: SidecarFaceParams, mainDbfs: number): number {
  return sidecarScGainDb(p) + sidecarDuckDbAt(p, mainDbfs);
}

/** …in the `sc gain` readout's vocabulary, so `silent` still means the enabler
 *  state and nothing else. */
export function sidecarScOutTextAt(p: SidecarFaceParams, mainDbfs: number): string {
  const v = sidecarScOutDbAt(p, mainDbfs);
  if (v === Number.NEGATIVE_INFINITY) return 'silent';
  return Number.isFinite(v) ? fmtDb(snapDb(v)) : '—';
}

/** Clamp a cursor position into the drawn window. */
export function sidecarClampMainDbfs(mainDbfs: number): number {
  if (!Number.isFinite(mainDbfs)) return SIDECAR_CURVE_MAIN_MAX_DBFS;
  return Math.min(SIDECAR_CURVE_MAIN_MAX_DBFS, Math.max(SIDECAR_CURVE_MAIN_MIN_DBFS, mainDbfs));
}

/**
 * The cursor line — the readout row's own questions, asked at the level under
 * the pointer and answered in the readout row's own vocabularies.
 *
 * ⚠ IT IS NOT A SECOND, DIFFERENTLY-CALIBRATED SET OF NUMBERS. At the resting
 * cursor (`SIDECAR_REFERENCE_MAIN_DBFS`) `duck` and `env` are
 * character-for-character the `duck @ FS` and `env @ FS` readouts above them —
 * asserted permanently, because a panel that quietly used a different reference
 * than the readouts it sits under would be two answers to one question with
 * nothing on the faceplate to say which is meant.
 *
 * ⚠ `sc out` is DELIBERATELY the one field that is NOT a readout repeated. The
 * `sc gain` readout is the sidechain's RESTING gain (`20·log10(inLvl) + makeup`,
 * the one-dimension pair); this is that gain WITH the duck applied, i.e. what
 * the ducked signal is actually worth at this main level. Their difference IS
 * `duck`, which is why both belong on the panel: turn MAKEUP and every cursor
 * reading slides by the same dB at every x, which is the one-dimension finding
 * as a behaviour rather than as a sentence.
 */
export function sidecarCursorText(p: SidecarFaceParams, mainDbfs: number): string {
  const m = sidecarClampMainDbfs(mainDbfs);
  return [
    `main ${fmtDb(snapDb(m))}`,
    `duck ${sidecarDuckTextAt(p, m)}`,
    `sc out ${sidecarScOutTextAt(p, m)}`,
    `env ${sidecarEnvTextAt(p, m)}`,
  ].join(' · ');
}
