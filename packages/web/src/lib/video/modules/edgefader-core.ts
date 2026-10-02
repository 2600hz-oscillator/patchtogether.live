// EDGEFADER — the pure transition core (no DOM, no GL). The GLSL in
// edgefader.ts is a port of the functions here (constants interpolated from
// these exports, never re-typed), so the software-renderer GPU is NOT the
// source of truth — this core is, and edgefader-core.test.ts pins it.
//
// WHAT THE TRANSITION IS. Two video frames A and B, one fader t ∈ [0,1]. The
// frame is cut into EDGEFADER_BANDS horizontal bands (band 0 at the TOP). Each
// band fades A→B over its own window of the fader's travel, and the windows
// CASCADE down the screen: band k starts when band k−1 is half done, and band
// k−1 finishes exactly when band k reaches the level band k−1 had when band k
// started (the band-centre law `bandProgress`; between centres the start is
// interpolated row by row — `rowProgress` — so there is no seam at a band
// boundary). Within a band the fade is not uniform: pixels on an EDGE (the
// EDGES operator: Sobel + threshold + dilate, run on BOTH frames) go first,
// pixels where A's edges and B's edges COINCIDE go first of all, pixels in a
// REGION where both frames carry a similar amount of edge (the coarse
// similarity term — "the regions most like each other in where their edges
// are") lead their flat neighbours, and a pixel just INSIDE an edge (centre-
// ward of it) leads one just OUTSIDE it — so the fade ripples down the edges.
// The visual operator is a BLUR that peaks mid-fade (the edged regions go
// soft, then the incoming frame's edges sharpen in) or, with MELT engaged, a
// per-column downward slide with liquid drip lengths and sparse droplet
// tongues that carry the melting band down into the band below (the classic
// 1993 screen melt — per-column random start + accelerating slide — made
// stateless with value noise in place of its random walk; the drips follow the
// gl-transitions port of that melt and the droplets are iq-style 2-D SDF
// silhouettes; the PR body carries the citations).
//
// Endpoints are EXACT for every pixel and every mode: t ≤ 0 → A, t ≥ 1 → B.
//
// DETERMINISM. Nothing here reads a clock, a previous frame or Math.random:
// every term is a function of (t, pixel position, the two edge masks, params).
// Per-lane randomness comes from an INTEGER hash (`meltHash`, 32-bit
// multiply/xorshift) so the CPU mirror and the float32 GPU agree bit-for-bit —
// the sin-based hash fader-transitions uses is deterministic per renderer but
// NOT across renderers once its argument exceeds a few thousand.
//
// WHERE THE PORT IS NOT LINE-FOR-LINE, stated here so nobody "fixes" it:
//   * the GPU approximates `boxMean` (the progressive blur) with a trilinear
//     read of a mip chain at LOD log2(radius) — a box of ~radius px on a side
//     — and the coarse edge DENSITIES / the blur PROXIMITY with LOD reads of
//     the atlas (EDGEFADER_COARSE_PX / EDGEFADER_BLUR_PROX_PX cells). The
//     mirror uses true box means of about the same width (radius/2 either way
//     of the pixel). Every test on those terms is therefore a floor or an
//     ordering, never a pixel equality.
//   * the GPU's ray taps read the atlas BILINEARLY at fractional px; the mirror
//     reads its atlas bilinearly too (`sampleGrid`), but on a grid whose px are
//     the test's px, so `inside`/`nearEdge` agree in sign, not to the bit.

import { edgesPixel, EDGES_MAX_THICKNESS } from './edges';

// ─────────────────────────── constants (shared with the GLSL) ───────────────

/** Horizontal bands the fade cascades through, top to bottom. */
export const EDGEFADER_BANDS = 5;

/** ρ — the fraction of its band's window a single pixel's own fade occupies.
 *  A pixel with lead 1 fades during the FIRST ρ of the window, a pixel with
 *  lead 0 during the LAST ρ; every pixel starts after the window opens and
 *  finishes by the time it closes. */
export const EDGEFADER_LOCAL_FRACTION = 0.5;

/** Lead contributions (see `leadFor`). */
export const EDGEFADER_LEAD_EDGE = 0.5;
export const EDGEFADER_LEAD_COINCIDENCE = 0.3;
export const EDGEFADER_LEAD_SIMILARITY = 0.3;
export const EDGEFADER_LEAD_INSIDE = 0.25;

