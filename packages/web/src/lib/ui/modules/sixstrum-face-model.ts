// packages/web/src/lib/ui/modules/sixstrum-face-model.ts
//
// THE PURE MODEL BEHIND SIX STRUM's FACEPLATE — every derived number the face
// prints, computed through the DSP's OWN laws (`karplusLoopRho`,
// `karplusDampingCoeff`, `karplusDampingMag`, `karplusDcBlockMag`, `karplusF0`'s
// clamp) rather than re-derived here.
//
// ⚠ FOUR CONSTANTS ARE RE-TYPED, DELIBERATELY, AND GREP-GUARDED. `SS_TUNE_HZ`,
// `SS_REF_MIDI`, `SS_DETUNE_MAX_CENTS` and `SS_DETUNE_PATTERN` are module-
// PRIVATE in `packages/dsp/src/lib/sixstrum-dsp.ts`. Adding `export` would
// change that file's BYTES, and `dspSourceSha` hashes the source — sixstrum-dsp
// is pinned in two ART scenarios, so a keyword would force three `.sha`
// re-pins for zero audio change. `sixstrum-face-model.test.ts` reads the DSP
// SOURCE and fails if the literals disagree, which is the kickdrum `splitHz`
// precedent.
//
// ⚠ THE READER IS PARAMS-ONLY, and that is a platform fact rather than an
// oversight: `ModuleShell.readoutValue` deliberately hands a DURABLE-param
// reader (an engine reader polled from markup is not reactive). So every law
// below is evaluated at cv = 0 — a patched `strum_cv` moves the real roll and
// this model prints the knob.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import {
  KARPLUS_F0_MAX,
  KARPLUS_F0_MIN,
  KARPLUS_G_MAX,
  karplusDampingCoeff,
  karplusDampingMag,
  karplusDcBlockMag,
  karplusDcR,
  karplusLoopRho,
} from '../../../../../dsp/src/lib/karplus-dsp';
import { SS_STRINGS, SS_STRUM_SPREAD_MAX_S } from '../../../../../dsp/src/lib/sixstrum-dsp';
import { openStrings, tuningForIndex } from '../../../../../dsp/src/lib/sixstrum-tuning';
import { sixstrumDef } from '$lib/audio/modules/sixstrum';

/**
 * ⚠ ONLY `sixstrumRingT60S` is sample-rate sensitive, and only in the CAPPED
 * corner (where the loop-gain ceiling, not the RING knob, sets the decay). In
 * the uncapped regime the law is rate-calibrated and returns the knob at any
 * rate. Stated here rather than hidden inside the function.
 */
export const SIXSTRUM_MODEL_SR = 48000;

// ── the four re-typed private constants (grep-guarded — see the header) ─────
/** `SS_TUNE_HZ` — the karplus `tune` every voice is pinned to (A3). */
export const SS_TUNE_HZ = 220;
/** `SS_REF_MIDI` — MIDI 57 = A3 = 220 Hz, the pitchCv reference. */
export const SS_REF_MIDI = 57;
/** `SS_DETUNE_MAX_CENTS` — SPREAD 1.0 detunes the outer strings ±14 ¢. */
export const SS_DETUNE_MAX_CENTS = 14;
/** `SS_DETUNE_PATTERN` — the symmetric per-string detune weights, low→high. */
export const SS_DETUNE_PATTERN: readonly number[] = [-1, -0.6, -0.25, 0.25, 0.6, 1];

/** The eight params the faceplate's derived readouts read, by DEF param id. */
export interface SixstrumFaceParams {
  tuning: number;
  register: number;
  spread: number;
  ring: number;
  material: number;
  pickPos: number;
  pickGrain: number;
  strumSpread: number;
}

/** The eight ids, so a rename fails a test rather than silently defaulting. */
export const SIXSTRUM_FACE_PARAM_IDS = [
  'tuning', 'register', 'spread', 'ring',
  'material', 'pickPos', 'pickGrain', 'strumSpread',
] as const satisfies readonly (keyof SixstrumFaceParams)[];

/**
 * Live values in, resolving the DEF DEFAULT for anything the reader has no
 * answer for. `node.params` is a SPARSE OVERLAY of what has been TOUCHED, so
 * reading it bare on a fresh spawn computes every number from zeros.
 */
