// packages/web/src/lib/ui/modules/featurecv-face-model.ts
//
// FEATURECV's FACEPLATE MODEL — the pure arithmetic behind the face's derived
// readouts and its sidebar picture, and the ONE place any of it is written.
//
// WHY A MODEL RATHER THAN READOUTS OFF THE DIALS. Every number a featurecv
// patcher actually needs is a MAPPING, and no dial on the module prints any of
// them:
//
//   * the three feature CVs REST at the polarity's floor, not at zero. With
//     nothing patched into `in` the extractor's targets are 0, so at the
//     shipped BIPOLAR default all three jacks sit at −1.00 — the bottom rail —
//     while the POLARITY control prints `BI`.
//   * LOUD is `clamp01(LOUD_MAKEUP · rms)` behind a ×0.25..×4 trim, so the
//     dial that decides whether LOUD saturates is GAIN, and GAIN prints a
//     multiplier rather than the input level at which the feature stops moving.
//   * the onset detector's threshold is `avgFlux · mult + ONSET_FLOOR`, and
//     SENS maps onto `mult` INVERTED (4.0× at SENS 0, 1.2× at SENS 1). The dial
//     prints `0.50`; the detector is firing at 2.60× the running mean flux, and
//     the dial can say neither the number nor the direction.
//   * DEBNCE is a lockout, so it sets a RATE CEILING — the fastest hit train
//     that passes intact is `1000/debounce` Hz. The dial prints `80 ms`.
//   * ATTACK and RELEASE are one-pole TIME CONSTANTS, not rise times. The
//     10→90 % move a player would call "the attack" is `ln(9) ≈ 2.197×` the
//     printed number: a 10 ms ATTACK delivers a 22.0 ms rise.
//
// ⚠ EVERY DSP CONSTANT IS IMPORTED, NEVER RE-TYPED. `LOUD_MAKEUP`,
// `BRIGHT_GAIN`, `CREST_MIN`/`CREST_MAX`, `applyBipolar` and
// `onsetSensToThreshMult` come from the shipping core the worklet inlines, so
// a calibration change moves the faceplate with it. This is the
// `resofilter-face-model` → `resofilter-dsp` precedent.
//
// PURE and TOTAL: every function here runs on a `FaceReadoutValue` render and
// inside the sidebar panel's `$derived`, so a throw on a transient NaN takes
// the faceplate down mid-drag.

import {
  BRIGHT_GAIN,
  CREST_MAX,
  CREST_MIN,
  LOUD_MAKEUP,
  applyBipolar,
  onsetSensToThreshMult,
} from '../../../../../dsp/src/lib/featurecv-dsp';

/** The param ids this model reads. DERIVED nowhere — it is the def's own
 *  roster, and `featurecv-face-model.test.ts` asserts every id is declared. */
export interface FeaturecvFaceParams {
  gain: number;
  attack: number;
  release: number;
  bipolar: number;
  onsetSens: number;
  onsetDebounce: number;
}

/** Read the six live params through the `FaceReadoutValue` reader shape,
 *  resolving each def default when the sparse overlay has no entry. */
export function featurecvFaceParams(read: (paramId: string) => number | undefined): FeaturecvFaceParams {
  const g = (id: string, fallback: number): number => {
    const v = read(id);
    return typeof v === 'number' ? v : fallback;
  };
  return {
    gain: g('gain', 1),
    attack: g('attack', 10),
    release: g('release', 100),
    bipolar: g('bipolar', 1),
    onsetSens: g('onset_sens', 0.5),
    onsetDebounce: g('onset_debounce', 80),
  };
}

/** The worklet's own `bipolar` decision: a k-rate 0..1 param read as a
 *  threshold at 0.5 (`featurecv.ts` → `this.ex.setBipolar(kval >= 0.5)`), so
 *  the face and the DSP agree on what a half-turn means. */