/** Peak blur radius (engine px) on a fully-edged pixel at mid-fade. */
export const EDGEFADER_BLUR_MAX_PX = 24;

/** Inside/outside ray taps (engine px) toward and away from screen centre. */
export const EDGEFADER_RAY_TAPS_PX: readonly number[] = [4, 8, 14, 22];

/** The coarse edge-density cell: a square of this many engine px on a side
 *  (the GPU reads the atlas mip at log2 of this). */
export const EDGEFADER_COARSE_PX = 32;

/** The blur PROXIMITY cell: how far from a stroke the progressive blur
 *  reaches (engine px; the GPU reads the atlas mip at log2 of this). A thin
 *  stroke only turns grey under a blur — it is the region AROUND it that
 *  visibly softens — so the blur weight comes from this wider field while the
 *  lead keeps reading the thin mask. */
export const EDGEFADER_BLUR_PROX_PX = 16;
/** The proximity density at which the blur weight saturates (a 4 px stroke
 *  in a 16 px cell is 0.25). */
export const EDGEFADER_BLUR_PROX_FULL = 0.25;

/** Fraction of each band, from its top, that starts its window AS A UNIT; the
 *  rest of the band ramps to the next band's start so the boundary is not a
 *  seam (see `rowStart`). */
export const EDGEFADER_BAND_UNIT_FRACTION = 0.75;

/** Melt: value-noise lanes across the width for the per-column start delay
 *  (coarse keeps the front liquid, fine gives the classic jaggedness). */
export const EDGEFADER_MELT_NOISE_COARSE = 12;
export const EDGEFADER_MELT_NOISE_FINE = 48;
/** Melt: value-noise lanes across the width for the drip length. */
export const EDGEFADER_MELT_LEN_LANES = 8;
/** Melt: the latest a column may start, as a fraction of the band window. */
export const EDGEFADER_MELT_DELAY_MAX = 0.35;
/** Melt: how much a column's coarse edge density pulls its start earlier. */
export const EDGEFADER_MELT_EDGE_BIAS = 0.6;
/** Melt: the longest slide, in uv (fraction of frame height). */
export const EDGEFADER_DRIP_MAX_UV = 0.12;
/** Melt: the shortest slide relative to the longest. */
export const EDGEFADER_DRIP_MIN_FRAC = 0.55;
/** Melt: horizontal liquid wobble of the sliding content, in uv. */
export const EDGEFADER_WOBBLE_UV = 0.01;
/** Melt: wobble cycles down the frame, and how far its phase advances over a
 *  band's window (radians). */
export const EDGEFADER_WOBBLE_FREQ = 3;
export const EDGEFADER_WOBBLE_RATE = 6;
/** Melt: the two value-noise octave weights of the start-delay field. */
export const EDGEFADER_MELT_OCTAVES: readonly [number, number] = [0.7, 0.3];
/** A hair added before every lattice `floor` of a lane index, on BOTH sides,
 *  so a column centre that lands exactly on a lattice point in double never
 *  sits one float32 ulp either side of it on the GPU. */
export const EDGEFADER_LANE_BIAS = 1e-4;
/** 2π, exported so the GLSL interpolates the same literal. */
export const EDGEFADER_TAU = 6.2831853;
/** The integer hash: (i·M0 + seed·M1) → xorshift 13 → ·M2 → xorshift 16. */
export const EDGEFADER_HASH_MUL: readonly [number, number, number] = [374761393, 668265263, 1274126177];
/** Melt: the drip front's softness, in uv (a wet edge, not a hard cut). */
export const EDGEFADER_FRONT_SOFT_UV = 0.01;
/** Melt droplets: lanes across the width, each carrying at most one drop. */
export const EDGEFADER_DROP_LANES = 24;
/** Melt droplets: the chance a lane carries a drop. */
export const EDGEFADER_DROP_PROB = 0.5;
/** Melt droplets: head radius range (uv, aspect-corrected). */
export const EDGEFADER_DROP_R_MIN = 0.012;
export const EDGEFADER_DROP_R_MAX = 0.02;
/** Melt droplets: lateral jitter of the drop inside its lane (lane widths). */
export const EDGEFADER_DROP_JITTER = 0.2;
/** Melt droplets: the longest tongue below the slid content (uv). DRIP_MAX +
 *  this stays below one band height, so nothing ever reaches band k+2. */
