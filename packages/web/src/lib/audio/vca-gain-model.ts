// packages/web/src/lib/audio/vca-gain-model.ts
//
// The VCA's GAIN LAW as a pure model — the four range numbers, the linear→dB
// conversion, and the two knob READOUTS the curated face paints.
//
// WHY A MODEL MODULE FOR A TWO-KNOB UTILITY. Two reasons, both structural
// rather than stylistic:
//
//  1. **The ranges must exist in ONE place.** `VcaCard.svelte` re-typed
//     `min={0} max={1} defaultValue={0}` / `min={-1} max={1} defaultValue={1}`
//     beside a def that declares exactly those numbers. They AGREE today — but
//     that is luck, not a guarantee: `contract-lock`, `module-docs-lint` and
//     every range assertion read the DEF, so a card that drifts is invisible to
//     the entire gate set (the BACKDRAFT ±1-vs-±0.2 XyPad class, CLAUDE.md).
//     The def imports these consts and so does the card, so there is nothing
//     left to drift.
//
//  2. **The readouts encode a DECISION that a nearest-neighbour lookup gets
//     wrong.** `cvAmount` is an ATTENUVERTER: its meaning is decided by a
//     BOUNDARY (the sign) and not by proximity to a waypoint. `ParamDef.
//     landmarks` resolves its readout by NEAREST value (knob-vocabulary-model
//     `knobReadout` → `nearestByValue`), so a landmark roster at −1/0/+1 would
//     print `CV OFF` for cvAmount = −0.4 — a value that is very much ducking.
//     That is a lie the dial tells about the module's MODE, so the sense law
//     lives here as real, unit-tested arithmetic and rides in through
//     `ParamDef.format` (which outranks landmarks in `knobReadout`).
//
// PURE + dependency-free (it imports nothing), so it runs in the `unit` lane at
// ~0 added CI wall-time and is testable without a browser or an AudioContext.

/** ONE declared range, shared by the def and the card. */
export interface VcaRange {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/**
 * `base` — the static gain FLOOR added to the scaled CV.
 * Default 0 is the Eurorack convention (silent until CV opens it) and it is the
 * single most-reported surprise about this module, which is why the face spends
 * a persistent readout saying `CLOSED` rather than `0.00`.
 */
export const VCA_BASE: VcaRange = { min: 0, max: 1, default: 0 };

/** `cvAmount` — the attenuverter: DEPTH and SIGN of the cv input. */
export const VCA_CV_AMOUNT: VcaRange = { min: -1, max: 1, default: 1 };

/**
 * The DISPLAY epsilon, and it is derived rather than picked.
 *
 * KnobConic's hover/drag value uses `toFixed(2)` under |v| < 10, so every value
 * with |v| < 0.005 is SHOWN as `0.00`. A persistent readout that said `DUCK`
 * while the hover said `0.00` would be a visible self-contradiction on the same
 * control — so the readout's dead-band is exactly the band that displays as
 * zero. Change the hover precision and this moves with it.
 */
export const VCA_DISPLAY_EPS = 0.005;

/**
 * The gain law the Faust DSP implements (`vca.dsp:11`,
 * `gain = base + cvAmount * cv : si.smoo`), before smoothing.
 *
 * Deliberately UNCLAMPED, exactly like the DSP: a sum above 1 boosts past
 * unity and a sum below 0 passes the signal phase-inverted. Clamping here would
 * make the model disagree with the engine, which is the whole failure this file
 * exists to prevent.
 *
 * It is the readouts' ORACLE rather than a render path: the unit test asserts
 * `vcaCvSense` against what raising `cv` actually DOES to this function, so the
 * face's claim about the module is pinned to the DSP's law instead of to
 * itself. A readout tested only against its own table is a tautology.
 */
export function vcaGain(base: number, cvAmount: number, cv: number): number {
  return base + cvAmount * cv;
}

/** Linear gain → dBFS. Returns −Infinity at 0 (and for any negative magnitude
 *  the caller should have handled as a phase inversion first). */
export function linearToDb(gain: number): number {
  return 20 * Math.log10(Math.abs(gain));
}

/**
 * What the CV input DOES to the gain, decided by the sign of `cvAmount`.
 *
 * NOT a nearest-waypoint question — see the header. `off` is the band that
 * DISPLAYS as zero, not the single float 0, so the readout can never contradict
 * the hover value.
 */
export type VcaCvSense = 'duck' | 'off' | 'open';

export function vcaCvSense(cvAmount: number): VcaCvSense {
  if (Math.abs(cvAmount) < VCA_DISPLAY_EPS) return 'off';
  return cvAmount > 0 ? 'open' : 'duck';
}

/** The readout text per sense. Uppercase because `.readout` uppercases anyway,
 *  and a lowercase source string would make the e2e's expected text a lie. */
export const VCA_CV_SENSE_LABEL: Readonly<Record<VcaCvSense, string>> = {
  duck: 'DUCK',
  off: 'CV OFF',
  open: 'OPEN',
};

/**
 * `cvAmount`'s persistent readout: the SENSE of the modulation.
 *
 * It names direction, never amount, and that is the point — the amount is
 * already on the dial (KnobConic prints the number on hover/drag), while
 * "positive amounts OPEN the VCA and negative ones DUCK it" is the meaning the
 * number does not carry on its own. That is the bar `knobReadout` sets for
 * earning a persistent readout at all.
 */
export function formatVcaCvAmount(cvAmount: number): string {
  return VCA_CV_SENSE_LABEL[vcaCvSense(cvAmount)];
}

/**
 * `base`'s persistent readout: the two gain LANDMARKS by name, and dB in
 * between.
 *
 * `CLOSED` at the default is the module's whole spawn-time surprise stated on
 * the panel. `UNITY` at 1 is the other end a patcher aims for. Between them the
 * linear number is the one thing that does NOT say how loud it is — 0.5 is not
 * half as loud — so the readout converts it. dB is the floor's gain WITH NO CV
 * PRESENT; once CV arrives the resolved gain is `base + cv × amount`, which is
 * what the band header states.
 */
export function formatVcaBase(base: number): string {
  if (base < VCA_DISPLAY_EPS) return 'CLOSED';
  if (base > VCA_BASE.max - VCA_DISPLAY_EPS) return 'UNITY';
  // `toFixed` preserves the sign of a value that rounds to zero, so the thin
  // band just under the UNITY threshold would otherwise read `-0.0 dB`.
  const db = linearToDb(base).toFixed(1);
  return `${db === '-0.0' ? '0.0' : db} dB`;
}

/**
 * The ONE detent worth marking on an attenuverter: the null point at 12
 * o'clock, where the CV stops reaching the gain at all.
 *
 * A roster at ±1 as well was considered and dropped — those ticks would land on
 * the arc's own endpoints, where the pointer visibly stops anyway. The label
 * matches `formatVcaCvAmount`'s `off` string on purpose: KnobConic lights
 * `.tick.at` when the readout NAMES that landmark, so the detent illuminates
 * exactly when the CV path is dead.
 */
export const VCA_CV_AMOUNT_LANDMARKS = [
  { value: 0, label: VCA_CV_SENSE_LABEL.off },
] as const;