export function featurecvIsBipolar(p: FeaturecvFaceParams): boolean {
  return p.bipolar >= 0.5;
}

/** The PROBE input level the `−12 dB` readout is stated at, as an RMS
 *  amplitude. −12.04 dBFS: a comfortably-driven source that is nowhere near
 *  the LOUD clamp at unity GAIN, so the readout has room to move in BOTH
 *  directions as the trim turns. */
export const FEATURECV_PROBE_RMS = 0.25;

/** The input RMS at which LOUD reaches full scale at GAIN 1 — `1/LOUD_MAKEUP`,
 *  derived rather than typed. Above it the feature is PINNED and stops
 *  modulating at all. */
export const FEATURECV_LOUD_CLIP_RMS = 1 / LOUD_MAKEUP;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The LOUD CV at the jack for an input of RMS `rmsIn`, at the live GAIN and
 *  POLARITY. The whole chain the module actually runs: trim → RMS → makeup →
 *  clamp → polarity. */
export function featurecvLoudCv(rmsIn: number, p: FeaturecvFaceParams): number {
  if (!Number.isFinite(rmsIn) || !Number.isFinite(p.gain)) return Number.NaN;
  return applyBipolar(clamp01(LOUD_MAKEUP * rmsIn * p.gain), featurecvIsBipolar(p));
}

/** The BRIGHT CV for a given zero-crossing RATE (0..1 fraction of adjacent
 *  sample pairs that change sign). GAIN-INVARIANT by construction — ZCR counts
 *  sign changes, which a scalar trim cannot move. */
export function featurecvBrightCv(zcrIn: number, p: FeaturecvFaceParams): number {
  if (!Number.isFinite(zcrIn)) return Number.NaN;
  return applyBipolar(clamp01(BRIGHT_GAIN * zcrIn), featurecvIsBipolar(p));
}

/** The PUNCH CV for a given crest factor (peak ÷ RMS). Also GAIN-INVARIANT: a
 *  ratio of two quantities the trim scales identically. */
export function featurecvPunchCv(crestIn: number, p: FeaturecvFaceParams): number {
  if (!Number.isFinite(crestIn)) return Number.NaN;
  return applyBipolar(clamp01((crestIn - CREST_MIN) / (CREST_MAX - CREST_MIN)), featurecvIsBipolar(p));
}

/** The level all three feature CVs sit at with NOTHING patched into `in`:
 *  every target is 0, so this is the polarity's floor. */
export function featurecvIdleCv(p: FeaturecvFaceParams): number {
  return featurecvLoudCv(0, p);
}

/**
 * The input level, in dBFS RMS, at or above which LOUD is PINNED at full scale
 * — `20·log10(1 / (LOUD_MAKEUP · gain))`. Positive means the clamp is out of
 * reach of any signal that fits in [−1, +1] (`featurecvLoudClipReachable`).
 */
export function featurecvLoudClipDb(p: FeaturecvFaceParams): number {
  const rms = FEATURECV_LOUD_CLIP_RMS / p.gain;
  if (!Number.isFinite(rms) || rms <= 0) return Number.NaN;
  return 20 * Math.log10(rms);
}

/** Can a signal bounded by ±1 actually reach the LOUD clamp at this GAIN? An
 *  RMS above 1 is unreachable (only a full-scale square hits 1.0 exactly). */
export function featurecvLoudClipReachable(p: FeaturecvFaceParams): boolean {
  return FEATURECV_LOUD_CLIP_RMS / p.gain <= 1;
}

/** The onset detector's adaptive-threshold MULTIPLIER at the live SENS.
 *  INVERTED: 4.0× at SENS 0 (least sensitive) → 1.2× at SENS 1. */
export function featurecvThreshMult(p: FeaturecvFaceParams): number {
  return onsetSensToThreshMult(p.onsetSens);
}

