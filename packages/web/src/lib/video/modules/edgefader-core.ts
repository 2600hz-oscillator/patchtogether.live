// EDGEFADER — the pure transition core (no DOM, no GL). The GLSL composite in
// edgefader.ts is a line-for-line port of the functions here (constants copied,
// never re-derived), so the software-renderer GPU is NOT the source of truth —
// this core is, and edgefader-core.test.ts pins it bit-for-bit.
//
// WHAT THE TRANSITION IS. Two video frames A and B, one fader t ∈ [0,1]. The
// frame is cut into EDGEFADER_BANDS horizontal bands (band 0 at the TOP). Each
// band fades A→B over its own window of the fader's travel, and the windows
// CASCADE down the screen: band k starts when band k−1 is half done, and band
// k−1 finishes exactly when band k reaches the level band k−1 had when band k
// started. Within a band the fade is not uniform: pixels on an EDGE (Sobel +
// threshold + dilate, the EDGES operator) go first, pixels where A's edges and
// B's edges COINCIDE go first of all, and a pixel just INSIDE an edge (centre-
// ward of it) leads a pixel just OUTSIDE it — so the fade ripples down the
// edges. The visual operator is a BLUR that peaks mid-fade (edged regions go
// soft, then the incoming frame's edges sharpen in) or, with MELT engaged, a
// per-column downward slide with liquid drip lengths and droplet heads that
// carry the melting band down into the band below (DOOM-style screen melt,
// smoothed across columns with value noise so it is liquid rather than striped).
//
// Endpoints are EXACT for every pixel and every mode: t ≤ 0 → A, t ≥ 1 → B.
//
// DETERMINISM. Nothing here reads a clock, a previous frame or Math.random:
// every term is a function of (t, pixel position, the two edge masks, params).
// Per-column randomness comes from an INTEGER hash (`meltHash`, 32-bit
// multiply/xorshift) so the CPU mirror and the float32 GPU agree bit-for-bit —
// the sin-based hash fader-transitions uses is deterministic per renderer but
// NOT across renderers once its argument exceeds a few thousand.

import { edgesPixel, EDGES_MAX_THICKNESS } from './edges';

// ─────────────────────────── constants (shared with the GLSL) ───────────────

/** Horizontal bands the fade cascades through, top to bottom. */
export const EDGEFADER_BANDS = 5;

/** The edge atlas renders at engine-res × this. Thickness (px) maps to a
 *  dilation radius in ATLAS texels through `dilateRadius`. */
export const EDGEFADER_EDGE_SCALE = 0.5;

/** Compile-time bound of the dilate window (atlas texels). */
export const EDGEFADER_DILATE_MAX_R = 4;

/** ρ — the fraction of its band's window a single pixel's own fade occupies.
 *  A pixel with lead 1 fades during the FIRST ρ of the window, a pixel with
 *  lead 0 during the LAST ρ; every pixel starts after the window opens and
 *  finishes by the time it closes. */
export const EDGEFADER_LOCAL_FRACTION = 0.5;

/** Lead contributions (see `leadFor`). */
export const EDGEFADER_LEAD_EDGE = 0.5;
export const EDGEFADER_LEAD_COINCIDENCE = 0.3;
export const EDGEFADER_LEAD_INSIDE = 0.25;

/** Peak blur radius (engine px) on a fully-edged pixel at mid-fade. */
export const EDGEFADER_BLUR_MAX_PX = 24;

/** Inside/outside ray taps (engine px) toward and away from screen centre. */
export const EDGEFADER_RAY_TAPS_PX: readonly number[] = [4, 8, 14, 22];

/** Blur kernel: 13 fixed offsets on the unit disc (scaled by the radius) and
 *  their weights (sum to 1). Centre, an inner ring at 0.5, an outer ring at 1. */
const R2 = Math.SQRT1_2;
export const EDGEFADER_BLUR_TAPS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0.2],
  [0.5, 0, 0.1], [-0.5, 0, 0.1], [0, 0.5, 0.1], [0, -0.5, 0.1],
  [1, 0, 0.05], [-1, 0, 0.05], [0, 1, 0.05], [0, -1, 0.05],
  [R2, R2, 0.05], [-R2, R2, 0.05], [R2, -R2, 0.05], [-R2, -R2, 0.05],
];