export const EDGEFADER_DROP_LEN_MAX = 0.06;
/** Melt droplets: stalk radius as a fraction of the head radius. */
export const EDGEFADER_DROP_STALK = 0.35;

// Hash seeds (one per noise field), offset by the band index at the call site.
export const EDGEFADER_SEEDS = {
  delayCoarse: 11,
  delayFine: 17,
  len: 23,
  wobble: 41,
  dropHas: 53,
  dropX: 59,
  dropR: 67,
  dropLen: 71,
} as const;

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
  let h = (Math.imul(i | 0, EDGEFADER_HASH_MUL[0]) + Math.imul(seed | 0, EDGEFADER_HASH_MUL[1])) >>> 0;
  h = Math.imul(h ^ (h >>> 13), EDGEFADER_HASH_MUL[2]) >>> 0;
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

/** Distance from `p` to the segment a→b (iq's sdSegment). */
export function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const bb = bax * bax + bay * bay;
  const h = bb <= 1e-12 ? 0 : clamp01((pax * bax + pay * bay) / bb);
  return Math.hypot(pax - bax * h, pay - bay * h);
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
 *  closes, linear in between. The BAND-CENTRE law. */
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

/** The window START for a ROW: the top EDGEFADER_BAND_UNIT_FRACTION of each
 *  band starts with the band (the five regions stay visible as regions), and
 *  the rest of the band ramps smoothly to the next band's start, so a band
 *  boundary is a soft hand-over rather than a seam. The band-centre law
 *  `bandProgress` holds exactly over the unit part of every band. */
export function rowStart(rowFromTop: number, n: number = EDGEFADER_BANDS): number {
  const scaled = rowFromTop * n;
  const k = Math.floor(scaled);
  const fr = scaled - k;
  const c = k + softStep(EDGEFADER_BAND_UNIT_FRACTION, 1, fr);
  const cc = c < 0 ? 0 : c > n - 1 ? n - 1 : c;
  return cc / (n + 1);
}

/** A row's progress at fader t (the seam-free form of `bandProgress`). */
export function rowProgress(t: number, rowFromTop: number, n: number = EDGEFADER_BANDS): number {
  return clamp01((t - rowStart(rowFromTop, n)) * (n + 1) * 0.5);
}

// ─────────────────────────── per-pixel lead / local progress ────────────────

/** A pixel's edge field, read off the atlas (every term ∈ [0,1] except
 *  `inside` ∈ [−1,1]). */
export interface EdgeField {
  /** max(edgeA, edgeB) — this pixel sits on an edge of either frame. */
  wEdge: number;
  /** min(edgeA, edgeB) — A's edge and B's edge COINCIDE here. */
  wCoinc: number;
  /** The coarse similarity: the share of the cell's edges that COINCIDE —
   *  where A's and B's edges sit in the same places (see `similarity`). */
  wSim: number;
  /** Edge proximity: the density of either frame's edges in the wider
   *  EDGEFADER_BLUR_PROX_PX cell — what the blur footprint follows. */
  wProx: number;
  /** +1 = an edge lies on the pixel's border-ward side (the pixel is INSIDE
   *  it, centre-ward); −1 = an edge lies between the pixel and the centre
   *  (OUTSIDE); 0 = neither / both. */
  inside: number;
  /** Proximity to the nearest edge along the centre ray (0 = none within the
   *  taps). Scales the inside term so flat regions far from any edge get no
   *  bias at all. */
  nearEdge: number;
}

/** The coarse "regions most like each other in where their edges are" term:
 *  of all the edge in the cell (either frame), the share that COINCIDES —
 *  1 when every edge in the cell is shared by both frames, 0 when none is.
 *  THICK sets the tolerance, because the masks it compares are the dilated
 *  ones. */
export function similarity(densA: number, densB: number, densCoinc: number): number {
  const hi = Math.max(densA, densB);
  if (hi <= 1e-6) return 0;
  return clamp01(densCoinc / hi);
}

/** The blur weight for a pixel: saturates once the proximity cell carries a
 *  stroke's worth of edge, or when the region's edges coincide. */
export function blurWeight(wProx: number, wSim: number): number {
  return Math.max(softStep(0, EDGEFADER_BLUR_PROX_FULL, wProx), clamp01(wSim));
}

/**
 * Normalised LEAD ∈ [0,1] — how early within its row's window this pixel
 * fades. Ordering, by construction: coincident edge > plain edge; a similar
 * region leads a flat one; inside-near-edge leads flat; outside-near-edge
 * equals flat (nothing ever lags the background, so no ghost outline of A is
 * the last thing standing in a band).
 */
