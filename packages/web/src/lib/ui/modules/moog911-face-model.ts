// packages/web/src/lib/ui/modules/moog911-face-model.ts
//
// The PURE model behind the MOOG 911 faceplate — how long each stage of the
// contour ACTUALLY takes, as a function of the live params.
//
// WHY A MODEL FOR A FOUR-KNOB MODULE. Because three of the four knobs print a
// duration the module does not deliver, and one of the three is wrong by the
// amount a DIFFERENT knob is turned.
//
// `Moog911Eg.step` advances each stage by an exponential one-pole toward that
// stage's target, with the per-sample coefficient
//
//     egCoeff(T, sr) = 1 − exp(−TAU_DECADES / (T · sr))
//
// so `T` is a TIME CONSTANT (a ~99.3 % approach over `T` seconds), not the
// stage's duration. Each stage then exits on ITS OWN threshold — attack when
// `level >= 0.999`, decay when `|level − esus| <= 1e-3`, release when
// `level <= 1e-4`. The delivered duration is therefore
//
//     t_stage = T · ln(k) / TAU_DECADES
//
// where `k` is the ratio between the stage's STARTING gap and its EXIT gap.
// Only the attack's `k` is a constant (`1 / 1e-3`). The decay's is
// `(1 − esus) / 1e-3` and the release's is `esus / 1e-4`, so **both are
// functions of the SUSTAIN LEVEL knob** and neither dial moves when it does.
//
// Measured against the SHIPPING worklet class at 48 kHz (held gate, reading the
// exact sample each stage's exit condition latches), at the def's own defaults:
//
//   t1 = 0.01  dial 10.000 ms  -> delivered  13.833 ms   (x1.3833)
//   t2 = 0.2   dial 200.000 ms -> delivered 239.667 ms   (x1.1983)
//   t3 = 0.4   dial 400.000 ms -> delivered 695.958 ms   (x1.7399)
//   ------------------------------------------------------------
//   the three dials sum to 610 ms; the contour takes 949.458 ms (x1.5565)
//
// and holding `t2` at its default while sweeping ESUS moves the delivered decay
// 276.313 -> 262.063 -> 239.667 -> 92.104 -> 0.021 ms (ESUS 0 / 0.3 / 0.6 /
// 0.99 / >= 0.999) **while the T2 dial reads 200.000 at every one of them.**
// That is the kick-drum TAIL trap with the numbers filled in: a reviewer
// checking "does the decay readout move when I turn the decay knob" gets a
// green, and the readout is still blind to the input that swings the answer
// 13 800x.
//
// EVERY CONSTANT HERE IS EITHER IMPORTED FROM THE DSP CORE OR MIRRORED AND
// RE-DERIVED BY AN ORACLE. `TAU_DECADES` and `MIN_TIME_S` are exported by
// `moog911-eg-dsp.ts` and imported below, so they have exactly one source. The
// three STAGE-EXIT thresholds are inline literals in that core's `step()` and
// cannot be imported; they are mirrored here with a stated reason, and
// `art/scenarios/moog911/face-audit.test.ts` RECOVERS each one from the
// SHIPPING worklet's own delivered durations, so a mirror that drifts from the
// DSP it describes is RED rather than merely stale. (The `moog923-face-model` /
// `moog921-face-model` discipline.)
//
// PURE: no DOM, no engine, no store, no fs, and no sample rate — every function
// is a closed form in seconds, so the same numbers hold at 44.1 and 48 kHz.
// ⚠ The ONE exception is the instant-snap branch: `egCoeff` returns 1 for
// `T <= MIN_TIME_S`, which completes a stage in a single SAMPLE. That duration
// is rate-dependent (0.0208 ms at 48 kHz), so the model reports 0 — "instant" —
// rather than pretending to a precision it does not have. Reporting it at all
// is deliberate: `MIN_TIME_S` equals the def's own declared `min` and the guard
// is `<=`, so the dial's LAST REACHABLE VALUE is 7x faster than the one
// adjacent to it (1 sample vs 7 at 48 kHz). The face prints that cliff instead
// of smoothing it over. It is filed as part of #1885.

import { MIN_TIME_S, TAU_DECADES } from '../../../../../dsp/src/lib/moog911-eg-dsp';

// RELATIVE path, not the `@patchtogether.live/dsp/src/...` alias, for the reason
// `moog921-face-model.ts` / `ninelives-face-model.ts` / `moog-filterbank-face-model.ts`
// all document: a worktree may not symlink the workspace package under
// node_modules, and the TS path-alias rules do not reliably resolve TS source
// out of there.

import { moog911Def } from '$lib/audio/modules/moog911';

