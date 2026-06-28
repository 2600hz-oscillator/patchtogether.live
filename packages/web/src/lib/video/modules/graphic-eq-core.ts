// packages/web/src/lib/video/modules/graphic-eq-core.ts
//
// GRAPHIC EQ core — the pure, GL-free heart of the Winamp-style VU-meter
// video output. Everything here is deterministic + side-effect-free so it
// unit-tests without a WebGL context (graphic-eq-core.test.ts):
//
//   • FFT bin → 8 log-spaced band folding (bandBinRanges / foldBands).
//   • mono fold (sum/avg of L+R) for the MONO display mode.
//   • box-segment quantization (quantizeSegments) for the STACKED-BOXES style.
//   • meter column layout — the MONO full-width vs STEREO left|right split-rect
//     math (layoutColumns / columnsInRegion) — the owner's left-on-left /
//     right-on-right split.
//   • per-meter geometry (segmentRects / solidBarTrack) + the green→yellow→red
//     colour ramp with a hue rotation (colorAt / rotateHue).
//
// The GL factory (graphicEq.ts) consumes these to build an interleaved
// pos+color VBO each frame; the card mirrors the style/display switches.

/** Number of frequency bands per audio channel — eight vertical meters. */
export const BAND_COUNT = 8;
/** LED-ladder segment count for the STACKED-BOXES style (per meter). */
export const SEGMENTS = 16;
/** Analyser FFT size → frequencyBinCount = FFT_SIZE / 2 usable bins. */
export const FFT_SIZE = 2048;
/** Low / high edge of the log-spaced band split (Hz). */
export const F_MIN = 40;
export const F_MAX = 16000;

export type BarStyle = 'bars' | 'boxes';
export type DisplayMode = 'mono' | 'stereo';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Map the discrete `style` param (0 = solid bars, 1 = stacked boxes). */
export function styleFromParam(v: number): BarStyle {
  return Math.round(v) >= 1 ? 'boxes' : 'bars';
}

/** Map the discrete `display` param (0 = mono full-width, 1 = stereo L|R). */
export function displayFromParam(v: number): DisplayMode {
  return Math.round(v) >= 1 ? 'stereo' : 'mono';
}

/**
 * Log-spaced [loBin, hiBin) ranges over the analyser's frequency bins, one
 * per band. Each band spans an equal RATIO of the F_MIN..F_MAX sweep so the
 * meters read musically (an octave-ish per band) rather than linearly bunched
 * at the bottom. Every band is guaranteed ≥1 bin and stays within the usable
 * bin count (fftSize/2). Pure → unit-tested.
 */
export function bandBinRanges(
  sampleRate: number,
  fftSize: number = FFT_SIZE,
  bandCount: number = BAND_COUNT,
  fMin: number = F_MIN,
  fMax: number = F_MAX,
): Array<[number, number]> {
  const binCount = Math.floor(fftSize / 2);
  const binWidth = sampleRate / fftSize; // Hz per bin
  const ratio = fMax / fMin;
  const out: Array<[number, number]> = new Array(bandCount);
  for (let b = 0; b < bandCount; b++) {
    const fLo = fMin * Math.pow(ratio, b / bandCount);
    const fHi = fMin * Math.pow(ratio, (b + 1) / bandCount);
    let lo = Math.floor(fLo / binWidth);
    let hi = Math.ceil(fHi / binWidth);
    lo = Math.max(0, Math.min(binCount - 1, lo));
    hi = Math.max(lo + 1, Math.min(binCount, hi));
    out[b] = [lo, hi];
  }
  return out;
}

export interface FoldOptions {
  /** Required only when `ranges` is omitted (used to derive the bin ranges). */
  sampleRate?: number;
  fftSize?: number;
  bandCount?: number;
  /** Sensitivity multiplier applied to each band magnitude before clamping. */
  gain?: number;
  /** Precomputed ranges (avoids recomputing per frame). */
  ranges?: Array<[number, number]>;
}

/**
 * Fold a byte frequency-data buffer (0..255 per bin, as getByteFrequencyData
 * returns) into `bandCount` band magnitudes in [0,1]. Each band = the average
 * bin energy over its log-spaced range, normalized by 255, scaled by `gain`,
 * clamped to [0,1]. Pure → unit-tested with synthetic spectra.
 */
export function foldBands(freq: ArrayLike<number>, opts: FoldOptions): Float32Array {
  const fftSize = opts.fftSize ?? FFT_SIZE;
  const bandCount = opts.bandCount ?? BAND_COUNT;
  const gain = opts.gain ?? 1;
  const ranges = opts.ranges ?? bandBinRanges(opts.sampleRate ?? 44100, fftSize, bandCount);
  const out = new Float32Array(bandCount);
  for (let b = 0; b < bandCount; b++) {
    const [lo, hi] = ranges[b]!;
    let sum = 0;
    let n = 0;
    for (let i = lo; i < hi && i < freq.length; i++) {
      sum += freq[i]!;
      n++;
    }
    const avg = n ? sum / n / 255 : 0;
    out[b] = clamp01(avg * gain);
  }
  return out;
}

/** Per-band average of the L and R band arrays — the MONO display fold. */
export function monoBands(left: ArrayLike<number>, right: ArrayLike<number>): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
  return out;
}

/**
 * Number of LED segments lit for a level in [0,1] over `segments` rungs.
 * Round-to-nearest so level 0.5 lights exactly half; 0 lights none, 1 lights
 * all. Pure → unit-tested.
 */
export function quantizeSegments(level: number, segments: number = SEGMENTS): number {
  return Math.max(0, Math.min(segments, Math.round(clamp01(level) * segments)));
}

