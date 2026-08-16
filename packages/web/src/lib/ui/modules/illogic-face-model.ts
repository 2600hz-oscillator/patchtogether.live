// packages/web/src/lib/ui/modules/illogic-face-model.ts
//
// THE DERIVED MODEL behind ILLOGIC's faceplate readouts and its routing
// picture. Pure, browser-safe, no Web Audio: it takes the four live
// attenuverter values and returns the four BUS GAINS the module's four knobs
// decide but cannot print.
//
// WHY THESE FOUR NUMBERS. ILLOGIC has four dials and TEN jacks, and the dials
// are all the same dial. A knob readback tells a player what channel 3 is
// scaled by; nothing on the card tells them what any of the ten OUTPUTS will
// do, and three separate facts about those outputs are unreachable from a
// single dial:
//
//   sum   — the SUM bus's gain on a signal patched into every input at once
//           (a1 + a2 + a3 + a4). SIGNED: it is the sum of four bipolar
//           coefficients, so it CANCELS.
//   diff  — the DIFF bus's gain on that same signal. The DIFF bus inverts the
//           back half, so its common-mode gain is a1 + a2 − a3 − a4, and at the
//           SHIPPED DEFAULTS (all four at +1) that is EXACTLY ZERO. The module
//           leaves the factory with one of its two mix buses configured as a
//           common-mode NULL, which is a genuinely useful thing (patch the same
//           CV everywhere and DIFF stays silent until you unbalance a knob) and
//           is invisible on a card showing four identical faders at maximum.
//   peak  — the WORST CASE either bus can reach for full-scale ±1 inputs,
//           Σ|aN|. SIGN-BLIND by construction, which is what separates it from
//           the two above. Neither bus is scaled by 1/n, so at the defaults
//           this is ×4.00 on a CV convention of ±1 (measured: on a modest
//           0.9/0.9/0.6/0.4 stimulus, SUM leaves the ±1 rail on 26.8 % of
//           samples and DIFF on 39.2 %).
//   logic — the gain the LOGIC BLOCK applies to its inputs, which is ×1.00 at
//           every setting of every knob. AND / NAND / OR / NOT threshold the
//           RAW inputs, BEFORE the attenuverters, so four of the ten jacks are
//           bit-exactly immune to all four dials.
//
// ⚠ `logic` IS A CONSTANT ON PURPOSE, AND ITS GATE IS NOT IN THIS FILE. A
// readout function that ignores its reader is trivially invariant, so a unit
// test asserting "it does not move" proves nothing about the MODULE. What makes
// it honest is that the same claim is measured against the shipping factory in
// `art/scenarios/illogic/face-audit.test.ts`, which derives the affected port
// set FROM THE DEF (`LOGIC_OUT_IDS` below) and asserts, in both directions,
// that every gate-typed output is bit-exactly unmoved by every param while
// every cv-typed output is moved by at least one. The readout prints a number
// the artifact proves; it does not assert it on its own authority.

import { illogicDef } from '$lib/audio/modules/illogic';

/** The attenuverter param ids, in channel order, DERIVED from the def — there
 *  is no channel count anywhere in this file. */
export const ILLOGIC_ATT_PARAM_IDS: readonly string[] = illogicDef.params
  .filter((p) => /^att\d+_amount$/.test(p.id))
  .map((p) => p.id);

/** The four boolean jacks. DERIVED MEMBERSHIP: the logic half of this module is
 *  exactly its `gate`-typed outputs, and the mix half is exactly its `cv`-typed
 *  outputs. Both are read off the def so a port added to either half joins the
 *  right set without anyone editing a list. */
export const LOGIC_OUT_IDS: readonly string[] = illogicDef.outputs
  .filter((o) => o.type === 'gate')
  .map((o) => o.id);

/** The attenuverted + mixed jacks — see `LOGIC_OUT_IDS`. */
export const MIX_OUT_IDS: readonly string[] = illogicDef.outputs
  .filter((o) => o.type === 'cv')
  .map((o) => o.id);

/**
 * The DIFF bus's per-channel polarity: the front half is added, the back half
 * subtracted (`illogic.ts` routes att3/att4 through a GainNode(−1) before the
 * diff bus). Derived from the channel roster rather than typed as `[1,1,-1,-1]`
 * so it cannot disagree with `ILLOGIC_ATT_PARAM_IDS`, and ANCHORED to the
 * shipping factory by the ART sweep, which renders the real graph and asserts
 * the rendered DIFF equals the gain this array predicts.
 */
export const ILLOGIC_DIFF_SIGNS: readonly number[] = ILLOGIC_ATT_PARAM_IDS.map((_, i) =>
  i < ILLOGIC_ATT_PARAM_IDS.length / 2 ? 1 : -1,
);

/** The live attenuverter values in channel order, def defaults resolved for
 *  params the sparse `node.params` overlay has not touched. */
export function illogicFaceParams(read: (paramId: string) => number | undefined): number[] {
  return ILLOGIC_ATT_PARAM_IDS.map((id) => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return illogicDef.params.find((p) => p.id === id)?.defaultValue ?? 0;
  });
}

