// packages/web/src/lib/ui/modules/moogcp3-face-model.ts
//
// The PURE model behind the MOOG CP3 faceplate — the one number a five-knob
// console cannot print from any one of its knobs.
//
// WHY IT EXISTS. `cp3ChannelGain(k) = clamp(k,0,1)·2`, so UNITY IS AT THE
// DIAL'S MIDPOINT and every one of the five knobs SHIPS AT MAX. Four correlated
// unity inputs at the shipped defaults therefore sum to a bus peak of 8.0000 —
// +18.062 dB over full scale, 10.0000 with EXT 4 also patched — and there is no
// clamp or saturator anywhere in the path.
//
// Measured on the SHIPPING worklet (1 kHz sine, Hann-windowed single-bin DFT
// past the 80 Hz knob smoother; the instrument's own controls first — a known
// 0.5 sine reads 0.500000 at its bin and 0.000000 at a wrong one):
//
//   ch1 0.00 -> 0.00000            ch1 0.75 -> 1.50000  (+3.522 dB)
//   ch1 0.25 -> 0.50000 (-6.021)   ch1 1.00 -> 2.00000  (+6.021 dB)
//   ch1 0.50 -> 1.00000 (UNITY, the MIDPOINT)
//
// No knob readback can reach the bus figure: it is a JOIN over all five, and
// the 4th channel contributes only through the PRODUCT of CH 4 and ATT 4.
// Validated against the instrument at five settings (x8 / x4 / x2 / x6 / x3
// derived vs measured worst-case bus peak) — AGREE at every one, which is what
// `art/scenarios/moog-cp3/face-audit.test.ts` holds permanently.
//
// ⚠ THE 4TH CHANNEL'S TWO KNOBS ARE BIT-EXACTLY INTERCHANGEABLE in today's
// code, because `cp3Mix` applies `(in4+ext4)·atten4·g4` and the bus sees only
// their product. That is why the formula below multiplies them rather than
// treating ATT 4 as a separate term, and it is a property of the CODE this face
// is drawn against — #1884 proposes changing it, which is audible and belongs
// to the owner's ears.
//
// PURE: no DOM, no engine, no store, no fs, no sample rate.

import { moogCp3Def } from '$lib/audio/modules/moog-cp3';
import { CP3_MAX_GAIN } from '../../../../../dsp/src/lib/moog-cp3-dsp';

// RELATIVE path, not the `@patchtogether.live/dsp/src/...` alias, for the reason
// `moog921-face-model.ts` and `ninelives-face-model.ts` both document: a
// worktree may not symlink the workspace package under node_modules, and the TS
// path-alias rules do not reliably resolve TS source out of there.

/** The five knobs the readout is a function of. */
export interface MoogCp3FaceParams {
  ch1: number;
  ch2: number;
  ch3: number;
  ch4: number;
  attenuator4: number;
}

const IDS = ['ch1', 'ch2', 'ch3', 'ch4', 'attenuator4'] as const;

function paramDefault(id: keyof MoogCp3FaceParams): number {
  const p = moogCp3Def.params.find((q) => q.id === id);
  if (!p) throw new Error(`moogcp3-face-model: no param '${id}' on moogCp3Def`);
  return p.defaultValue;
}

/** The def's own spawn defaults — DERIVED, never re-typed. */
const DEFAULTS: MoogCp3FaceParams = {
  ch1: paramDefault('ch1'),
  ch2: paramDefault('ch2'),
  ch3: paramDefault('ch3'),
  ch4: paramDefault('ch4'),
  attenuator4: paramDefault('attenuator4'),
};

/** Read the five params off a live reader; anything missing or non-finite falls
 *  back to the def's declared default. */
export function moogCp3FaceParams(
  read: (paramId: string) => number | undefined,
): MoogCp3FaceParams {
  const one = (k: keyof MoogCp3FaceParams): number => {
    const v = read(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[k];
  };
  return Object.fromEntries(IDS.map((id) => [id, one(id)])) as unknown as MoogCp3FaceParams;
}

const clamp01 = (v: number, fallback: number): number => {
  if (!Number.isFinite(v)) return fallback;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

/**
 * THE WORST-CASE BUS GAIN — the factor the (+) bus applies when all four inputs
 * carry the same full-scale signal, i.e. the level a correlated patch actually
 * produces.
 *
 * `CP3_MAX_GAIN·(ch1 + ch2 + ch3 + ch4·attenuator4)`, with `CP3_MAX_GAIN`
 * IMPORTED from the DSP core rather than re-typed, so the ×2 has one source.
 *
 * ⚠ CH 4 enters as a PRODUCT with ATT 4 — that is the module's redundant
 * dimension, measured bit-exactly, not a simplification made here.
 */
export function moogCp3BusGain(p: MoogCp3FaceParams): number {
  const ch1 = clamp01(p.ch1, DEFAULTS.ch1);
  const ch2 = clamp01(p.ch2, DEFAULTS.ch2);
  const ch3 = clamp01(p.ch3, DEFAULTS.ch3);
  const ch4 = clamp01(p.ch4, DEFAULTS.ch4);
  const att = clamp01(p.attenuator4, DEFAULTS.attenuator4);
  return CP3_MAX_GAIN * (ch1 + ch2 + ch3 + ch4 * att);
}

/** The same figure in dB. `-inf` when every channel is closed. */
export function moogCp3BusDb(p: MoogCp3FaceParams): number {
  const g = moogCp3BusGain(p);
  return g > 0 ? 20 * Math.log10(g) : Number.NEGATIVE_INFINITY;
}

/**
 * `bus` — how far over full scale a correlated patch lands, in dB.
 *
 * ⚠ ONE NUMBER WITH ONE UNIT, deliberately. The composite form
 * (`x8.00 · +18.1 dB`) is within a character of the readout the owner deleted
 * from mixmstrs; the faces merged since carry bare values. The gain RATIO lives
 * in the def's face comment and in `docs`, which is where an explanation
 * belongs.
 */
export function moogCp3BusText(p: MoogCp3FaceParams): string {
  const dbv = moogCp3BusDb(p);
  if (dbv === Number.NEGATIVE_INFINITY) return 'silent';
  if (!Number.isFinite(dbv)) return `${dbv}`;
  const s = dbv.toFixed(1);
  return dbv > 0 ? `+${s} dB` : `${s} dB`;
}