/** The fastest hit train ONSET passes intact, in Hz — the debounce lockout's
 *  reciprocal. Measured against the shipping core in
 *  `art/scenarios/featurecv/analysis.test.ts`: a 12 Hz train is captured 12/12
 *  at the shipped 80 ms and a 16 Hz train collapses. */
export function featurecvMaxTrigHz(p: FeaturecvFaceParams): number {
  if (!Number.isFinite(p.onsetDebounce) || p.onsetDebounce <= 0) return Number.NaN;
  return 1000 / p.onsetDebounce;
}

/** `ln(9)` — the 10→90 % move of a one-pole, in time constants. */
export const ONE_POLE_10_90 = Math.log(9);

/** The 10→90 % time a one-pole with time constant `ms` actually delivers. The
 *  ATTACK / RELEASE dials print the TIME CONSTANT (`EnvFollower` builds its
 *  coefficient as `exp(-1 / (ms/1000 · sr))`), which is 2.197× shorter. */
export function featurecvRiseMs(ms: number): number {
  return ms * ONE_POLE_10_90;
}

// ── Formatters ───────────────────────────────────────────────────────────────

/** A CV level at the jack, signed, two decimals (`−1.00`, `+0.25`, `0.00`).
 *  U+2212 MINUS so the digits stay optically aligned against a `+`. */
export function fmtFeaturecvCv(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(2);
  if (v > 0) return `+${s}`;
  if (v < 0) return `−${s}`;
  return '0.00';
}

/** dBFS with one decimal and an explicit sign, or `never` when the clamp is
 *  out of reach of a bounded signal. */
export function fmtFeaturecvClip(p: FeaturecvFaceParams): string {
  if (!featurecvLoudClipReachable(p)) return 'never';
  const v = featurecvLoudClipDb(p);
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(1);
  return v > 0 ? `+${s} dBFS` : `${s} dBFS`;
}

/** The threshold multiplier (`2.60×`). */
export function fmtFeaturecvThresh(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}×`;
}

/** A trigger-rate ceiling (`12.5 Hz`). */
export function fmtFeaturecvHz(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v >= 100 ? `${Math.round(v)} Hz` : `${v.toFixed(1)} Hz`;
}

/** A smoothing time in ms — integer above 10 ms, one decimal below, because
 *  the ATTACK dial reaches 0.5 ms and `1 ms` there would print the same string
 *  across a fifth of the travel. */
export function fmtFeaturecvMs(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`;
}

// ── The readout strings the registry publishes ───────────────────────────────

export const featurecvIdleText = (p: FeaturecvFaceParams): string => fmtFeaturecvCv(featurecvIdleCv(p));
export const featurecvProbeText = (p: FeaturecvFaceParams): string =>
  fmtFeaturecvCv(featurecvLoudCv(FEATURECV_PROBE_RMS, p));
export const featurecvThreshText = (p: FeaturecvFaceParams): string =>
  fmtFeaturecvThresh(featurecvThreshMult(p));
export const featurecvMaxRateText = (p: FeaturecvFaceParams): string =>
  fmtFeaturecvHz(featurecvMaxTrigHz(p));
export const featurecvClipText = (p: FeaturecvFaceParams): string => fmtFeaturecvClip(p);
export const featurecvAtkRiseText = (p: FeaturecvFaceParams): string =>
  fmtFeaturecvMs(featurecvRiseMs(p.attack));
export const featurecvRelFallText = (p: FeaturecvFaceParams): string =>
  fmtFeaturecvMs(featurecvRiseMs(p.release));

// ── The sidebar picture's own model ──────────────────────────────────────────

/**
 * The three features, in the order the def declares its CV outputs. DERIVED
 * from that roster by the model test, so a fourth feature cannot appear on the
 * jacks without appearing on the picture.
 */
export const FEATURECV_FEATURES = ['loud', 'bright', 'punch'] as const;
export type FeaturecvFeature = (typeof FEATURECV_FEATURES)[number];