// ── THE MIRRORED STAGE-EXIT THRESHOLDS ──────────────────────────────────────
//
// ⚠ MIRRORED, NOT IMPORTED, and that is the weak seam in this file. All three
// are inline literals inside `Moog911Eg.step` (`moog911-eg-dsp.ts:87,96,108`)
// rather than named exports, so there is no symbol to import. Exporting them
// would edit a file the ART `.sha` pin covers and force an `art:update` on a
// change that alters no audio, which is why the repo's other face models mirror
// in this situation instead. What makes the mirror safe is that the ART oracle
// RECOVERS each threshold from the shipping worklet — inverting
// `gap_exit = gap_start · exp(−TAU·t/T)` on a measured duration at a long `T`,
// where sample quantisation is ~0.005 % of the exponent — and compares it to
// the value below. So these lines cannot drift silently, only RED.

/** ATTACK exits when `level >= 0.999` (`moog911-eg-dsp.ts:87`). */
export const MOOG911_ATTACK_PEAK = 0.999;
/** DECAY exits when `|level − esus| <= 1e-3` (`moog911-eg-dsp.ts:96`). */
export const MOOG911_DECAY_SETTLE_EPS = 1e-3;
/** RELEASE exits when `level <= 1e-4` (`moog911-eg-dsp.ts:108`). */
export const MOOG911_RELEASE_FLOOR = 1e-4;

// ── THE LIVE PARAMS ─────────────────────────────────────────────────────────

/** The four params every readout on this face is a function of. */
export interface Moog911FaceParams {
  t1: number;
  t2: number;
  esus: number;
  t3: number;
}

/** The def's own spawn defaults — DERIVED from `moog911Def.params`, never
 *  re-typed, so a default change cannot leave this file printing the old one on
 *  a fresh node. */
const DEFAULTS: Moog911FaceParams = {
  t1: paramDefault('t1'),
  t2: paramDefault('t2'),
  esus: paramDefault('esus'),
  t3: paramDefault('t3'),
};

function paramDefault(id: keyof Moog911FaceParams): number {
  const p = moog911Def.params.find((q) => q.id === id);
  if (!p) throw new Error(`moog911-face-model: no param '${id}' on moog911Def`);
  return p.defaultValue;
}

/**
 * Read the four params off a live reader. Anything missing or non-finite falls
 * back to the def's declared default — a fresh node has written nothing yet,
 * and `FaceReadoutValue` runs on EVERY render, so a NaN reaching the arithmetic
 * would take the faceplate down mid-drag.
 */