export function leadFor(f: EdgeField): number {
  const raw = f.wEdge * (EDGEFADER_LEAD_EDGE + EDGEFADER_LEAD_COINCIDENCE * f.wCoinc)
    + EDGEFADER_LEAD_SIMILARITY * f.wSim
    + EDGEFADER_LEAD_INSIDE * Math.max(f.inside, 0) * f.nearEdge;
  const span = EDGEFADER_LEAD_EDGE + EDGEFADER_LEAD_COINCIDENCE + EDGEFADER_LEAD_SIMILARITY + EDGEFADER_LEAD_INSIDE;
  return clamp01(raw / span);
}

/**
 * The pixel's OWN progress given its row's progress and its lead. A pixel
 * with lead 1 runs through its fade over the first ρ of the window; lead 0
 * over the last ρ. p = 0 → 0 and p = 1 → 1 for EVERY lead, which is what
 * keeps the fader's endpoints exact.
 */
export function localProgress(pRow: number, leadN: number): number {
  const delay = 1 - clamp01(leadN);
  const rho = EDGEFADER_LOCAL_FRACTION;
  return clamp01((clamp01(pRow) - delay * (1 - rho)) / rho);
}

/** Blur radius (engine px): a bump that is 0 at both ends of the pixel's
 *  fade and peaks mid-way, scaled by the blur weight (`blurWeight`). */
export function blurRadiusPx(pLocal: number, wBlur: number): number {
  const p = clamp01(pLocal);
  return EDGEFADER_BLUR_MAX_PX * clamp01(wBlur) * 4 * p * (1 - p);
}

/** A→B blend weight from the pixel's own progress (0 = A, 1 = B). */
export function blendWeight(pLocal: number): number {
  return softStep(0, 1, pLocal);
}

