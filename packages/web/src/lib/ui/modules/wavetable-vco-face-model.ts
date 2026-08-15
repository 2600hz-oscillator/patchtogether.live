// packages/web/src/lib/ui/modules/wavetable-vco-face-model.ts
//
// THE PURE MODEL BEHIND WAVETABLE VCO's FACEPLATE — the two derived readouts,
// mirroring `packages/dsp/src/wavetable-vco.ts` line for line.
//
// ⚠ THE DSP IS A WORKLET, so nothing can be imported from it: the file's only
// top-level effect is `registerProcessor`, and it exports nothing. The laws
// below are RE-TYPED from it and pinned by a SOURCE GREP in the model test (the
// `analog-vco-face-model` / kickdrum `splitHz` precedent). Every constant cites
// the expression it came from.
//
// ⚠ WHY THIS IS NOT `analog-vco-face-model` WITH A DIFFERENT DEF. The two
// modules compute the same two quantities today, from the same C4 literal, and
// sharing would look like the obvious de-duplication. It would be wrong: one is
// a hand-written TypeScript worklet and the other is compiled Faust, authored
// independently and re-pinned by different gates. Sharing the model would make
// a change to `analog-vco.dsp` silently move THIS module's printed numbers,
// with no gate anywhere joining the two. Two models, two source greps, each
// anchored to the file it actually mirrors.
//
// ⚠ EVERY NUMBER IS KNOB-ONLY, and the LABELS say so where it matters. A
// registered `FaceReadoutValue` is handed a DURABLE-param reader
// (`face-readout-values.ts`), so it cannot see the `pitch` jack, an `fm` cable,
// or CV on tune/fine — which is why the hero's first readout is captioned
// `knob pitch` and not `pitch`.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import { wavetableVcoDef } from '$lib/audio/modules/wavetable-vco';

/** The worklet's own literal: `261.626 * Math.pow(2, semitones / 12)`. */
export const WT_C4_HZ = 261.626;

/** The worklet's own clamp: `if (freq < 1) freq = 1; else if (freq > 20000)`. */
export const WT_FREQ_MIN_HZ = 1;
export const WT_FREQ_MAX_HZ = 20000;

/** The FM law's own factor: `semitones += fma * fm * 12`, i.e. a full-scale
 *  modulator at depth 1 is ONE OCTAVE. */
export const WT_FM_SEMITONES_AT_FULL_SCALE = 12;

/** Frames in the shipped table (`FRAME_COUNT` in the def's generator). Used by
 *  the model test's boundary legs, not by a readout. */
export const WT_FRAME_COUNT = 16;

export interface WtFaceParams {
  tune: number;
  fine: number;
  fmAmount: number;
  pmAmount: number;
  wavePos: number;
}

export const WT_FACE_PARAM_IDS = [
  'tune', 'fine', 'fmAmount', 'pmAmount', 'wavePos',
] as const satisfies readonly (keyof WtFaceParams)[];

/** Live values in, resolving the DEF DEFAULT for anything untouched.
 *  `node.params` is a SPARSE overlay of what has been TOUCHED, so reading it
 *  bare prints `undefined`-shaped nonsense on a freshly spawned node. */
export function wtFaceParams(
  read: (paramId: string) => number | undefined,
): WtFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = wavetableVcoDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`wavetable-vco-face-model: wavetableVco has no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    tune: val('tune'),
    fine: val('fine'),
    fmAmount: val('fmAmount'),
    pmAmount: val('pmAmount'),
    wavePos: val('wavePos'),
  };
}

/**
 * The sounding pitch from the KNOBS ALONE.
 *
 * ⚠ `fine` is declared in CENTS (±100) and the worklet divides it by 100 to
 * reach SEMITONES — `tune + fine / 100` — so the octave exponent is
 * `tune/12 + fine/1200`. Writing `fine/100` in the exponent would be off by 12×
 * and would still look plausible on a faceplate.
 *
 * Blind to the `pitch` jack, to FM and to CV on tune/fine, by construction.
 * The clamp is the worklet's.
 */
export function wtKnobHz(p: WtFaceParams): number {
  const hz = WT_C4_HZ * Math.pow(2, p.tune / 12 + p.fine / 1200);
  return Math.min(WT_FREQ_MAX_HZ, Math.max(WT_FREQ_MIN_HZ, hz));
}

/**
 * FM's reach in CENTS against a full-scale modulator.
 *
 * ⚠ `|fmAmount|`, not `fmAmount`. A NEGATIVE depth inverts the MODULATOR (the
 * worklet's `fma * fm` is naturally signed, so −1 is a 180° flip of the
 * incoming signal); it does not reverse the sweep DIRECTION, and it does not
 * shrink the span. A knob readback swings through zero here while the span must
 * not move at all — that is one of the model test's permanent legs.
 */
export function wtFmSpanCents(p: WtFaceParams): number {
  return 100 * WT_FM_SEMITONES_AT_FULL_SCALE * Math.abs(p.fmAmount);
}

/**
 * FM's reach in Hz against a ±1 modulator — ASYMMETRIC, because the exponent
 * is, and it SCALES WITH THE FUNDAMENTAL, which is the half no dial can say.
 *
 * MEASURED against the real worklet (art/scenarios/wavetable-vco/cv-path):
 * at C4 and depth 1 the swing is +260.11 / −130.84 Hz; at `tune +12` the same
 * depth gives +520.23 / −260.96 Hz while the FM AMT dial does not move.
 */
export function wtFmSpanHz(p: WtFaceParams): { up: number; down: number } {
  const octaves = Math.abs(p.fmAmount);
  const f0 = wtKnobHz(p);
  return { up: f0 * (Math.pow(2, octaves) - 1), down: f0 * (1 - Math.pow(2, -octaves)) };
}

/** ⚠ NOT an integer-Hz formatter: C4 would print `262 Hz` and the +10-cent
 *  negative control (261.6 → 263.1) would be invisible at the printed
 *  precision, which is exactly the leg this face exists to make visible. */
export function fmtWtHz(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(1)} Hz`;
}
