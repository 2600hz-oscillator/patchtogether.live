// packages/web/src/lib/ui/modules/slewswitch-face-model.ts
//
// THE PURE MODEL behind SLEWSWITCH's derived readouts — the arithmetic the
// faceplate prints, kept out of the shell and out of the def so both can import
// it and neither can hold a second copy.
//
// WHY EVERY ONE OF THESE IS DERIVED RATHER THAN A KNOB RELABELLED. This module
// has seven params and SEVEN jacks, and no dial on it prints the quantity a
// player actually needs from the jack in front of them:
//
//   settle    THE READOUT THE AUDIT PRODUCED (#1712). The slew dials are the
//             TAU of a one-pole, not the arrival time: at t = tau the output is
//             63.2 % of the way there, and 99 % needs ln(100) = 4.605 taus.
//             MEASURED on the shipped worklet across three decades, t99/tau =
//             4.604 / 4.605 / 4.605. So the dial says 0.5 s and the channel
//             arrives in 2.30 s — the number is 4.6x the one on the control,
//             at every position, and the docs said the dial WAS the arrival
//             time until this readout's measurement corrected them.
//             The hero row prints the SLOWEST of the four, which no single dial
//             can know: raising S3 above S1 changes the answer while the S1
//             readback does not move.
//   spread    The ratio slowest/fastest across the four channels — "are these
//             four doing the same thing or four different things". 1.00x at
//             spawn, and INVARIANT to moving all four together, which is
//             exactly the dimension `settle` is blind to. Publishing both is
//             the pair's own negative control: settle is invariant to lowering
//             the FASTEST channel, spread is not; spread is invariant to
//             scaling all four, settle is not.
//   lap       CLOCKS PER CYCLE, and it is a function of MODE and LENGTH
//             TOGETHER — neither dial can print it and the pendulum term is not
//             a number either dial suggests. Forward laps in `length` clocks;
//             PENDULUM takes 2(length-1) because it walks up and back down
//             without repeating the ends; random has no cycle and pulses EOC
//             every step. At the shipped length 4 that is 4 / 6 / 1, and the
//             MODE dial reads `FWD` in all three cases.
//   step      The CV DISTANCE between adjacent steps on `step_idx`, 2/(len-1).
//             The jack is documented as -1..+1 across the active channels, so
//             the spacing changes with LENGTH and nothing says by how much:
//             0.667 at length 4, 1.0 at 3, 2.0 at 2, and at length 1 there is
//             no spread at all and the jack sits at 0.
//
// ⚠ NOTHING HERE IS RE-TYPED FROM THE DEF. Every range, default and roster is
// read off `slewSwitchDef`, and the channel roster is DERIVED from the params
// rather than listed, so adding a fifth slew channel cannot leave a stale four
// behind. `slewswitch-face-model.test.ts` re-derives every claim from the same
// imports and drives the real worklet for the ones that are behavioural.
//
// PURE: no DOM, no engine, no store.

import { slewSwitchDef } from '$lib/audio/modules/slewswitch';

/**
 * The fraction of a step a one-pole has covered after `n` taus, and the `n`
 * that reaches 99 %. NOT a DSP constant and not a tuning choice — it is the
 * inverse of the exponential the worklet implements (`alpha = 1 - exp(-dt/tau)`
 * integrates to `1 - exp(-t/tau)`), so `t99 = tau * ln(100)`. Named here rather
 * than written as `4.605` so the derivation travels with the number.
 */
export const SETTLE_TAUS = Math.log(100);

/** …and the 63 % figure the docs quote, from the same exponential. */
export const ONE_TAU_FRACTION = 1 - 1 / Math.E;

/** The def's slew params, IN CHANNEL ORDER, derived from the declaration rather
 *  than listed — the roster is `slew<N>` and the switch scans it in that order,
 *  so this is the same order `advance()` walks. A fifth channel would appear
 *  here automatically; a renamed one would empty the list and redden the
 *  model's own non-vacuity leg. */
export const SLEW_PARAM_IDS: readonly string[] = slewSwitchDef.params
  .filter((p) => /^slew\d+$/.test(p.id))
  .map((p) => p.id)
  .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

export interface SlewSwitchFaceParams {
  /** tau per channel, in channel order — same length as SLEW_PARAM_IDS. */
  slews: readonly number[];
  mode: number;
  length: number;
  xfadeTime: number;
}

/**
 * Resolve the live params a readout sees: the def's own default for anything
 * untouched (`node.params` is a SPARSE overlay), and a CLAMP to the declared
 * range for anything a corrupt save or a mid-drag NaN hands us. A readout runs
 * on every render, so a non-finite must never reach the arithmetic.
 */
export function slewSwitchFaceParams(
  read: (paramId: string) => number | undefined,
): SlewSwitchFaceParams {
  const val = (id: string): number => {
    const p = slewSwitchDef.params.find((q) => q.id === id)!;
    const raw = read(id);
    const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : p.defaultValue;
    return Math.max(p.min, Math.min(p.max, v));
  };
  return {
    slews: SLEW_PARAM_IDS.map(val),
    mode: val('mode'),
    length: val('length'),
    xfadeTime: val('xfadeTime'),
  };
}

// ── the scan ────────────────────────────────────────────────────────────────

