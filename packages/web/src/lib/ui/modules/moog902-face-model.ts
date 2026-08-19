// packages/web/src/lib/ui/modules/moog902-face-model.ts
//
// The MOOG 902 VCA's gain law, in the ONE place the faceplate reads it.
//
// ⚠ WHY THIS RE-STATES A LAW THAT ALREADY EXISTS IN THE WORKLET, AND WHY THAT
// IS NOT THE #1913 ANTI-PATTERN. `packages/dsp/src/moog902.ts` deliberately
// top-level-exports NOTHING — a top-level export leaks into the bundled
// `dist/moog902.js` and breaks ART's classic-script eval
// (memory: dsp-worklet-no-top-level-export), so its `moog902Gain` is
// structurally unreachable from `$lib`. A faceplate readout that wants to
// print what the amplifier is DOING therefore has no choice but to re-state
// the law.
//
// The hazard that creates is exactly the one #1913 names on `moog904a`, whose
// ART scenario hand-copied `DRIVE = 0.5 + REGEN * 0.8` and can now drift from
// the worklet silently. The answer here is NOT a comment asking the next
// author to remember: `moog902-face-model.test.ts` carries a PERMANENT leg
// that instantiates the SHIPPING worklet processor, drives it to steady state
// at a grid of (gain, mode) settings, and asserts this module's `moog902Gain`
// agrees. A DSP edit that moves the law reddens the FACE model, by name,
// before it reaches a pixel.
//
// The constants below are the worklet's own, and the test pins them against it
// rather than against a second copy of the arithmetic.

import type { AudioModuleDef } from '$lib/audio/module-registry';
import { moog902Def } from '$lib/audio/modules/moog902';

// ───────────────────────── the law's constants ─────────────────────────
/** The GAIN pot spans 0..6 V of the control sum (param `gain` is 0..1 → ×6). */
export const MOOG902_GAIN_POT_VOLTS = 6;
/** The control voltage at the +6 dB anchor. */
export const MOOG902_V_ANCHOR = 6;
/** The gain multiplier at that anchor (×2 = +6 dB). */
export const MOOG902_GAIN_AT_ANCHOR = 2;
/** The hard ceiling — the 902 saturates at ×3. */
export const MOOG902_GAIN_CEILING = 3;
/** The EXPONENTIAL law's time constant, fitted to ×2 @ 6 V and ×3 @ 7.5 V. */
export const MOOG902_EXP_TAU = 5.0102;
/** The EXPONENTIAL law's scalar, derived from the anchor like the worklet's. */
export const MOOG902_EXP_A =
  MOOG902_GAIN_AT_ANCHOR / (Math.exp(MOOG902_V_ANCHOR / MOOG902_EXP_TAU) - 1);

/** The RESPONSE switch's threshold — the worklet reads `mode >= 0.5` as EXP. */
export const MOOG902_EXP_THRESHOLD = 0.5;

/**
 * The 902's gain law: a CONTROL SUM in volts → an amplitude multiplier.
 * LINEAR is a straight line through the origin hitting ×2 at 6 V; EXPONENTIAL
 * is `A·(e^(v/τ) − 1)`, through the same ×2 at 6 V and steeper above it. Both
 * clamp to the ×3 ceiling, and a non-positive control sum is silence.
 */
export function moog902Gain(controlVolts: number, exponential: boolean): number {
  if (!(controlVolts > 0)) return 0;
  const g = exponential
    ? MOOG902_EXP_A * (Math.exp(controlVolts / MOOG902_EXP_TAU) - 1)
    : (controlVolts / MOOG902_V_ANCHOR) * MOOG902_GAIN_AT_ANCHOR;
  return g > MOOG902_GAIN_CEILING ? MOOG902_GAIN_CEILING : g;
}

/**
 * The control-sum voltage at which THIS mode reaches the ×3 ceiling.
 *
 * ⚠ THIS IS THE NUMBER #1912 IS ABOUT. Three doc sites said "~7.5 V"
 * UNCONDITIONALLY. Measured by bisecting the shipping worklet it is
 * **9.000000 V in LINEAR — the shipped default mode — and 7.499999 V in
 * EXPONENTIAL**, and at 7.5 V LINEAR delivers only ×2.500000. The ceiling is a
 * property of the LAW, so a claim that names one number for both modes is
 * wrong for whichever mode is not EXPONENTIAL.
 *
 * Closed form rather than a bisection, and each arm is the inverse of the
 * corresponding arm of `moog902Gain` above:
 *   LINEAR:      g = v/3   = 3  →  v = V_ANCHOR·CEILING/AT_ANCHOR = 9 exactly
 *   EXPONENTIAL: A(e^(v/τ)−1) = 3  →  v = τ·ln(1 + CEILING/A) ≈ 7.5
 */
