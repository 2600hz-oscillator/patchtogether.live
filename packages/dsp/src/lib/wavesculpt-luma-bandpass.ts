// packages/dsp/src/lib/wavesculpt-luma-bandpass.ts
//
// WAVESCULPT luminosity → morphable BANDPASS mapping.
//
// Each waveform line passes THROUGH the 3D box and crosses the two walls it
// intersects. The card samples the LUMINOSITY (0..1, black..white) at the
// centre points of those two crossings each frame and posts the pair to the
// engine worklet as k-rate params. This module maps that luminosity pair to a
// morphable band-pass on that line's audio, reusing the shared TPT SVF block
// (svfStep bp tap) from resofilter-dsp.ts.
//
// Design (owner spec — "cutoff freqs determined by the luminosity of the two
// walls each line passes through"):
//   * Each luminosity 0..1 maps (log scale) to a passband EDGE frequency
//     between LUMA_BP_FMIN (dark) and LUMA_BP_FMAX (bright). The two
//     luminosities therefore give the line's two band edges.
//   * bright / white centre points  → both edges high + far apart → the band
//     is WIDE OPEN (wide passband, high cutoff): the line passes almost
//     unfiltered.
//   * black centre points           → both edges low + close together → a
//     NARROW band (but NEVER zero width / never fully silent — there is always
//     a non-trivial passband at LUMA_BP_FMIN so a dark line is filtered, not
//     muted).
//   * smooth morph between the two extremes (continuous in the luminosities).
//
// Concretely: centre frequency = geometric mean of the two edge freqs; the
// band WIDTH (in octaves) comes from how far apart the edges sit (their ratio)
// PLUS a brightness term so bright lines open up even when both walls read the
// same. Resonance (SVF damping k) is derived from the width — wide band → low
// resonance, narrow band → high resonance — clamped so the filter is always a
// well-behaved band-pass (never self-oscillating, never silent).
//
// All math is pure + exported so the DSP unit test can pin: white = wide/open,
// black = narrow-nonzero, monotonic in luminosity, bounded, no NaN/Inf, and
// that it is genuinely a BAND-PASS (rejects DC + Nyquist, passes mid).

import { cutoffToG, resToK, svfStep, type SvfState } from './resofilter-dsp';

/** Darkest passband edge — a fully-black wall crossing still passes a band
 *  around here (low, but audible — never silent). */
export const LUMA_BP_FMIN = 180;
/** Brightest passband edge — a fully-white wall crossing opens the band right
 *  up to here (effectively wide-open for an audible-band line). */
export const LUMA_BP_FMAX = 16000;

/** Resonance (0..1) bounds. Narrow (dark) bands get the higher resonance for a
 *  focused peak; wide (bright) bands get the lower resonance so the passband is
 *  broad + flat. Both stay clear of self-oscillation (resToK floors k>0). */
export const LUMA_BP_RES_WIDE = 0.15;   // bright → broad, gentle band
export const LUMA_BP_RES_NARROW = 0.72; // dark → focused, narrow band

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Map a single luminosity (0..1) to a passband edge frequency (Hz), log
 *  scale between LUMA_BP_FMIN (black) and LUMA_BP_FMAX (white). NaN/Inf-safe
 *  (treated as 0). Monotonic increasing in luminosity. */
export function lumaToEdgeHz(luma: number): number {
  const L = Number.isFinite(luma) ? clamp01(luma) : 0;
  const lo = Math.log(LUMA_BP_FMIN);
  const hi = Math.log(LUMA_BP_FMAX);
  return Math.exp(lo + (hi - lo) * L);
}

export interface LumaBandpassParams {
  /** SVF centre frequency in Hz. */
  centerHz: number;
  /** Resonance 0..1 (→ SVF damping k via resToK). */
  res: number;
}

/** Resolve the two wall luminosities into a band-pass centre + resonance.
 *
 *  `depth` (0..1) scales the effect from OFF (depth 0 → wide-open, the line is
 *  effectively unfiltered: centre near FMAX, broad band) to FULL (depth 1 →
 *  the luminosity fully shapes the band). This lets the feature be enable-/
 *  depth-controlled from the UI while staying automatic from the walls.
 *
 *  Pure + bounded. Both luminosities NaN/Inf-safe. */
