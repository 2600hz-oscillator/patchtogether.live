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

// ── THE MIRRORED DSP CONSTANTS ──────────────────────────────────────────────

/** `20·log10(2)` — `compressor-dsp.ts` `DB_PER_LOG2`. It appears here TWICE
 *  over, and the two uses are unrelated: it is the log2→dB bridge inside the
 *  gain computer, AND it is exactly the offset a stereo-linked sum of
 *  rectifiers adds to a mono main (`|a| + |a| = 2|a|`). */
export const SIDECAR_DB_PER_LOG2 = 20 * Math.log10(2);

/** `compressor-dsp.ts` `ENV_SCALE_DB` — the reduction at which ENV reaches 1.0
 *  when `envMag` is 1. NOT a knob; a documented constant. */
export const SIDECAR_ENV_SCALE_DB = 24;

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
 * The static soft-knee gain computer, in dB in and dB out — the same three
 * regions as `compressor-dsp.ts` `computeGainDb` (GMR 2012 eq 4), expressed
 * against a DETECTOR level in dB rather than in log2.
 *
 * Returns the gain to APPLY (≤ 0; more negative = more ducking).
 */
export function sidecarGainDb(detectorDb: number, p: SidecarFaceParams): number {
  const slope = 1 - 1 / Math.max(1, p.ratio);
  const halfKn = p.knee * 0.5;
  if (p.knee <= 0 || detectorDb <= p.threshold - halfKn) {
    if (detectorDb <= p.threshold) return 0;
    return -slope * (detectorDb - p.threshold);
  }
  if (detectorDb >= p.threshold + halfKn) return -slope * (detectorDb - p.threshold);
  const t = detectorDb - p.threshold + halfKn;
  return (-slope * (t * t)) / (2 * p.knee);
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
  return sidecarGainDb(SIDECAR_REFERENCE_DETECTOR_DB, p);
}

/** `-18.0 dB` at the shipped defaults; `none` at ratio 1. */
export function sidecarDuckText(p: SidecarFaceParams): string {
  const v = sidecarDuckDb(p);
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
  return (-sidecarDuckDb(p) / SIDECAR_ENV_SCALE_DB) * Math.max(0, p.envMag);
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
  if (!(p.envMag > 0)) return 'off';
  const v = sidecarEnvAtRef(p);
  if (!Number.isFinite(v)) return '—';
  return v > 1 ? `${v.toFixed(2)} over` : v.toFixed(2);
}
