// packages/web/src/lib/ui/modules/analog-logic-maths-face-model.ts
//
// THE DERIVED MODEL behind ANALOGLOGICMATHS' faceplate readouts and its
// transfer picture. Pure, browser-safe, no Web Audio: it takes the two live
// attenuverter values and returns the four numbers the module's two knobs
// decide but cannot print.
//
// WHY THESE FOUR NUMBERS. ALM has TWO dials and FIVE simultaneous jacks, and
// every one of the five is a different function of the SAME two dials. A knob
// readback tells a player that ATT A is at +1; nothing on the card tells them
// what any of the five jacks does with that, and four separate facts about
// those jacks are unreachable from a single dial:
//
//   sum   — what a full-scale COMMON-MODE input leaves the SUM jack at,
//           `tanh(x·attA + x·attB) / x`. ⚠ THE ONLY NON-LINEAR ROW. SUM is not
//           a mixer, it is a SATURATOR: the nameplate gain of two dials at +1
//           is ×2.00 and what actually comes out is ×0.96. Both dials sit
//           INSIDE the tanh, so neither can print it — that is the JOIN this
//           face exists for.
//   diff  — DIFF's gain on that same input, `attA − attB`. LINEAR, and ×0.00 AT
//           THE SHIPPED DEFAULTS: the module leaves the factory with one of its
//           five jacks configured as a common-mode NULL, underneath two faders
//           both sitting at maximum.
//   ring  — what that input leaves the PRODUCT jack at,
//           `tanh(x·attA · x·attB) / x`. The one place the two dials MULTIPLY
//           rather than add, so halving both QUARTERS it while `peak` merely
//           halves.
//   peak  — the largest excursion ANY of the five jacks can produce for
//           in-range ±1 inputs, `Σ|attN|`. SIGN-BLIND by construction, which is
//           what separates it from the three above. ×2.00 at the defaults on a
//           bus whose convention is ±1 — and it is DIFF's ceiling alone,
//           because SUM and PRODUCT are tanh-bounded strictly under 1 and
//           MIN/MAX select between two values neither of which can exceed its
//           own attenuverted input.
//
// ⚠ EVERY ROW IS STATED AT THE ±1 FULL-SCALE PROBE (`ALM_PROBE`), and that
// matters for exactly one of them. `diff`, `ring` and `peak` scale with the
// input. `sum` does NOT — `tanh` makes SUM's gain a function of the DRIVE as
// well as of the dials: at the shipped defaults a full-scale input sees ×0.96
// and a TENTH-scale input sees ×1.97 (measured, not rounded — tanh has no
// transparent region, only a shallow one, and ×2.00 would be a transcription).
// Printing one number for a level-dependent gain is honest only because the row
// it sits in names the probe: `peak` says ×2.00 in the same units, and the GAP
// between ×2.00 and ×0.96 is the compression.
//
// ⚠ THE LAWS ARE NOT ASSERTED ON THIS FILE'S AUTHORITY.
// `art/scenarios/analog-logic-maths/face-audit.test.ts` renders the SHIPPING
// worklet through the def's own factory and measures each of the four at the
// jack, with the dB reference named in every assertion message.

import { analogLogicMathsDef } from '$lib/audio/modules/analog-logic-maths';

/** The attenuverter param ids, in channel order, DERIVED from the def — there
 *  is no channel count anywhere in this file. */
export const ALM_ATT_PARAM_IDS: readonly string[] = analogLogicMathsDef.params
  .filter((p) => /^att[AB]$/.test(p.id))
  .map((p) => p.id);

/** The algebra jacks, DERIVED: every declared output of this module is a `cv`
 *  jack, so the set is the whole output roster. A jack of another type would
 *  drop out here rather than be silently folded in. */
export const ALM_OUT_IDS: readonly string[] = analogLogicMathsDef.outputs
  .filter((o) => o.type === 'cv')
  .map((o) => o.id);

/** The jacks whose law is a SOFT-CLIP, and the jacks whose law is LINEAR.
 *  Declared by PORT ID, guarded two ways: a name that no longer resolves to a
 *  declared output is RED (`analog-logic-maths-face-model.test.ts`), and the
 *  partition is ANCHORED TO THE ARTIFACT — `face-audit.test.ts` drives the
 *  shipping worklet past the rail and asserts that exactly the clipped set
 *  stays inside ±1 while exactly the linear set is proportional to its drive. */
export const ALM_CLIPPED_OUT_IDS: ReadonlySet<string> = new Set(['sum', 'product']);

/** See `ALM_CLIPPED_OUT_IDS`. DERIVED as the complement so the two cannot
 *  disagree, and so a new jack lands in one of them rather than in neither. */
export const ALM_LINEAR_OUT_IDS: readonly string[] = ALM_OUT_IDS.filter(
  (id) => !ALM_CLIPPED_OUT_IDS.has(id),
);

/**
 * The CV/audio bus convention, and the drive amplitude every row above is
 * stated at. A PHYSICAL convention, not a population: ±1 is what a `cv` cable
 * carries here, and it is also full scale for audio.
 */
export const ALM_PROBE = 1;

/** The live attenuverter values in channel order, def defaults resolved for
 *  params the sparse `node.params` overlay has not touched. */
export function almFaceParams(read: (paramId: string) => number | undefined): number[] {
  return ALM_ATT_PARAM_IDS.map((id) => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return analogLogicMathsDef.params.find((p) => p.id === id)?.defaultValue ?? 0;
  });
}