export function moog911FaceParams(
  read: (paramId: string) => number | undefined,
): Moog911FaceParams {
  const one = (k: keyof Moog911FaceParams): number => {
    const v = read(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[k];
  };
  return { t1: one('t1'), t2: one('t2'), esus: one('esus'), t3: one('t3') };
}

/**
 * `Moog911Eg.step` clamps `esus` into 0..1 before using it; so does this.
 *
 * ⚠ AND IT ROUNDS TO FLOAT32, which is not decoration. The worklet reads `esus`
 * out of a `Float32Array` AudioParam buffer, so the value the DSP compares
 * against its exit thresholds is `Math.fround(esus)` — and the two NULL REGIONS
 * this face prints sit exactly ON those comparisons. At `esus = 0.999` the
 * float64 subtraction `1 − 0.999` lands a hair ABOVE `1e-3` and a float64 model
 * reports a 3.6e-14 ms stage where the shipping DSP exits on the first sample;
 * `1 − Math.fround(0.999)` lands below it and the two agree. The bisected
 * boundary (0.998999983, measured on the worklet) is the float32 grid showing
 * through, which is why mirroring the ROUNDING is what makes the model match.
 */
function clampEsus(esus: number): number {
  if (!Number.isFinite(esus)) return Math.fround(DEFAULTS.esus);
  return Math.fround(esus < 0 ? 0 : esus > 1 ? 1 : esus);
}

/**
 * The shared law: a stage whose gap to its target starts at `gapStart` and
 * exits at `gapExit` takes `T · ln(gapStart/gapExit) / TAU_DECADES` seconds.
 *
 * Returns 0 for the two ways a stage takes no time at all, both of which are
 * real behaviour rather than guards: the instant-snap branch (`T <= MIN_TIME_S`,
 * where `egCoeff` returns 1) and a stage that starts ALREADY INSIDE its own exit
 * threshold (`gapStart <= gapExit`, the null regions).
 */
function stageMs(timeS: number, gapStart: number, gapExit: number): number {
  if (!Number.isFinite(timeS) || timeS <= MIN_TIME_S) return 0;
  if (!Number.isFinite(gapStart) || !(gapStart > gapExit)) return 0;
  return (1000 * timeS * Math.log(gapStart / gapExit)) / TAU_DECADES;
}

// ── THE THREE DELIVERED DURATIONS ───────────────────────────────────────────

/**
 * ATTACK — how long the contour takes to reach peak, in ms.
 *
 * The gap to 1.0 starts at 1 and exits at `1 − 0.999`, so the ratio is a
 * CONSTANT 1000 and the delivered time is a flat `T1 · ln(1000)/5 = T1 ×
 * 1.38155`. **This is the instrument's own negative control**: it is EXACTLY
 * invariant to ESUS while the other two readouts are not, so publishing all
 * three makes every render its own check (the `clap-q` / `clap-bandwidth-hz`
 * pattern). If ESUS ever moves this number, the model is wrong.
 */
export function moog911AttackMs(p: Moog911FaceParams): number {
  return stageMs(p.t1, 1, 1 - MOOG911_ATTACK_PEAK);
}

/**
 * INITIAL DECAY — how long the contour takes to settle from peak onto the
 * sustain shelf, in ms.
 *
 * The gap starts at `1 − esus` and exits at `1e-3`, so **the SUSTAIN LEVEL knob
 * sets the duration of the DECAY knob's stage.** Collapses to 0 once
 * `1 − esus <= 1e-3` (ESUS >= 0.999) — the stage is already inside its exit
 * threshold on the first sample, which is the bit-exact null region #1885
 * bisected to the top 0.1 % of the ESUS dial. The face prints it as `0 ms`
 * rather than leaving the dial claiming 200.
 */
export function moog911DecayMs(p: Moog911FaceParams): number {
  const esus = clampEsus(p.esus);
  return stageMs(p.t2, 1 - esus, MOOG911_DECAY_SETTLE_EPS);
}

/**
 * FINAL DECAY — how long the release takes FROM THE SUSTAIN SHELF, in ms.
 *
 * The gap starts at `esus` (the level the contour is holding at when the gate
 * falls) and exits at `1e-4`, so this too is set by the SUSTAIN LEVEL knob:
 * 0.000 / 640.500 / 695.958 / 736.813 ms at ESUS 0 / 0.3 / 0.6 / 1, with the T3
 * dial reading 400.000 at all four.
 *
 * ⚠ FROM SUSTAIN is the qualifier that makes the ESUS = 0 case honest, and
 * dropping it is a recorded misreading (queue §22.6, corrected by #1885): a
 * release that starts MID-ATTACK still has a real level to decay from, so T3 is
 * alive there. It is the shelf that is empty, not the stage.
 */
export function moog911ReleaseMs(p: Moog911FaceParams): number {
  const esus = clampEsus(p.esus);
  return stageMs(p.t3, esus, MOOG911_RELEASE_FLOOR);
}

/**
 * The WHOLE CONTOUR — rise + settle + fall, in ms, for a gate held at least
 * until the shelf is reached. 949.458 ms at the defaults against a dial sum of
 * 610 (×1.5565).
 */
export function moog911ContourMs(p: Moog911FaceParams): number {
  return moog911AttackMs(p) + moog911DecayMs(p) + moog911ReleaseMs(p);
}

// ── FORMATTING ──────────────────────────────────────────────────────────────

/**
 * A DURATION over five decades — this module's dials run 1e-4 .. 10 s, so the
 * delivered numbers span 0.14 ms to 13.8 s and no single fixed precision reads
 * well across that. Deliberately NOT `fmtMs` (integer ms, authored for a drum
 * where sub-ms is noise): here the bottom of the dial IS a readable region and
 * an integer-ms readout would print `0 ms` for the whole first decade.
 *
 * Local to this module rather than promoted into the shared vocabulary: it is
 * the only five-decade time ladder on any face today, and one instance is not a
 * pattern.
 */
export function fmtContourMs(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms}`;
  const v = ms < 0 ? 0 : ms;
  if (v === 0) return '0 ms';
  if (v < 10) return `${v.toFixed(2)} ms`;
  if (v < 100) return `${v.toFixed(1)} ms`;
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

/** `rise` — the delivered ATTACK. */
export function moog911RiseText(p: Moog911FaceParams): string {
  return fmtContourMs(moog911AttackMs(p));
}

/** `settle` — the delivered INITIAL DECAY, the one the ESUS knob re-times. */
export function moog911SettleText(p: Moog911FaceParams): string {
  return fmtContourMs(moog911DecayMs(p));
}

/** `fall` — the delivered FINAL DECAY from the sustain shelf. */
export function moog911FallText(p: Moog911FaceParams): string {
  return fmtContourMs(moog911ReleaseMs(p));
}