/** LENGTH as the worklet reads it: rounded and clamped to the declared range.
 *  Mirrors `Math.max(1, Math.min(4, Math.round(parameters.length[0])))`, with
 *  the bounds taken off the ParamDef rather than re-typed. */
export function activeLength(p: SlewSwitchFaceParams): number {
  const def = slewSwitchDef.params.find((q) => q.id === 'length')!;
  return Math.max(def.min, Math.min(def.max, Math.round(p.length)));
}

/** MODE as the worklet reads it — the same `< 0.5` / `< 1.5` thresholds, so a
 *  dial parked between detents resolves the way the DSP resolves it. */
export function scanMode(p: SlewSwitchFaceParams): 'forward' | 'pendulum' | 'random' {
  if (p.mode < 0.5) return 'forward';
  if (p.mode < 1.5) return 'pendulum';
  return 'random';
}

/**
 * CLOCKS PER CYCLE — how many `step_clock` edges the scan takes to return to
 * channel 0, which is also the EOC period.
 *
 * `null` = there is no cycle: at LENGTH 1 `advance()` returns before it can set
 * `eocRemaining`, so the switch holds channel 1 and EOC NEVER fires. That is a
 * real state of the module and a number would lie about it.
 *
 * Random has no structural cycle either, but the worklet pulses EOC on EVERY
 * step by design, so its period is 1 rather than absent.
 */
export function lapClocks(p: SlewSwitchFaceParams): number | null {
  const len = activeLength(p);
  if (len <= 1) return null;
  switch (scanMode(p)) {
    case 'forward': return len;
    // Up and back down WITHOUT repeating either end: 0→1→…→len-1→…→1→0.
    case 'pendulum': return 2 * (len - 1);
    case 'random': return 1;
  }
}

/** The CV distance between adjacent `step_idx` levels — the derivative of the
 *  worklet's `(idx/(len-1))*2 - 1`. Zero at length 1, where the jack is a
 *  constant 0. */
export function stepIdxSpacing(p: SlewSwitchFaceParams): number {
  const len = activeLength(p);
  return len > 1 ? 2 / (len - 1) : 0;
}

// ── the slew ────────────────────────────────────────────────────────────────

/** The 99 % arrival time of one channel, in seconds. */
export function settleS(tau: number): number {
  return tau * SETTLE_TAUS;
}

/** The SLOWEST channel's arrival — the one a patch waits on. */
export function slowestSettleS(p: SlewSwitchFaceParams): number {
  return settleS(Math.max(...p.slews));
}

/** Slowest tau / fastest tau. 1 = all four channels behave identically. */
export function slewSpread(p: SlewSwitchFaceParams): number {
  const lo = Math.min(...p.slews);
  const hi = Math.max(...p.slews);
  return lo > 0 ? hi / lo : 1;
}

// ── printed strings ─────────────────────────────────────────────────────────

/** A duration, in the unit a player thinks in at that magnitude. */
export function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const ms = seconds * 1000;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  return `${(seconds / 60).toFixed(1)} min`;
}

export function slewSwitchSettleText(p: SlewSwitchFaceParams): string {
  return fmtTime(slowestSettleS(p));
}

/** The spread, with the flat case named rather than printed as `1.00x` — "all
 *  four alike" is the fact, and it is the shipped state. */
export function slewSwitchSpreadText(p: SlewSwitchFaceParams): string {
  const r = slewSpread(p);
  if (!Number.isFinite(r)) return '—';
  if (r < 1.005) return 'all alike';
  return `${r < 10 ? r.toFixed(2) : Math.round(r)}× span`;
}

/** The lap, naming the mode — because the SAME `length` gives three different
 *  answers and the mode dial cannot say which one is live. */
export function slewSwitchLapText(p: SlewSwitchFaceParams): string {
  const lap = lapClocks(p);
  const mode = scanMode(p);
  if (lap === null) return 'held';
  if (mode === 'random') return 'every clk';
  return `${lap} clk`;
}

export function slewSwitchStepIdxText(p: SlewSwitchFaceParams): string {
  const len = activeLength(p);
  if (len <= 1) return 'flat at 0';
  return `${len} steps, ${stepIdxSpacing(p).toFixed(3)} apart`;
}

/** The `switched` jack: which channels are in the rotation, and how long the
 *  hand-off between them takes. */
export function slewSwitchSwitchedText(p: SlewSwitchFaceParams): string {
  const len = activeLength(p);
  const rot = len <= 1 ? 'ch 1' : `ch 1–${len}`;
  return `${rot}, ${fmtTime(p.xfadeTime)} xfade`;
}

/** One channel's arrival time, by INDEX into SLEW_PARAM_IDS. */
export function slewSwitchChannelSettleText(p: SlewSwitchFaceParams, index: number): string {
  const tau = p.slews[index];
  if (tau === undefined) return '—';
  return fmtTime(settleS(tau));
}

/** The registered `valueId` that prints channel `index`'s arrival time. ONE
 *  home for the id shape, so `face-readout-values`'s generated entries and the
 *  def's output-table roster cannot spell it differently. */
export function channelSettleValueId(index: number): string {
  return `slewswitch-${SLEW_PARAM_IDS[index]}-settle`;
}