/**
 * SUM's gain on a full-scale common-mode input: `tanh(x·Σa) / x`.
 *
 * NON-LINEAR IN THE DIALS AND IN THE DRIVE — the only row here that is either.
 * At the shipped defaults the un-clipped sum would be ×2.00 and this returns
 * ×0.96, a compression of −6.34 dB AGAINST THAT REFERENCE (measured on the
 * shipping worklet, `face-audit.test.ts` M3).
 */
export function almSumGain(a: readonly number[], x = ALM_PROBE): number {
  return Math.tanh(x * a.reduce((s, v) => s + v, 0)) / x;
}

/**
 * DIFF's gain on that same input: `attA − attB`. LINEAR — there is no soft-clip
 * on this jack, which is the module's biggest asymmetry and the reason `peak`
 * below is DIFF's number. ZERO at the shipped defaults.
 */
export function almDiffGain(a: readonly number[]): number {
  return a.reduce((s, v, i) => s + (i === 0 ? v : -v), 0);
}

/**
 * PRODUCT's gain on that input: `tanh(x²·Πa) / x`. The dials MULTIPLY here and
 * ADD everywhere else, so this is the row that tells a rescale from a
 * rebalance.
 */
export function almRingGain(a: readonly number[], x = ALM_PROBE): number {
  return Math.tanh(x * x * a.reduce((p, v) => p * v, 1)) / x;
}

/**
 * The worst-case excursion ANY jack can produce for in-range ±1 inputs, as a
 * gain: `Σ|attN|`. SIGN-BLIND by construction — that is the property that makes
 * it the other three's control, because the sign flip which SWAPS `sum` and
 * `diff` leaves this one still.
 *
 * Asserted in BOTH directions in `face-audit.test.ts` M5: nothing else reaches
 * it, and DIFF attains it.
 */
export function almPeak(a: readonly number[]): number {
  return a.reduce((s, v) => s + Math.abs(v), 0);
}

/**
 * `×0.96` / `×−2.00` / `×0.00`. TOTAL — a non-finite input prints a dash rather
 * than throwing, because this runs on every faceplate render.
 *
 * Deliberately NOT imported from `illogic-face-model`, which prints the same
 * shape: the two modules look alike today by the coincidence of both being
 * attenuverter front-ends, and a shared formatter would let one module's
 * presentation change the other's face with no diff on that module's def.
 */
export function fmtAlmGain(v: number): string {
  if (!Number.isFinite(v)) return '—';
  // -0 must not print as `×−0.00`.
  const n = Object.is(v, -0) ? 0 : v;
  const sign = n < 0 ? '−' : '';
  return `×${sign}${Math.abs(n).toFixed(2)}`;
}

export const almSumGainText = (read: (p: string) => number | undefined): string =>
  fmtAlmGain(almSumGain(almFaceParams(read)));
export const almDiffGainText = (read: (p: string) => number | undefined): string =>
  fmtAlmGain(almDiffGain(almFaceParams(read)));
export const almRingGainText = (read: (p: string) => number | undefined): string =>
  fmtAlmGain(almRingGain(almFaceParams(read)));
export const almPeakText = (read: (p: string) => number | undefined): string =>
  fmtAlmGain(almPeak(almFaceParams(read)));

// ── The transfer picture's geometry ─────────────────────────────────────────
//
// Shared with `AnalogLogicMathsTransferPanel.svelte` so the drawing and its
// gate read one source. The picture's whole job is the thing the numbers state
// but cannot show: SUM BENDS AND DIFF DOES NOT, and it is the STRAIGHT line
// that leaves the rail.
//
// ⚠ ONE STIMULUS FOR BOTH CURVES — a COMMON-MODE input, the same one `sum` and
// `diff` are stated at — so the picture and the readout row cannot disagree.
// The alternative (drive DIFF anti-phase so it always looks busy) would have
// drawn a livelier picture and a different measurement from the one printed
// two inches away.

/** One traced curve. `at` maps a common-mode input `x` to that jack's output. */
export interface AlmTransferCurve {
  /** The jack this curve belongs to — a member of `ALM_OUT_IDS`. */
  readonly outId: string;
  /** Whether this jack's law is a soft-clip (`ALM_CLIPPED_OUT_IDS`). */
  readonly clipped: boolean;
  readonly at: (x: number) => number;
}

/**
 * The two traced curves, under one common-mode drive: SUM (soft-clipped) and
 * DIFF (linear). At the shipped defaults SUM bends over toward ×0.96 while DIFF
 * lies flat on zero — and inverting ATT B SWAPS them, which is the single most
 * useful gesture this picture teaches.
 */
export function almTransferCurves(a: readonly number[]): AlmTransferCurve[] {
  const sum = a.reduce((s, v) => s + v, 0);
  const diff = almDiffGain(a);
  return [
    { outId: 'sum', clipped: ALM_CLIPPED_OUT_IDS.has('sum'), at: (x) => Math.tanh(x * sum) },
    { outId: 'diff', clipped: ALM_CLIPPED_OUT_IDS.has('diff'), at: (x) => x * diff },
  ];
}

/**
 * The picture's y half-extent, so the ±1 rail marks and both curves share one
 * scale. DERIVED from the live dials rather than pinned, so a pair at ±0.4
 * fills its box instead of drawing two near-flat lines. Never below the rail
 * itself — the ±1 marks must always be visible, since "DIFF goes outside them"
 * is the whole point of the drawing.
 */
export function almTransferSpan(a: readonly number[]): number {
  return Math.max(ALM_PROBE * 1.15, almPeak(a) * ALM_PROBE * 1.05);
}