export function moog902CeilingVolts(exponential: boolean): number {
  return exponential
    ? MOOG902_EXP_TAU * Math.log(1 + MOOG902_GAIN_CEILING / MOOG902_EXP_A)
    : (MOOG902_V_ANCHOR * MOOG902_GAIN_CEILING) / MOOG902_GAIN_AT_ANCHOR;
}

// ───────────────────────── the face's param view ─────────────────────────

export interface Moog902Params {
  readonly gain: number;
  readonly cvAmount: number;
  readonly mode: number;
}

/**
 * Read one param, resolving the DEF DEFAULT for anything untouched and for any
 * non-finite value the live engine can hand back mid-boot. `node.params` is a
 * SPARSE overlay of what has been TOUCHED, so reading it bare prints
 * `undefined`-shaped nonsense on a freshly spawned node — and a readout runs on
 * every render, so a NaN reaching the arithmetic takes the faceplate down
 * mid-drag rather than printing a wrong number.
 */
function readOr(
  def: AudioModuleDef,
  read: (paramId: string) => number | undefined,
  id: string,
): number {
  const v = read(id);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const p = def.params.find((q) => q.id === id);
  if (!p) throw new Error(`moog902-face-model: ${def.type} has no param '${id}'`);
  return p.defaultValue;
}

export function moog902FaceParams(
  read: (paramId: string) => number | undefined,
): Moog902Params {
  return {
    gain: readOr(moog902Def, read, 'gain'),
    cvAmount: readOr(moog902Def, read, 'cvAmount'),
    mode: readOr(moog902Def, read, 'mode'),
  };
}

/** Is the RESPONSE switch in EXPONENTIAL? (the worklet's own `>= 0.5`). */
export function moog902IsExponential(p: Moog902Params): boolean {
  return p.mode >= MOOG902_EXP_THRESHOLD;
}

/** The multiplier the amplifier delivers with nothing patched, at these settings. */
export function moog902GainMultiplier(p: Moog902Params): number {
  return moog902Gain(p.gain * MOOG902_GAIN_POT_VOLTS, moog902IsExponential(p));
}

// ───────────────────────── the two readouts ─────────────────────────

/**
 * `gain` — what the amplifier is actually doing to the signal, in dB.
 *
 * ⚠ THE NEGATIVE CONTROL A KNOB READBACK FAILS IS THE RESPONSE SWITCH.
 * Measured on the shipping worklet: at the shipped defaults LINEAR delivers
 * ×1.0000000000 (exactly 0.0000 dB) and flipping to EXPONENTIAL delivers
 * ×0.7092463970 — **−2.9841 dB, on no dial movement at all** — and the gap is
 * as wide as **−5.4525 dB** near the bottom of the pot. The two laws agree ONLY
 * at the two anchors (0 V and 6 V), so a RESPONSE switch presented as a
 * character control is a LEVEL control everywhere in between. The GAIN dial
 * reads the same 0.50 either side of that.
 */
export function moog902GainDbText(p: Moog902Params): string {
  const g = moog902GainMultiplier(p);
  if (!(g > 0)) return 'mute';
  const db = 20 * Math.log10(g);
  if (!Number.isFinite(db)) return 'mute';
  const r = db.toFixed(1);
  // Avoid printing a signed zero ("-0.0 dB") for a value that rounds to unity.
  const shown = r === '-0.0' ? '0.0' : r;
  return `${db > 0 && shown !== '0.0' ? '+' : ''}${shown} dB`;
}

/**
 * `ceiling` — the control-sum voltage at which the amplifier stops rising.
 *
 * ⚠ ITS REACH IS DISJOINT FROM THE READOUT ABOVE, WHICH IS THE POINT. This one
 * is INVARIANT to the GAIN dial and moves ONLY on the RESPONSE switch (9.0 V
 * LINEAR → 7.5 V EXPONENTIAL); `moog902-gain-db` moves on BOTH. So each is the
 * other's control on every render, and neither is a knob relabelled: no dial on
 * this module prints volts, and the LIN/EXP names the segmented cell shows at
 * the dock carry no number at all.
 *
 * It is also the fact the docs got WRONG for the shipped default mode (#1912) —
 * so the faceplate now prints the measured answer where the prose used to
 * assert 7.5 V for both.
 */
export function moog902CeilingText(p: Moog902Params): string {
  return `${moog902CeilingVolts(moog902IsExponential(p)).toFixed(1)} V`;
}
