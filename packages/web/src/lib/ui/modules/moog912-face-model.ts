// packages/web/src/lib/ui/modules/moog912-face-model.ts
//
// The two numbers a MOOG 912 ENVELOPE FOLLOWER knows about itself and prints
// nowhere — which, for this module, IS the reason it has a face at all.
//
// ⚠ STOP 1 IS THE CLOSEST CALL IN THIS COHORT AND IT TURNS ON THIS FILE. The
// refuse rule fires when ALL of: ≤2 params · no control families · no
// `node.data` affordances · NO DERIVED QUANTITY WORTH A READOUT. moog912 has
// two params, no families and no `node.data` — three of four. It survives ONLY
// on the fourth clause. If these readouts are cut in review the answer flips to
// NO FACE ON MERIT; it does not degrade to a thin face.
//
// ⚠ BOTH FUNCTIONS ARE IMPORTED FROM THE MODULE, NOT RE-STATED.
// `smoothingToCutoffHz` and `GATE_THRESHOLD` are real exports of
// `moog912.ts` — the same function the factory calls and the same constant the
// gate curve is built from — so there is one source and nothing to drift.

import type { AudioModuleDef } from '$lib/audio/module-registry';
import { GATE_THRESHOLD, moog912Def, smoothingToCutoffHz } from '$lib/audio/modules/moog912';

/**
 * The SENSITIVITY below which the GATE output can never be held open, on ANY
 * input.
 *
 * ⚠ THIS IS #1914, AND IT IS THE ARGUMENT FOR RANK 1. `GATE_THRESHOLD` is a
 * bare constant that does NOT scale with SENS. The rectified sine's DC level is
 * `A·sens·(2/π)` and the envelope lowpass passes DC at unity, so holding the
 * gate open needs `A ≥ π·GATE_THRESHOLD/(2·sens)` — and at `A = 1`, the loudest
 * signal there is, that bottoms out at `sens = π·0.1/2 = 0.157080`. The bottom
 * **15.71 %** of a dial whose entire job is to open this output cannot open it.
 *
 * ⚠ THIS ARGUMENT WOULD BE WRONG for a follower whose threshold scales with
 * sensitivity, which is the usual design. It is defended by `GATE_THRESHOLD`
 * being a bare constant, and CONFIRMED on a real rendered graph in
 * `art/scenarios/moog912/face-audit.test.ts` — including the leg that drives a
 * FULL-SCALE sine at a sensitivity just below this and watches the gate stay
 * shut, with a positive control just above it that opens.
 */
export const MOOG912_GATE_DEAD_SENS = (Math.PI * GATE_THRESHOLD) / 2;

export interface Moog912Params {
  readonly sensitivity: number;
  readonly smoothing: number;
}

/**
 * Read one param, resolving the DEF DEFAULT for anything untouched and for any
 * non-finite value the live engine can hand back mid-boot. A readout runs on
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
  if (!p) throw new Error(`moog912-face-model: ${def.type} has no param '${id}'`);
  return p.defaultValue;
}

export function moog912FaceParams(
  read: (paramId: string) => number | undefined,
): Moog912Params {
  return {
    sensitivity: readOr(moog912Def, read, 'sensitivity'),
    smoothing: readOr(moog912Def, read, 'smoothing'),
  };
}

/**
 * `response` — the envelope detector's cutoff, in Hz.
 *
 * ⚠ THE DIAL ACTIVELY MISLEADS ABOUT THIS ONE, in two ways at once. It is a
 * bare 0..1 with no units, and the mapping is INVERTED and LOGARITHMIC: 1 Hz at
 * SMOOTH 1, 50 Hz at SMOOTH 0 — a 5.64-octave span in which turning the knob UP
 * makes the number go DOWN. At the shipped 0.5 the detector sits at 7.071068 Hz,
 * which nothing on the module says and no reading of "0.50" suggests.
 *
 * ⚠ NOT A MILLISECOND FIGURE, and that was drafted and then rejected on a
 * measurement. §27.6 proposed `1000·ln(9)/(2π·fc)`, the ONE-POLE 10–90 % rise.
 * The shipping filter is a BIQUAD at Q = 0.5 and a `FaceReadoutValue` cannot run
 * one, so that readout would have been a model — measured 30 % off at the fast
 * end (4.917 ms rendered against 6.994 ms modelled). Worse, the rendered figure
 * is itself unreliable there, because at 50 Hz cutoff the rectified 220 Hz tone
 * still ripples at 440 Hz only ~19 dB down. Two uncertain numbers do not make a
 * readout. This one is EXACT: it is the value the factory literally writes into
 * `envFilter.frequency`.
 */
export function moog912ResponseHz(p: Moog912Params): number {
  return smoothingToCutoffHz(p.smoothing);
}

/** `7.07 Hz` — two decimals below 10 Hz, one above, so the span reads evenly. */
export function moog912ResponseText(p: Moog912Params): string {
  const hz = moog912ResponseHz(p);
  return hz < 10 ? `${hz.toFixed(2)} Hz` : `${hz.toFixed(1)} Hz`;
}

/**
 * `gate` — how loud the input must be, in dBFS, for the GATE to be held open.
 *
 * ⚠ THE NUMBER RANK 1 RESTS ON, and it is CONFIRMED ON A RENDERED GRAPH rather
 * than derived and hoped for: at the shipped sensitivity the closed form says an
 * amplitude of 0.224399 (−12.980 dBFS), and driving the real factory through an
 * OfflineAudioContext the settled envelope lands on 0.100001 against a threshold
 * of 0.100000 — six decimal places.
 *
 * ⚠ IT PRINTS `—` WHEN THE GATE IS UNREACHABLE, which is the whole point. Below
 * `MOOG912_GATE_DEAD_SENS` the required amplitude exceeds full scale, so there
 * is no input that can hold the gate open and a dBFS number would be a
 * PROMISE THE MODULE CANNOT KEEP. A dash is the honest reading, and it is the
 * only place in the product where #1914's dead zone is visible.
 *
 * ⚠ IT IS THE SUSTAINED THRESHOLD, NOT THE TRANSIENT ONE. The envelope
 * overshoots its own steady state on attack by a measured constant 1.1861×, so
 * a sound about 1.5 dB below this still BLIPS the gate and drops it. Both
 * numbers are real; this readout prints the one that describes a held note, and
 * the ART audit pins both so neither can quietly become the other.
 */
export function moog912GateDbfs(p: Moog912Params): number {
  const sens = p.sensitivity;
  if (!(sens > 0)) return Number.POSITIVE_INFINITY;
  const amp = (Math.PI * GATE_THRESHOLD) / (2 * sens);
  return 20 * Math.log10(amp);
}

export function moog912GateText(p: Moog912Params): string {
  const db = moog912GateDbfs(p);
  // Above 0 dBFS the gate is unreachable — no signal is that loud.
  if (!Number.isFinite(db) || db > 0) return '—';
  return `${db.toFixed(1)} dBFS`;
}