/** Melt: columns across the frame that carry their own drip. */
export const EDGEFADER_MELT_COLS = 96;
/** Melt: the latest a column may start dripping, as a fraction of the band window. */
export const EDGEFADER_MELT_DELAY_MAX = 0.35;
/** Melt: the longest drip, in uv (fraction of frame height). Capped below one
 *  band height so a drip reaches at most the bottom of the NEXT band. */
export const EDGEFADER_DRIP_MAX_UV = 0.18;
/** Melt: the shortest drip relative to the longest. */
export const EDGEFADER_DRIP_MIN_FRAC = 0.55;
/** Melt: horizontal liquid wobble of the sliding content, in uv. */
export const EDGEFADER_WOBBLE_UV = 0.006;
/** Melt: the drip front's softness, in uv (a wet edge, not a hard cut). */
export const EDGEFADER_FRONT_SOFT_UV = 0.012;
/** Melt: how far the droplet head rounds the front across neighbouring columns. */
export const EDGEFADER_HEAD_ROUND = 0.35;

// ─────────────────────────── small math (GLSL-equivalent) ───────────────────

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** GLSL-style smoothstep with the e0 == e1 case made a HARD step (the GLSL
 *  builtin is undefined there; the shader spells this formula out). */
export function softStep(e0: number, e1: number, x: number): number {
  const d = e1 - e0;
  if (d <= 1e-9) return x < e0 ? 0 : 1;
  const u = clamp01((x - e0) / d);
  return u * u * (3 - 2 * u);
}

/** 32-bit integer hash → [0,1). Bit-exact between JS (imul / >>>) and GLSL
 *  ES 3.0 uint arithmetic, which is what makes the melt geometry a true mirror. */
export function meltHash(i: number, seed: number): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffffff) / 16777216;
}

/** 1-D value noise over `x` (smooth between integer lattice points), [0,1). */
export function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return meltHash(i, seed) * (1 - u) + meltHash(i + 1, seed) * u;
}

// ─────────────────────────── the cascade ────────────────────────────────────

/** Stagger between consecutive band starts, as a fraction of fader travel. */
export function bandStagger(n: number = EDGEFADER_BANDS): number {
  return 1 / (n + 1);
}

/** Length of every band's window — exactly two staggers, which is what makes
 *  "the next band starts when this one is half done" and "this one finishes
 *  when the next is as far along as this one was then" the SAME statement. */
export function bandWindowLength(n: number = EDGEFADER_BANDS): number {
  return 2 / (n + 1);
}

export function bandWindow(k: number, n: number = EDGEFADER_BANDS): { start: number; end: number } {
  const start = k / (n + 1);
  return { start, end: start + 2 / (n + 1) };
}

/** Band k's own progress at fader t: 0 before its window opens, 1 after it
 *  closes, linear in between. */
export function bandProgress(t: number, k: number, n: number = EDGEFADER_BANDS): number {
  const start = k / (n + 1);
  return clamp01((t - start) * (n + 1) * 0.5);
}

/** Every band's progress at fader t, top to bottom. */
export function cascadeProgress(t: number, n: number = EDGEFADER_BANDS): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(bandProgress(t, k, n));
  return out;
}

/** Which band a row belongs to. `rowFromTop` ∈ [0,1], 0 = top edge. */
export function bandOf(rowFromTop: number, n: number = EDGEFADER_BANDS): number {
  const k = Math.floor(rowFromTop * n);
  return k < 0 ? 0 : k > n - 1 ? n - 1 : k;
}

// ─────────────────────────── per-pixel lead / local progress ────────────────

/** A pixel's edge field, read off the atlas (every term ∈ [0,1] except
 *  `inside` ∈ [−1,1]). */
export interface EdgeField {
  /** max(edgeA, edgeB) — this pixel sits on an edge of either frame. */
  wEdge: number;
  /** min(edgeA, edgeB) — A's edge and B's edge COINCIDE here (the "regions
   *  most like each other in where their edges are"). */
  wCoinc: number;
  /** +1 = an edge lies on the pixel's border-ward side (the pixel is INSIDE
   *  it, centre-ward); −1 = an edge lies between the pixel and the centre
   *  (OUTSIDE); 0 = neither / both. */
  inside: number;
  /** Proximity to the nearest edge along the centre ray (0 = none within the
   *  taps). Scales the inside term so flat regions far from any edge get no
   *  bias at all. */
  nearEdge: number;
}