export function sixstrumFaceParams(
  read: (paramId: string) => number | undefined,
): SixstrumFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = sixstrumDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`sixstrum-face-model: sixstrum has no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    tuning: val('tuning'),
    register: val('register'),
    spread: val('spread'),
    ring: val('ring'),
    material: val('material'),
    pickPos: val('pickPos'),
    pickGrain: val('pickGrain'),
    strumSpread: val('strumSpread'),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The SIX open-string frequencies the NEXT strike will latch, low→high, with
 * REGISTER and SPREAD applied and `karplusF0`'s [30, 4200] clamp honoured.
 *
 * ⚠ THE CLAMP IS NOT COSMETIC. The shipped BASS recall puts strings 1-3 under
 * 30 Hz, so three of six collapse onto ONE pitch — see the model test, which
 * pins it as a DEFECT.
 */
export function sixstrumStringHz(p: SixstrumFaceParams): number[] {
  const open = openStrings(tuningForIndex(p.tuning));
  const cents = clamp(p.spread, 0, 1) * SS_DETUNE_MAX_CENTS;
  const registerCv = clamp(p.register, -24, 24) / 12;
  const out: number[] = [];
  for (let i = 0; i < SS_STRINGS; i++) {
    const baseCv = ((open[i] ?? SS_REF_MIDI) - SS_REF_MIDI) / 12;
    const detuneCv = ((SS_DETUNE_PATTERN[i] ?? 0) * cents) / 1200;
    const hz = SS_TUNE_HZ * Math.pow(2, baseCv + registerCv + detuneCv);
    out.push(clamp(hz, KARPLUS_F0_MIN, KARPLUS_F0_MAX));
  }
  return out;
}

/**
 * How long the LOW string actually rings, seconds to −60 dB — RING's and
 * MATERIAL's JOINT answer through the worklet's own loop-gain law.
 *
 * ⚠ THIS IS THE FACE'S CENTRAL CLAIM. `KARPLUS_G_MAX` caps the loop gain, so
 * below MATERIAL ≈ 0.10 the string decays FASTER than RING asks and the number
 * FREEZES while the dial sweeps 1 → 10 s. A `paramId: 'ring'` readout is blind
 * to exactly that.
 */
export function sixstrumRingT60S(
  p: SixstrumFaceParams,
  sr: number = SIXSTRUM_MODEL_SR,
): number {
  const f0 = sixstrumStringHz(p)[0] ?? KARPLUS_F0_MIN;
  const material = clamp(p.material, 0, 1);
  const a = karplusDampingCoeff(f0, material, sr);
  const w0 = (2 * Math.PI * f0) / sr;
  const comp = karplusDampingMag(a, w0) * karplusDcBlockMag(karplusDcR(f0, sr), w0);
  const rho = Math.min(0.99995, karplusLoopRho(f0, clamp(p.ring, 0.1, 10)));
  const g = clamp(rho / Math.max(0.5, comp), 0, KARPLUS_G_MAX);
  const perLoop = Math.log(g * comp);
  if (!(perLoop < 0)) return clamp(p.ring, 0.1, 10);
  const t60 = Math.log(0.001) / (f0 * perLoop);
  return Number.isFinite(t60) ? Math.max(0, t60) : 0;
}

/**
 * The PARTIAL INDEX above which MATERIAL's damping filter starts eating the
 * string — `2^(0.5 + 5.5·knob)`.
 *
 * ⚠ PUBLISHED AS AN INDEX, NOT Hz, ON PURPOSE: the damping cutoff TRACKS the
 * note (the same multiple of f0 on every string), so a partial needs no
 * reference pitch and REGISTER must not move it. Printing Hz would silently
 * have meant "at the low string".
 */
export function sixstrumDampPartial(p: SixstrumFaceParams): number {
  return Math.pow(2, 0.5 + 5.5 * clamp(p.material, 0, 1));
}

/** The strum ROLL: the whole window and the per-string step, ms. DIR only
 *  permutes the order, so neither figure may move with it. */
export function sixstrumRollMs(p: SixstrumFaceParams): {
  windowMs: number;
  perStringMs: number;
} {
  const windowMs = clamp(p.strumSpread, 0, 1) * SS_STRUM_SPREAD_MAX_S * 1000;
  return { windowMs, perStringMs: windowMs / (SS_STRINGS - 1) };
}

/** The partial the PICK POS comb cancels — `1 / position`. */
export function sixstrumPickNotchPartial(p: SixstrumFaceParams): number {
  return 1 / clamp(p.pickPos, 0.02, 0.5);
}

/** The excitation burst's length in ms at the LOW string. PICK GRAIN is
 *  measured in PERIODS, so its ms halves every octave up — which is precisely
 *  what the dial cannot say. */
export function sixstrumBurstMs(p: SixstrumFaceParams): number {
  const f0 = sixstrumStringHz(p)[0] ?? KARPLUS_F0_MIN;
  return (clamp(p.pickGrain, 0.1, 4) * 1000) / f0;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Hz → the nearest note name with its octave (`E2`). TOTAL. */
export function sixstrumNoteName(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12] ?? '?';
  return `${name}${Math.floor(midi / 12) - 1}`;
}

/** Seconds, switching to ms under 1 s (`2.50 s`, `775 ms`). */
export function fmtSecondsOrMs(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  return v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`;
}

/** A partial index, one decimal (`partial 11.5`). */
export function fmtPartial(v: number): string {
  if (!Number.isFinite(v)) return 'partial —';
  return `partial ${v.toFixed(1)}`;
}