/** The dilation radius in px for a thickness — EDGES' own law, copied. */
export function dilateRadius(thicknessPx: number): number {
  return Math.max(0, Math.min(EDGES_MAX_THICKNESS - 1, Math.round(thicknessPx) - 1));
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

/** The per-column start-delay noise, [0,1): two octaves of value noise. */
export function meltDelayNoise(x01: number, k: number): number {
  return EDGEFADER_MELT_OCTAVES[0] * valueNoise(x01 * EDGEFADER_MELT_NOISE_COARSE, EDGEFADER_SEEDS.delayCoarse + k)
    + EDGEFADER_MELT_OCTAVES[1] * valueNoise(x01 * EDGEFADER_MELT_NOISE_FINE, EDGEFADER_SEEDS.delayFine + k);
}

/** A column's progress through its own slide: 0 until its delay has passed,
 *  1 by the time the band window closes. `edgeDensity` (0..1, the coarse
 *  density of edges in this column of the band) pulls the start EARLIER, so
 *  edged columns melt first — the ripple-down-the-edges rule in melt mode. */
export function meltColumnProgress(x01: number, k: number, pBand: number, edgeDensity: number): number {
  const delay = EDGEFADER_MELT_DELAY_MAX * meltDelayNoise(x01, k) * (1 - EDGEFADER_MELT_EDGE_BIAS * clamp01(edgeDensity));
  return clamp01((clamp01(pBand) - delay) / (1 - EDGEFADER_MELT_DELAY_MAX));
}

/** Ease-in: a drip accelerates as it falls (the classic melt's columns gain
 *  speed every tick), zero initial slope, unit final slope. */
export function meltEase(p: number): number {
  const u = clamp01(p);
  return u * u * (2 - u);
}

/** How far (uv, downward) band k's content has slid at x for a column
 *  progress p. */
export function meltSlide(x01: number, k: number, p: number): number {
  const lenFrac = EDGEFADER_DRIP_MIN_FRAC
    + (1 - EDGEFADER_DRIP_MIN_FRAC) * valueNoise(x01 * EDGEFADER_MELT_LEN_LANES, EDGEFADER_SEEDS.len + k);
  return EDGEFADER_DRIP_MAX_UV * lenFrac * meltEase(p);
}

/** Horizontal liquid wobble of the sliding content (uv): amplitude grows with
 *  the column's progress (zero at rest) and its phase advances with the band's
 *  progress, never with a clock (gl-transitions Dreamy). */
export function meltWobble(x01: number, rowFromTop: number, k: number, p: number, pBand: number): number {
  const phase = meltHash(Math.floor(x01 * EDGEFADER_MELT_NOISE_FINE + EDGEFADER_LANE_BIAS), EDGEFADER_SEEDS.wobble + k) * EDGEFADER_TAU;
  return EDGEFADER_WOBBLE_UV * clamp01(p)
    * Math.sin(EDGEFADER_TAU * (EDGEFADER_WOBBLE_FREQ * rowFromTop) + phase + EDGEFADER_WOBBLE_RATE * clamp01(pBand));
}

/** The x of the pixel's droplet lane centre. */
export function dropLaneCentre(x01: number): number {
  return (Math.floor(x01 * EDGEFADER_DROP_LANES + EDGEFADER_LANE_BIAS) + 0.5) / EDGEFADER_DROP_LANES;
}

/** One droplet lane of band k: whether it carries a drop and its geometry. */
export interface DropLane {
  has: boolean;
  /** Drop centre x (uv). */
  cx: number;
  /** Head radius (uv, aspect-corrected units). */
  r: number;
  /** Tongue length below the slid content (uv). 0 at the band window's ends. */
  len: number;
}

/** `pLane` is the column progress read at the lane's centre, so the whole
 *  drop moves as one body. */
export function dropLane(x01: number, k: number, pLane: number): DropLane {
  const lane = Math.floor(x01 * EDGEFADER_DROP_LANES + EDGEFADER_LANE_BIAS);
  const c = (lane + 0.5) / EDGEFADER_DROP_LANES;
  const has = meltHash(lane, EDGEFADER_SEEDS.dropHas + k) < EDGEFADER_DROP_PROB;
  const cx = c + (meltHash(lane, EDGEFADER_SEEDS.dropX + k) - 0.5) * EDGEFADER_DROP_JITTER / EDGEFADER_DROP_LANES;
  const r = EDGEFADER_DROP_R_MIN + (EDGEFADER_DROP_R_MAX - EDGEFADER_DROP_R_MIN) * meltHash(lane, EDGEFADER_SEEDS.dropR + k);
  // A polynomial bump, not sin(πp): it is EXACTLY 0 at both ends in float32
  // and in double, so the no-drop sentinel below agrees on both sides.
  const pl = clamp01(pLane);
  const len = EDGEFADER_DROP_LEN_MAX * 4 * pl * (1 - pl) * (0.5 + 0.5 * meltHash(lane, EDGEFADER_SEEDS.dropLen + k));
  return { has, cx, r, len };
}

/**
 * Signed distance (uv, aspect-corrected) from the pixel to band k's droplet
 * in the pixel's lane, where `top` is the depth (rowFromTop) of the slid
 * content's bottom edge at the drop's own x. Negative = inside the drop;
 * +Infinity when the lane carries none.
 */
export function dropDistance(x01: number, rowFromTop: number, aspect: number, lane: DropLane, top: number): number {
  if (!lane.has || lane.len <= 1e-6) return Infinity;
  const qx = (x01 - lane.cx) * aspect;
  const qy = rowFromTop;
  const yc = top + lane.len - lane.r;
  const stalk = sdSegment(qx, qy, 0, top - lane.r, 0, yc) - EDGEFADER_DROP_STALK * lane.r;
  const head = Math.hypot(qx, qy - yc) - lane.r;
  return Math.min(stalk, head);
}

// ─────────────────────────── the mirror atlas ───────────────────────────────

export interface EdgefaderParams {
  threshold: number;
  thickness: number;
  melt: boolean;
}

export interface MirrorOptions {
  /** Ray taps in px (the engine uses EDGEFADER_RAY_TAPS_PX; a small test grid
   *  passes smaller taps). */
  rayTapsPx?: readonly number[];
  /** Peak blur radius in px (default EDGEFADER_BLUR_MAX_PX). */
  blurMaxPx?: number;
  /** Bands (default EDGEFADER_BANDS). */
  bands?: number;
}

/** The mirror's atlas: per-texel dilated masks, their coincidence, and the
 *  coarse densities, on the grid's own resolution (= the engine's full-res
 *  atlas: R = edgeA, G = edgeB, B = coinc; the mip chain = the densities). */
export interface EdgeAtlas {
  w: number;
  h: number;
  edgeA: Float32Array;
  edgeB: Float32Array;
  /** min(edgeA, edgeB) — where the two dilated masks overlap. */
  coinc: Float32Array;
  /** Coarse density (EDGEFADER_COARSE_PX cell) of edgeA / edgeB / coinc. */
  densA: Float32Array;
  densB: Float32Array;
  densC: Float32Array;
  /** Density of max(edgeA, edgeB) over the EDGEFADER_BLUR_PROX_PX cell. */
  prox: Float32Array;
}

/** Edge-clamped read of a row-major grid at an integer texel. */
export function texelAt(w: number, h: number, g: ArrayLike<number>, x: number, y: number): number {
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  return g[cy * w + cx]!;
}

/** Edge-clamped bilinear read of a row-major grid at a fractional texel. */
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

/** True box mean of a grid over the (2r+1)² window centred on (x, y), with
 *  edge clamping. r = 0 → the texel itself. */
export function boxMean(w: number, h: number, grid: ArrayLike<number>, x: number, y: number, r: number): number {
  const ri = Math.max(0, Math.round(r));
  let acc = 0;
  let n = 0;
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      acc += texelAt(w, h, grid, x + dx, y + dy);
      n++;
    }
  }
  return acc / n;
}