/** A normalized rectangle: x in [0,1] left→right, y in [0,1] bottom→top. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One frequency meter — a horizontal slot [x0,x1] carrying a band level. */
export interface MeterColumn {
  x0: number;
  x1: number;
  level: number;
  band: number;
  channel: 'mono' | 'left' | 'right';
}

/**
 * Lay out `bands.length` equal meter slots across the horizontal region
 * [regionX0, regionX1], leaving a `gapFrac` fraction of each slot empty on
 * each side (the inter-bar gutter). Pure → unit-tested (the split-rect math).
 */
export function columnsInRegion(
  bands: ArrayLike<number>,
  regionX0: number,
  regionX1: number,
  channel: MeterColumn['channel'],
  gapFrac = 0.18,
): MeterColumn[] {
  const n = bands.length;
  const out: MeterColumn[] = new Array(n);
  const span = regionX1 - regionX0;
  const slot = span / n;
  const gap = slot * gapFrac;
  for (let i = 0; i < n; i++) {
    const sx0 = regionX0 + i * slot;
    out[i] = {
      x0: sx0 + gap * 0.5,
      x1: sx0 + slot - gap * 0.5,
      level: clamp01(bands[i] ?? 0),
      band: i,
      channel,
    };
  }
  return out;
}

/**
 * Build the full set of meter columns for the current display mode.
 *   MONO   → `BAND_COUNT` columns across the full width, fed by the L/R average.
 *   STEREO → the LEFT channel's columns across the LEFT half [0,0.5] and the
 *            RIGHT channel's across the RIGHT half [0.5,1] (left-on-left /
 *            right-on-right, the owner's preference). Pure → unit-tested.
 */
export function layoutColumns(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  display: DisplayMode,
  opts: { gapFrac?: number; centerGap?: number } = {},
): MeterColumn[] {
  const gapFrac = opts.gapFrac ?? 0.18;
  if (display === 'mono') {
    return columnsInRegion(monoBands(left, right), 0, 1, 'mono', gapFrac);
  }
  // STEREO: split vertically down the middle, with a small center gutter so the
  // two halves read as distinct panels.
  const half = opts.centerGap ?? 0.01;
  const leftCols = columnsInRegion(left, 0, 0.5 - half, 'left', gapFrac);
  const rightCols = columnsInRegion(right, 0.5 + half, 1, 'right', gapFrac);
  return [...leftCols, ...rightCols];
}

/**
 * The `segments` stacked-box rectangles for one meter column, each leaving a
 * `gapFrac` gutter between rungs, plus the count lit for the column's level.
 * The renderer draws rung i bright (lit) for i < lit, dim otherwise. Pure.
 */
export function segmentRects(
  col: MeterColumn,
  segments: number = SEGMENTS,
  gapFrac = 0.22,
): { lit: number; rects: Rect[] } {
  const lit = quantizeSegments(col.level, segments);
  const segH = 1 / segments;
  const gap = segH * gapFrac;
  const rects: Rect[] = new Array(segments);
  for (let i = 0; i < segments; i++) {
    rects[i] = {
      x0: col.x0,
      y0: i * segH + gap * 0.5,
      x1: col.x1,
      y1: (i + 1) * segH - gap * 0.5,
    };
  }
  return { lit, rects };
}

/** The full-height dim "track" behind a SOLID-BARS column, and the lit fill
 *  rect (0 → level). The renderer draws the track dim, the fill as a vertical
 *  green→yellow→red gradient. */
export function solidBarRects(col: MeterColumn): { track: Rect; fill: Rect } {
  return {
    track: { x0: col.x0, y0: 0, x1: col.x1, y1: 1 },
    fill: { x0: col.x0, y0: 0, x1: col.x1, y1: clamp01(col.level) },
  };
}

/**
 * Classic VU colour ramp at vertical fraction `yFrac` (0 = bottom, 1 = top):
 * green at the bottom, yellow in the upper-middle, red at the very top, then
 * rotated by `hue` turns (0..1 → 0..360°). Pure → unit-tested.
 */
export function colorAt(yFrac: number, hue = 0): [number, number, number] {
  const y = clamp01(yFrac);
  let r: number;
  let g: number;
  const b = 0;
  if (y < 0.6) {
    // green (0,1,0) → yellow (1,1,0)
    r = y / 0.6;
    g = 1;
  } else {
    // yellow (1,1,0) → red (1,0,0)
    r = 1;
    g = 1 - (y - 0.6) / 0.4;
  }
  const base: [number, number, number] = [r, g, b];
  return hue === 0 ? base : rotateHue(base, hue * 360);
}

/**
 * Luma-preserving hue rotation of an RGB triple by `degrees`. Standard
 * constant-luminance hue-rotate matrix (the same one CSS `hue-rotate` uses).
 * Output channels are clamped to [0,1]. Pure → unit-tested.
 */
export function rotateHue(
  [r, g, b]: readonly [number, number, number],
  degrees: number,
): [number, number, number] {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Standard hue-rotate matrix (luma weights 0.213/0.715/0.072).
  const m = [
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.14,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072,
  ];
  return [
    clamp01(r * m[0]! + g * m[1]! + b * m[2]!),
    clamp01(r * m[3]! + g * m[4]! + b * m[5]!),
    clamp01(r * m[6]! + g * m[7]! + b * m[8]!),
  ];
}

/**
 * Advance a peak-hold cap toward the live level: jump up instantly to a new
 * peak, otherwise decay multiplicatively by `decay` per frame (0.5 = fast
 * fall, 0.99 = lingering). Pure → unit-tested.
 */
export function decayPeak(prevPeak: number, level: number, decay: number): number {
  const l = clamp01(level);
  if (l >= prevPeak) return l;
  return Math.max(l, prevPeak * clamp01(decay));
}