export function lumaBandpassParams(
  lumA: number,
  lumB: number,
  depth = 1,
): LumaBandpassParams {
  const d = Number.isFinite(depth) ? clamp01(depth) : 0;
  const eA = lumaToEdgeHz(lumA);
  const eB = lumaToEdgeHz(lumB);
  // Edge ordering for the band: low edge = min, high edge = max.
  const loHz = Math.min(eA, eB);
  const hiHz = Math.max(eA, eB);
  // Centre = geometric mean of the two edges (log-domain midpoint).
  const fullCenter = Math.sqrt(loHz * hiHz);
  // Brightness term: the average luminosity also opens the band — two equally-
  // bright walls (same luminosity → equal edges → zero spread) should STILL be
  // wide open, not a razor band. avgL 0..1.
  const avgL = (clamp01(Number.isFinite(lumA) ? lumA : 0)
    + clamp01(Number.isFinite(lumB) ? lumB : 0)) / 2;
  // Width in octaves: the edge ratio gives the luminosity-CONTRAST width; the
  // brightness term adds a floor of openness so bright lines are broad. Dark +
  // equal walls → small but NONZERO width (min 0.5 octave).
  const ratioOct = Math.log2(hiHz / loHz);          // 0 when edges equal
  const widthOct = 0.5 + ratioOct + avgL * 4.0;     // >= 0.5 always
  // Map width (octaves) → resonance. Wide → LUMA_BP_RES_WIDE, narrow →
  // LUMA_BP_RES_NARROW. Normalise width over a musical 0..6-octave span.
  const wNorm = clamp01(widthOct / 6.0);
  const fullRes = LUMA_BP_RES_NARROW
    + (LUMA_BP_RES_WIDE - LUMA_BP_RES_NARROW) * wNorm;
  // depth blends from "wide open / unfiltered" (centre high, res low) toward
  // the luminosity-shaped band. At depth 0 the line is effectively bypassed.
  const openCenter = LUMA_BP_FMAX * 0.5;
  const centerHz = openCenter + (fullCenter - openCenter) * d;
  const res = LUMA_BP_RES_WIDE + (fullRes - LUMA_BP_RES_WIDE) * d;
  return { centerHz, res };
}

/** Stateful per-channel luminosity band-pass. Bundles one SVF state + a
 *  one-pole smoother on the centre frequency (in log-Hz) so the k-rate
 *  luminosity posts don't zipper. One instance per audio channel per osc. */
export class LumaBandpassChannel {
  private state: SvfState = { ic1: 0, ic2: 0 };
  private smLogF: number;          // smoothed centre, in natural-log Hz
  private smRes: number;           // smoothed resonance
  private readonly aF: number;     // smoothing coeff for centre
  private readonly aR: number;     // smoothing coeff for resonance
  private readonly sr: number;

  constructor(sr: number, smoothHz = 30) {
    this.sr = sr;
    this.aF = 1 - Math.exp(-2 * Math.PI * smoothHz / sr);
    this.aR = this.aF;
    this.smLogF = Math.log(LUMA_BP_FMAX * 0.5);
    this.smRes = LUMA_BP_RES_WIDE;
  }

  /** Process one sample. Pass the per-sample (or per-block) luminosity pair +
   *  depth; the band-pass tap is returned. Centre + resonance are smoothed
   *  internally (no zipper). */
  step(x: number, lumA: number, lumB: number, depth: number): number {
    const { centerHz, res } = lumaBandpassParams(lumA, lumB, depth);
    const targetLogF = Math.log(centerHz);
    this.smLogF += this.aF * (targetLogF - this.smLogF);
    this.smRes += this.aR * (res - this.smRes);
    const g = cutoffToG(Math.exp(this.smLogF), this.sr);
    const k = resToK(this.smRes);
    const taps = svfStep(x, g, k, this.state);
    return taps.bp;
  }
}

/** Pure-math render helper for the DSP unit test — runs `input` through the
 *  luminosity band-pass with a constant luminosity pair + depth. */
export function renderLumaBandpass(
  input: Float32Array,
  opts: { lumA: number; lumB: number; depth?: number; sr: number },
): Float32Array {
  const ch = new LumaBandpassChannel(opts.sr);
  const out = new Float32Array(input.length);
  const depth = opts.depth ?? 1;
  for (let i = 0; i < input.length; i++) {
    out[i] = ch.step(input[i] ?? 0, opts.lumA, opts.lumB, depth);
  }
  return out;
}