/** SUM bus gain on a signal present at every input: Σ aN. Signed. */
export function illogicSumGain(a: readonly number[]): number {
  return a.reduce((s, v) => s + v, 0);
}

/** DIFF bus gain on that same signal: Σ signN · aN. Signed; ZERO at defaults. */
export function illogicDiffGain(a: readonly number[]): number {
  return a.reduce((s, v, i) => s + v * (ILLOGIC_DIFF_SIGNS[i] ?? 1), 0);
}

/** Worst-case peak either mix bus reaches for full-scale ±1 inputs: Σ|aN|.
 *  Sign-BLIND — that is the property that makes it the other two's control. */
export function illogicBusCeiling(a: readonly number[]): number {
  return a.reduce((s, v) => s + Math.abs(v), 0);
}

/** The gain the logic block applies to in1/in2 — unity, always. See the ⚠ in
 *  the header for why this takes the params it does not use. */
export function illogicLogicGain(_a: readonly number[]): number {
  return 1;
}

/** The CV bus convention every mix output is measured against. A physical
 *  convention, not a population: ±1 is what a `cv` cable carries here. */
export const ILLOGIC_CV_RAIL = 1;

/** `×4.00` / `×−2.00` / `×0.00`. TOTAL — a non-finite input prints a dash
 *  rather than throwing, because this runs on every faceplate render. */
export function fmtBusGain(x: number): string {
  if (!Number.isFinite(x)) return '—';
  // -0 must not print as `×−0.00`.
  const v = Object.is(x, -0) ? 0 : x;
  const sign = v < 0 ? '−' : '';
  return `×${sign}${Math.abs(v).toFixed(2)}`;
}

export const illogicSumGainText = (read: (p: string) => number | undefined): string =>
  fmtBusGain(illogicSumGain(illogicFaceParams(read)));
export const illogicDiffGainText = (read: (p: string) => number | undefined): string =>
  fmtBusGain(illogicDiffGain(illogicFaceParams(read)));
export const illogicBusCeilingText = (read: (p: string) => number | undefined): string =>
  fmtBusGain(illogicBusCeiling(illogicFaceParams(read)));
export const illogicLogicGainText = (read: (p: string) => number | undefined): string =>
  fmtBusGain(illogicLogicGain(illogicFaceParams(read)));

// ── The routing picture's geometry ──────────────────────────────────────────
//
// Shared with `IllogicRoutingPanel.svelte` so the drawing and its gate read one
// source. The picture's whole job is §1 of the audit: the logic taps leave the
// input line BEFORE the attenuverter triangle, the mix taps leave it after.

/** One row of the picture. `logic` is whether this channel reaches the boolean
 *  jacks at all — in3/in4 do not, which is the asymmetry that ranks them. */
export interface IllogicChannelRow {
  readonly index: number;
  readonly paramId: string;
  /** The attenuverter's live value, −1..+1. */
  readonly amount: number;
  /** +1 if this channel is ADDED in the DIFF bus, −1 if subtracted. */
  readonly diffSign: number;
  /** Does the raw input reach the logic block? */
  readonly logic: boolean;
}

/**
 * The INPUT PORT IDS the logic block taps, and the one that drives NOT alone.
 *
 * These are the one pair of structural facts about this module that nothing in
 * the def declares — `illogic.ts`'s factory fans in1/in2 into the threshold
 * WaveShapers ahead of their attenuverters, and routes in1 alone to the NOT
 * inversion. So they are DECLARED here, by PORT ID rather than by index, and
 * they are guarded two ways rather than taken on trust:
 *
 *  1. A name that no longer resolves to a declared input is RED
 *     (`illogic-face-model.test.ts`), so a renamed port cannot leave a stale
 *     entry drawing a line to nothing.
 *  2. ANCHORED TO THE ARTIFACT: `art/scenarios/illogic/face-audit.test.ts`
 *     drives each input ALONE through the shipping factory and asserts that
 *     the set of inputs which move a gate-typed output is exactly this set,
 *     and that the set which moves `not` is exactly `{ILLOGIC_NOT_INPUT}`.
 *     A rewire reddens there, not on this declaration's word.
 */
export const ILLOGIC_LOGIC_TAPPED_INPUTS: ReadonlySet<string> = new Set(['in1', 'in2']);

/** The single input NOT inverts — see `ILLOGIC_LOGIC_TAPPED_INPUTS`. */
export const ILLOGIC_NOT_INPUT = 'in1';

/** The input port id feeding channel `i` (channel N ↔ `inN`, the def's own
 *  convention — asserted total in `illogic-face-model.test.ts`). */
export function illogicChannelInputId(i: number): string {
  return `in${i + 1}`;
}

/** The picture's rows, from the live params. */
export function illogicChannelRows(read: (paramId: string) => number | undefined): IllogicChannelRow[] {
  const amounts = illogicFaceParams(read);
  return ILLOGIC_ATT_PARAM_IDS.map((paramId, i) => ({
    index: i,
    paramId,
    amount: amounts[i] ?? 0,
    diffSign: ILLOGIC_DIFF_SIGNS[i] ?? 1,
    logic: ILLOGIC_LOGIC_TAPPED_INPUTS.has(illogicChannelInputId(i)),
  }));
}