/**
 * Build the mirror's atlas for a synthetic A/B pair: `edgesPixel` (the
 * verified EDGES mirror) on both luma grids with the module's thickness →
 * dilate law, then the coarse densities (box means over the coarse cell).
 * `hasA`/`hasB` false = that input is unpatched: no edges at all (the
 * engine's uHasA/uHasB gate).
 */
export function buildEdgeAtlas(
  w: number,
  h: number,
  lumaA: ArrayLike<number>,
  lumaB: ArrayLike<number>,
  threshold: number,
  thicknessPx: number,
  opts: { coarsePx?: number; proxPx?: number; hasA?: boolean; hasB?: boolean } = {},
): EdgeAtlas {
  const n = w * h;
  const edgeA = new Float32Array(n);
  const edgeB = new Float32Array(n);
  const coinc = new Float32Array(n);
  const edgeAny = new Float32Array(n);
  const hasA = opts.hasA ?? true;
  const hasB = opts.hasB ?? true;
  // edgesPixel's dilation reads round(thickness) − 1 — the same `dilateRadius`
  // the GPU dilate passes are driven by, so the two agree by construction.
  const thick = dilateRadius(thicknessPx) + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      edgeA[i] = hasA ? edgesPixel(w, h, lumaA, x, y, threshold, thick) : 0;
      edgeB[i] = hasB ? edgesPixel(w, h, lumaB, x, y, threshold, thick) : 0;
      coinc[i] = Math.min(edgeA[i]!, edgeB[i]!);
      edgeAny[i] = Math.max(edgeA[i]!, edgeB[i]!);
    }
  }
  const densA = new Float32Array(n);
  const densB = new Float32Array(n);
  const densC = new Float32Array(n);
  const prox = new Float32Array(n);
  const half = Math.max(0, Math.round((opts.coarsePx ?? EDGEFADER_COARSE_PX) / 2));
  const proxHalf = Math.max(0, Math.round((opts.proxPx ?? EDGEFADER_BLUR_PROX_PX) / 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      densA[i] = boxMean(w, h, edgeA, x, y, half);
      densB[i] = boxMean(w, h, edgeB, x, y, half);
      densC[i] = boxMean(w, h, coinc, x, y, half);
      prox[i] = boxMean(w, h, edgeAny, x, y, proxHalf);
    }
  }
  return { w, h, edgeA, edgeB, coinc, densA, densB, densC, prox };
}

/** The per-pixel EdgeField read off a mirror atlas. */
export function edgeFieldAt(
  atlas: EdgeAtlas,
  x: number,
  y: number,
  rayTapsPx: readonly number[] = EDGEFADER_RAY_TAPS_PX,
): EdgeField {
  const { w, h } = atlas;
  const eA = texelAt(w, h, atlas.edgeA, x, y);
  const eB = texelAt(w, h, atlas.edgeB, x, y);
  // The ray reads the OUTGOING frame's edges only (A's): "inside an edge" is
  // about the content being faded, and B's edges would otherwise own the term
  // wherever B is busy. Bilinear, like the GPU's atlas read.
  const edgeAAt = (px: number, py: number): number => sampleGrid(w, h, atlas.edgeA, px, py);
  const { inside, nearEdge } = insideScore(edgeAAt, x, y, (w - 1) / 2, (h - 1) / 2, rayTapsPx);
  return {
    wEdge: Math.max(eA, eB),
    wCoinc: texelAt(w, h, atlas.coinc, x, y),
    wSim: similarity(texelAt(w, h, atlas.densA, x, y), texelAt(w, h, atlas.densB, x, y), texelAt(w, h, atlas.densC, x, y)),
    wProx: texelAt(w, h, atlas.prox, x, y),
    inside,
    nearEdge,
  };
}