/**
 * The CANONICAL SOURCES the picture marks on each feature's rail — the rack's
 * OWN generators plus a plain tone, with the window statistics measured off
 * them in `art/scenarios/featurecv/analysis.test.ts` (1024-sample window,
 * 48 kHz, the shipped seeds) and re-derived there on every run.
 *
 * ⚠ THIS TABLE IS THE AUDIT'S FINDING, NOT A DECORATION. The DSP core's own
 * calibration comment said "white noise (~3.5) → ~0.5" for the crest map. The
 * rack's `white` tap is UNIFORM in [−1, +1], whose crest is √3 ≈ 1.73, so the
 * canonical patch NOISE → FEATURECV lands PUNCH at 0.15 unipolar / −0.71
 * bipolar — a third of the level the calibration promised, at the bottom of
 * the rail. `~3.5` is a GAUSSIAN white-noise figure and the rack produces no
 * Gaussian noise.
 */
export interface FeaturecvSourceRef {
  id: string;
  /** Shown caption. */
  label: string;
  /** RMS amplitude at the generator's own full level. */
  rms: number;
  /** Zero-crossing rate (fraction of adjacent pairs changing sign). */
  zcr: number;
  /** Crest factor (peak ÷ RMS). */
  crest: number;
}

export const FEATURECV_SOURCES: readonly FeaturecvSourceRef[] = [
  // A 1 kHz sine at 0.8 — the reference tone, and the crest map's stated
  // anchor (√2 ≈ 1.41 → 0.08).
  { id: 'sine', label: 'sine', rms: 0.5668, zcr: 0.0411, crest: 1.4114 },
  { id: 'brown', label: 'brown', rms: 0.1905, zcr: 0.0538, crest: 3.1876 },
  { id: 'pink', label: 'pink', rms: 0.1061, zcr: 0.2063, crest: 3.1926 },
  { id: 'white', label: 'white', rms: 0.5784, zcr: 0.4858, crest: 1.7265 },
];

/** The window statistic that drives a given feature, for one source. */
export function featurecvSourceStat(feature: FeaturecvFeature, src: FeaturecvSourceRef): number {
  switch (feature) {
    case 'loud':
      return src.rms;
    case 'bright':
      return src.zcr;
    case 'punch':
      return src.crest;
    default:
      return Number.NaN;
  }
}

/** The CV a source lands at on a feature's rail, at the live params. */
export function featurecvSourceCv(
  feature: FeaturecvFeature,
  src: FeaturecvSourceRef,
  p: FeaturecvFaceParams,
): number {
  switch (feature) {
    case 'loud':
      return featurecvLoudCv(src.rms, p);
    case 'bright':
      return featurecvBrightCv(src.zcr, p);
    case 'punch':
      return featurecvPunchCv(src.crest, p);
    default:
      return Number.NaN;
  }
}

/**
 * A CV level as a 0..1 position on the live POLARITY's rail — 0 is the jack's
 * resting floor, 1 is full scale. TOTAL, and the two non-finite cases are
 * handled DIFFERENTLY on purpose: NaN means "there is no answer" and draws at
 * the floor, while ±Infinity is a magnitude off the end of the rail and clamps
 * to the end it ran off. The panel writes this straight into a `left:%`, so a
 * NaN here would paint `left:NaN%` and drop a marker out of the picture with
 * nothing red anywhere.
 */
export function featurecvRailFill(cv: number, p: FeaturecvFaceParams): number {
  if (Number.isNaN(cv)) return 0;
  const lo = featurecvIdleCv(p);
  const span = 1 - lo;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return clamp01((cv - lo) / span);
}

/** Which features the GAIN trim can move. Measured, not assumed: ZCR and crest
 *  are both scale-invariant, so a trim in front of the analyser reaches
 *  exactly ONE of the three CVs. */
export const FEATURECV_GAIN_REACHES: readonly FeaturecvFeature[] = ['loud'];