/**
 * Normalised LEAD ∈ [0,1] — how early within its band's window this pixel
 * fades. Ordering, by construction: coincident edge > plain edge > inside-
 * near-edge > flat (far from edges) > outside-near-edge.
 */
export function leadFor(f: EdgeField): number {
  const raw = f.wEdge * (EDGEFADER_LEAD_EDGE + EDGEFADER_LEAD_COINCIDENCE * f.wCoinc)
    + EDGEFADER_LEAD_INSIDE * f.inside * f.nearEdge;
  const span = EDGEFADER_LEAD_EDGE + EDGEFADER_LEAD_COINCIDENCE + 2 * EDGEFADER_LEAD_INSIDE;
  return clamp01((raw + EDGEFADER_LEAD_INSIDE) / span);
}

/**
 * The pixel's OWN progress given its band's progress and its lead. A pixel
 * with lead 1 runs through its fade over the first ρ of the band window; lead
 * 0 over the last ρ. pBand = 0 → 0 and pBand = 1 → 1 for EVERY lead, which is
 * what keeps the fader's endpoints exact.
 */
export function localProgress(pBand: number, leadN: number): number {
  const delay = 1 - clamp01(leadN);
  const rho = EDGEFADER_LOCAL_FRACTION;
  return clamp01((clamp01(pBand) - delay * (1 - rho)) / rho);
}

/** Blur radius (engine px): a bump that is 0 at both ends of the pixel's
 *  fade and peaks mid-way, scaled by how edged the pixel is. */
export function blurRadiusPx(pLocal: number, wEdge: number): number {
  const p = clamp01(pLocal);
  return EDGEFADER_BLUR_MAX_PX * clamp01(wEdge) * 4 * p * (1 - p);
}

/** A→B blend weight from the pixel's own progress (0 = A, 1 = B). */
export function blendWeight(pLocal: number): number {
  return softStep(0, 1, pLocal);
}

/** Dilation radius in ATLAS texels for a thickness in engine px — the one
 *  place the EDGES px meaning is rescaled to the atlas. */
export function dilateRadius(thicknessPx: number): number {
  const t = Math.max(1, Math.min(EDGES_MAX_THICKNESS, thicknessPx));
  const r = Math.round((t - 1) * EDGEFADER_EDGE_SCALE);
  return r < 0 ? 0 : r > EDGEFADER_DILATE_MAX_R ? EDGEFADER_DILATE_MAX_R : r;
}

/**
 * Inside/outside along the ray to screen centre. `sampleEdge(px, py)` reads
 * wEdge at an absolute pixel position (edge-clamped). Returns the `inside` and
 * `nearEdge` terms of an EdgeField. Taps are in the same px units as x/y.
 */
export function insideScore(
  sampleEdge: (px: number, py: number) => number,
  x: number,
  y: number,
  cx: number,
  cy: number,
  tapsPx: readonly number[] = EDGEFADER_RAY_TAPS_PX,
): { inside: number; nearEdge: number } {
  let dx = cx - x;
  let dy = cy - y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { inside: 0, nearEdge: 0 };
  dx /= len;
  dy /= len;
  let toward = 0;
  let away = 0;
  for (const s of tapsPx) {
    toward = Math.max(toward, sampleEdge(x + dx * s, y + dy * s));
    away = Math.max(away, sampleEdge(x - dx * s, y - dy * s));
  }
  return { inside: away - toward, nearEdge: Math.max(toward, away) };
}

// ─────────────────────────── melt geometry ──────────────────────────────────

/** One column's drip for band k at that band's progress. `extent` is how far
 *  (uv, downward) the band's content has slid; `delay` is where in the band
 *  window the column started. */
export function meltColumn(col: number, k: number, pBand: number): { delay: number; extent: number } {
  const delay = EDGEFADER_MELT_DELAY_MAX * valueNoise(col * 0.25, 11 + k);
  const lenFrac = EDGEFADER_DRIP_MIN_FRAC + (1 - EDGEFADER_DRIP_MIN_FRAC) * valueNoise(col * 0.125 + 5, 23 + k);
  // Ease-in: a drip accelerates as it falls (DOOM's columns gain speed each
  // tick), and it reaches full length exactly at the end of the band window.
  const u = clamp01((clamp01(pBand) - delay) / (1 - delay));
  const extent = EDGEFADER_DRIP_MAX_UV * lenFrac * u * u;
  return { delay, extent };
}