/** Everything the composite decides for one pixel before it samples a frame —
 *  exposed so the tests can read the law directly. */
export interface PixelLaw {
  band: number;
  pRow: number;
  leadN: number;
  pLocal: number;
  blend: number;
  blurPx: number;
}

export function pixelLaw(
  t: number,
  rowFromTop: number,
  field: EdgeField,
  n: number = EDGEFADER_BANDS,
  blurMaxPx: number = EDGEFADER_BLUR_MAX_PX,
): PixelLaw {
  const band = bandOf(rowFromTop, n);
  const pRow = rowProgress(t, rowFromTop, n);
  const leadN = leadFor(field);
  const pLocal = localProgress(pRow, leadN);
  return {
    band,
    pRow,
    leadN,
    pLocal,
    blend: blendWeight(pLocal),
    blurPx: blurRadiusPx(pLocal, blurWeight(field.wProx, field.wSim)) * (blurMaxPx / EDGEFADER_BLUR_MAX_PX),
  };
}

/** The coarse edge density of band k's column at x (what biases a column's
 *  melt start) — the atlas density read at the band's centre row. */
export function meltColumnDensity(atlas: EdgeAtlas, x01: number, k: number, n: number = EDGEFADER_BANDS): number {
  const x = Math.min(atlas.w - 1, Math.max(0, Math.round(x01 * atlas.w - 0.5)));
  const y = Math.min(atlas.h - 1, Math.max(0, Math.round(((k + 0.5) / n) * atlas.h - 0.5)));
  const i = y * atlas.w + x;
  return Math.max(atlas.densA[i]!, atlas.densB[i]!);
}

/** One melt layer — band k's slid content as seen from a pixel at (x01,
 *  rowFromTop): where the outgoing frame is read from, and how much of the
 *  pixel it covers. */
export interface MeltLayer {
  /** Column progress through its slide. */
  p: number;
  /** How far (uv, downward) band k's content has slid at this x. */
  slide: number;
  /** 1 = the pixel is covered by the slid content (or its droplet), 0 = not;
   *  soft across the fronts. */
  cover: number;
  /** Row (from top, uv) the outgoing frame is sampled from — always ≤ the
   *  pixel's own row (content only slides DOWN) and always inside band k. */
  srcRowFromTop: number;
  /** Horizontal liquid wobble of the sample (uv). */
  xShift: number;
}

export function meltLayer(
  atlas: EdgeAtlas,
  x01: number,
  rowFromTop: number,
  k: number,
  pBand: number,
  aspect: number,
  n: number = EDGEFADER_BANDS,
): MeltLayer {
  const p = meltColumnProgress(x01, k, pBand, meltColumnDensity(atlas, x01, k, n));
  const slide = meltSlide(x01, k, p);
  const bandTop = k / n;
  const bandBottom = (k + 1) / n;
  const dy = rowFromTop - bandTop;
  // Below the vacated top of the band and above the slid bottom edge: the
  // content itself.
  const soft = Math.min(EDGEFADER_FRONT_SOFT_UV, slide * 0.5);
  const inContent = softStep(slide - soft, slide + soft, dy)
    * (1 - softStep(bandBottom + slide - soft, bandBottom + slide + soft, rowFromTop));
  // The droplet tongue hanging from the slid bottom edge, evaluated at the
  // drop's own x so the whole drop moves as one body.
  const lcx = dropLaneCentre(x01);
  const pLane = meltColumnProgress(lcx, k, pBand, meltColumnDensity(atlas, lcx, k, n));
  const lane = dropLane(x01, k, pLane);
  const top = bandBottom + meltSlide(lane.cx, k, meltColumnProgress(lane.cx, k, pBand, meltColumnDensity(atlas, lane.cx, k, n)));
  const sd = dropDistance(x01, rowFromTop, aspect, lane, top);
  const inDrop = sd === Infinity ? 0 : 1 - softStep(-EDGEFADER_FRONT_SOFT_UV * 0.5, EDGEFADER_FRONT_SOFT_UV * 0.5, sd);
  const cover = Math.max(inContent, inDrop);
  // The content is read from where it came from; a drop below the slid edge
  // reads the band's bottom rows, pulled down the tongue (a lens).
  const srcContent = rowFromTop - slide;
  const srcDrop = bandBottom - 0.5 * lane.r - Math.max(0, rowFromTop - top) * 0.5;
  const src = inDrop > inContent ? srcDrop : srcContent;
  const srcRowFromTop = Math.min(bandBottom, Math.max(bandTop, src));
  return { p, slide, cover, srcRowFromTop, xShift: meltWobble(x01, rowFromTop, k, p, pBand) };
}

/**
 * The full composite for ONE output pixel of a synthetic A/B pair: the CPU
 * mirror of the COMPOSITE pass. `x`, `y` index the grid (y = 0 is the TOP
 * row, matching `rowFromTop`). Returns the output luma.
 */
export function edgefaderPixel(
  atlas: EdgeAtlas,
  lumaA: ArrayLike<number>,
  lumaB: ArrayLike<number>,
  x: number,
  y: number,
  t: number,
  params: EdgefaderParams,
  opts: MirrorOptions = {},
): number {
  const { w, h } = atlas;
  const n = opts.bands ?? EDGEFADER_BANDS;
  const rowFromTop = (y + 0.5) / h;
  const x01 = (x + 0.5) / w;
  const field = edgeFieldAt(atlas, x, y, opts.rayTapsPx);
  const law = pixelLaw(t, rowFromTop, field, n, opts.blurMaxPx);

  if (!params.melt) {
    // A (2r+1)-wide box is about twice the GPU's ~r-px mip cell: use r/2.
    const a = boxMean(w, h, lumaA, x, y, law.blurPx / 2);
    const b = boxMean(w, h, lumaB, x, y, law.blurPx / 2);
    return a + (b - a) * law.blend;
  }

  // MELT — the band's own slide, then any drip arriving from the band above.
  // Slid content is blended by the law of its SOURCE row and the field at its
  // SOURCE position, so one content row carries one blend wherever it has
  // slid to (no seam at the band line, no ghost of A's mask at its old place).
  const aspect = w / h;
  const k = law.band;
  const bAt = texelAt(w, h, lumaB, x, y);
  const pBand = bandProgress(t, k, n);
  const own = meltLayer(atlas, x01, rowFromTop, k, pBand, aspect, n);
  const aOwn = sampleGrid(w, h, lumaA, (x01 + own.xShift) * w - 0.5, own.srcRowFromTop * h - 0.5);
  const slid = aOwn + (bAt - aOwn) * meltBlend(atlas, t, x01 + own.xShift, own.srcRowFromTop, n, opts.rayTapsPx);
  let out = bAt + (slid - bAt) * own.cover;           // uncovered → B (vacated)

  if (k > 0) {
    const pAbove = bandProgress(t, k - 1, n);
    const above = meltLayer(atlas, x01, rowFromTop, k - 1, pAbove, aspect, n);
    if (above.cover > 0) {
      const aDrip = sampleGrid(w, h, lumaA, (x01 + above.xShift) * w - 0.5, above.srcRowFromTop * h - 0.5);
      const dripped = aDrip + (bAt - aDrip) * meltBlend(atlas, t, x01 + above.xShift, above.srcRowFromTop, n, opts.rayTapsPx);
      out = out + (dripped - out) * above.cover;
    }
  }
  return out;
}

/** The A→B blend of a slid sample: the row law and the lead of the SOURCE
 *  position (x01, rowFromTop in uv), never the destination's. */
export function meltBlend(
  atlas: EdgeAtlas,
  t: number,
  srcX01: number,
  srcRowFromTop: number,
  n: number = EDGEFADER_BANDS,
  rayTapsPx: readonly number[] = EDGEFADER_RAY_TAPS_PX,
): number {
  const { w, h } = atlas;
  const sx = Math.min(w - 1, Math.max(0, Math.round(srcX01 * w - 0.5)));
  const sy = Math.min(h - 1, Math.max(0, Math.round(srcRowFromTop * h - 0.5)));
  const field = edgeFieldAt(atlas, sx, sy, rayTapsPx);
  return blendWeight(localProgress(rowProgress(t, srcRowFromTop, n), leadFor(field)));
}