/** The drip FRONT at horizontal position x01 for band k: the column's own
 *  extent rounded against its two neighbours, so a long column next to short
 *  ones reads as a droplet head rather than a bar. */
export function dripFront(x01: number, k: number, pBand: number): number {
  const colF = x01 * EDGEFADER_MELT_COLS;
  const col = Math.floor(colF);
  const fx = colF - col; // 0..1 across the column
  // Distance (in columns) from this x to each column's centre; a column's tip
  // reaches sideways with a parabolic falloff, and the front is the union of
  // the three rounded tips — a long column between short ones is a droplet.
  const dOwn = Math.abs(fx - 0.5);
  const dLeft = fx + 0.5;
  const dRight = 1.5 - fx;
  const tip = (c: number, d: number): number =>
    Math.max(0, meltColumn(c, k, pBand).extent * (1 - EDGEFADER_HEAD_ROUND * d * d));
  return Math.max(tip(col, dOwn), Math.max(tip(col - 1, dLeft), tip(col + 1, dRight)));
}

/** Where one layer of the melt reads the OUTGOING frame from, and how much of
 *  the vacated space above the front shows the incoming frame. */
export interface MeltLayer {
  /** How far (uv, downward) this band's content has slid at this x. */
  extent: number;
  /** 1 = this row is below the drip front (slid content is here), 0 = above
   *  it (vacated — the incoming frame shows); soft across the front. */
  content: number;
  /** Row (from top, uv) the outgoing frame is sampled from — always ≤ the
   *  pixel's own row: content only ever slides DOWN. */
  srcRowFromTop: number;
  /** Horizontal liquid wobble of the sample (uv). */
  xShift: number;
}

export function meltLayer(x01: number, rowFromTop: number, k: number, pBand: number, n: number = EDGEFADER_BANDS): MeltLayer {
  const extent = dripFront(x01, k, pBand);
  const bandTop = k / n;
  const dy = rowFromTop - bandTop;
  const soft = Math.min(EDGEFADER_FRONT_SOFT_UV, extent * 0.5);
  const content = softStep(extent - soft, extent + soft, dy);
  const col = Math.floor(x01 * EDGEFADER_MELT_COLS);
  const phase = meltHash(col, 41 + k) * 6.2831853;
  const amount = extent / EDGEFADER_DRIP_MAX_UV;
  const xShift = EDGEFADER_WOBBLE_UV * Math.sin(rowFromTop * 31 + phase) * amount;
  return { extent, content, srcRowFromTop: rowFromTop - extent, xShift };
}

// ─────────────────────────── the full per-pixel composite (CPU mirror) ──────

export interface EdgefaderParams {
  threshold: number;
  thickness: number;
  melt: boolean;
}

export interface MirrorOptions {
  /** Ray taps in GRID px (the engine uses EDGEFADER_RAY_TAPS_PX; a small test
   *  grid passes smaller taps). */
  rayTapsPx?: readonly number[];
  /** Peak blur radius in GRID px (default EDGEFADER_BLUR_MAX_PX). */
  blurMaxPx?: number;
  /** Bands (default EDGEFADER_BANDS). */
  bands?: number;
}

/** Edge-clamped bilinear read of a row-major luma grid at a fractional px. */
export function sampleGrid(w: number, h: number, grid: ArrayLike<number>, x: number, y: number): number {
  const cx = Math.max(0, Math.min(w - 1, x));
  const cy = Math.max(0, Math.min(h - 1, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = grid[y0 * w + x0]! * (1 - fx) + grid[y0 * w + x1]! * fx;
  const b = grid[y1 * w + x0]! * (1 - fx) + grid[y1 * w + x1]! * fx;
  return a * (1 - fy) + b * fy;
}

/** The disc blur over a luma grid (bilinear taps). r = 0 → the plain sample. */
export function blurGrid(w: number, h: number, grid: ArrayLike<number>, x: number, y: number, rPx: number): number {
  if (rPx < 0.5) return sampleGrid(w, h, grid, x, y);
  let acc = 0;
  for (const [ox, oy, wt] of EDGEFADER_BLUR_TAPS) acc += wt * sampleGrid(w, h, grid, x + ox * rPx, y + oy * rPx);
  return acc;
}

/**
 * The per-pixel EdgeField of a synthetic A/B pair on a grid — the mirror's
 * "atlas" (1 grid texel = 1 atlas texel; the engine's half-res atlas is the
 * same math subsampled, then bilinearly read).
 */
export function edgeFieldAt(
  w: number,
  h: number,
  lumaA: ArrayLike<number>,
  lumaB: ArrayLike<number>,
  x: number,
  y: number,
  threshold: number,
  thicknessPx: number,
  rayTapsPx: readonly number[] = EDGEFADER_RAY_TAPS_PX,
): EdgeField {
  // Thickness in engine px → dilation radius in atlas texels, then back to the
  // px thickness `edgesPixel` expects at the atlas resolution (radius + 1).
  const atlasThickness = dilateRadius(thicknessPx) + 1;
  const edgeA = (px: number, py: number): number =>
    edgesPixel(w, h, lumaA, Math.round(px), Math.round(py), threshold, atlasThickness);
  const edgeB = (px: number, py: number): number =>
    edgesPixel(w, h, lumaB, Math.round(px), Math.round(py), threshold, atlasThickness);
  const eA = edgeA(x, y);
  const eB = edgeB(x, y);
  const wEdgeAt = (px: number, py: number): number => Math.max(edgeA(px, py), edgeB(px, py));
  const { inside, nearEdge } = insideScore(wEdgeAt, x, y, (w - 1) / 2, (h - 1) / 2, rayTapsPx);
  return { wEdge: Math.max(eA, eB), wCoinc: Math.min(eA, eB), inside, nearEdge };
}

/**
 * The full composite for ONE output pixel of a synthetic A/B pair: the exact
 * CPU mirror of the COMPOSITE pass. `x`, `y` index the grid (y = 0 is the TOP
 * row, matching `rowFromTop`). Returns the output luma.
 */
export function edgefaderPixel(
  w: number,
  h: number,
  lumaA: ArrayLike<number>,
  lumaB: ArrayLike<number>,
  x: number,
  y: number,
  t: number,
  params: EdgefaderParams,
  opts: MirrorOptions = {},
): number {
  const n = opts.bands ?? EDGEFADER_BANDS;
  const blurMax = opts.blurMaxPx ?? EDGEFADER_BLUR_MAX_PX;
  const rowFromTop = (y + 0.5) / h;
  const x01 = (x + 0.5) / w;
  const k = bandOf(rowFromTop, n);
  const pBand = bandProgress(t, k, n);
  const field = edgeFieldAt(w, h, lumaA, lumaB, x, y, params.threshold, params.thickness, opts.rayTapsPx);
  const leadN = leadFor(field);
  const pLocal = localProgress(pBand, leadN);
  const blend = blendWeight(pLocal);

  if (!params.melt) {
    const r = blurRadiusPx(pLocal, field.wEdge) * (blurMax / EDGEFADER_BLUR_MAX_PX);
    const a = blurGrid(w, h, lumaA, x, y, r);
    const b = blurGrid(w, h, lumaB, x, y, r);
    return a + (b - a) * blend;
  }

  // MELT — the band's own slide, then any drip arriving from the band above.
  const bAt = sampleGrid(w, h, lumaB, x, y);
  const own = meltLayer(x01, rowFromTop, k, pBand, n);
  const aOwn = sampleGrid(w, h, lumaA, (x01 + own.xShift) * w - 0.5, own.srcRowFromTop * h - 0.5);
  const slid = aOwn + (bAt - aOwn) * blend;          // the slid content, fading to B
  let out = bAt + (slid - bAt) * own.content;        // above the front: vacated → B

  if (k > 0) {
    const pAbove = bandProgress(t, k - 1, n);
    const above = meltLayer(x01, rowFromTop, k - 1, pAbove, n);
    // The band above's content slid down by its extent, so its bottom rows now
    // sit in the top `extent` of THIS band: a row within that reach shows the
    // dripping content (sampled from where it came from, inside the band above).
    const reach = above.extent;
    if (reach > 0) {
      const dy = rowFromTop - k / n;
      const soft = Math.min(EDGEFADER_FRONT_SOFT_UV, reach * 0.5);
      const inDrip = 1 - softStep(reach - soft, reach + soft, dy);
      const aDrip = sampleGrid(w, h, lumaA, (x01 + above.xShift) * w - 0.5, above.srcRowFromTop * h - 0.5);
      const blendAbove = blendWeight(localProgress(pAbove, leadN));
      const dripped = aDrip + (bAt - aDrip) * blendAbove;
      out = out + (dripped - out) * inDrip;
    }
  }
  return out;
}
