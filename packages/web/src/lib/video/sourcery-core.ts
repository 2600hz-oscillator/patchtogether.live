// packages/web/src/lib/video/sourcery-core.ts
//
// SOURCERY — pure-TS "region shape-match recolor" CORE. NO WebGL here: this is
// the deterministic correctness gate the unit suite pins bit-for-bit (the house
// pattern shared by colourofmagic-colorspace.ts / shapegen-math.ts /
// mappy-homography.ts). The GLSL FILL shader in modules/sourcery.ts is a 1:1
// mirror of relToUvB + the hue-skew here (constants copied, never re-derived),
// so the software-renderer GPU is NOT the source of truth — this core is.
//
// PIPELINE (per processed frame, at the coarse PROC_W×PROC_H grid):
//   1. labelRegions   — 2-pass union-find CCL over the NON-edge pixels of an
//                        edge map (dilated edges are walls; each connected
//                        non-wall blob is one region).
//   2. accumulateRegions — one O(pixels) pass: 10 raw moments + bbox + perimeter
//                        per raw label (NO per-region pixel lists — the
//                        CV-modulation GC lesson; we re-scan the label image).
//   3. selectRegions  — min-area cull + area-rank hard cap → the kept set.
//   4. absorbLabels    — 4-neighbour BFS propagation so EVERY pixel carries a
//                        surviving region label (spec item 5: all A area maps).
//   5. describeRegion  — central→normalized-central moments → 7 Hu invariants
//                        (log-compressed, |h7| so mirrors match) + eccentricity
//                        + circularity + extent + principal angle θ (canonical
//                        sign) + PCA eigenvalues + logArea.
//   6. matchRegions    — per-frame z-score each shape dimension, then for each A
//                        region linear-scan argmin over B regions on
//                        d = wShape·L2(shape) + wSize·|Δ z(logArea)|, with per-A
//                        hysteresis (keep last frame's B unless a challenger
//                        wins by a margin). Reuse OK; every A region takes some B.
//   7. buildAffine / relToUvB — the relative-position color transfer: an A pixel
//                        → its A-local oriented frame → intra-region ROTATE →
//                        the matched B region's oriented frame → uvB in [0,1]
//                        (corner colors land in corners — the unit-pinned bit).
//
// Everything is plain typed arrays with ZERO per-frame allocation in the hot
// module path (the module preallocates + reuses; this core allocates only the
// small per-region descriptor arrays, which are capped at MAX_REGIONS).

import { rgb2hsv, hsv2rgb, adjHue, type Vec3 } from './colourofmagic-colorspace';

// ─────────────────────────── module-level constants ───────────────────────────
//
// NOT CV-modulatable (a CV can't blow up the O(pixels) CCL / O(N_A·N_B) match).

/** Segmentation / readback grid width (coarse; nearest-upscaled in the fill). */
export const SOURCERY_PROC_W = 128;
/** Segmentation / readback grid height (4:3 with PROC_W). */
export const SOURCERY_PROC_H = 96;
/** Hard region cap per side — keeps the match + LUT width bounded. */
export const SOURCERY_MAX_REGIONS = 128;
/** Min region area (px). Smaller blobs are culled (speckle) then absorbed. */
export const SOURCERY_MIN_AREA = 10;
/** Amortization period: recompute the shape tables every K frames. */
export const SOURCERY_AMORTIZE_K = 3;

/** Local-frame extent scale: half-extent = K·sqrt(λ). √3 makes a UNIFORM
 *  rectangle's corner land exactly on the unit-box corner (variance of a
 *  uniform on [-s,s] is s²/3 → sqrt(λ)=s/√3 → √3·sqrt(λ)=s), so identity
 *  A→B maps corner-to-corner with no clamp. Shared by the GLSL fill. */
export const SOURCERY_EXTENT_K = Math.sqrt(3);

const EPS = 1e-9;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ─────────────────────────── Stage 1: CCL ───────────────────────────

export interface LabelResult {
  /** Row-major (row 0 = grid bottom, matching a GL readPixels of the edge FBO).
   *  −1 = wall/edge pixel; 0..count−1 = a region id. */
  labels: Int32Array;
  count: number;
}

/**
 * Two-pass union-find connected-component labeling over the NON-edge pixels of
 * `edge` (row-major, length w·h; truthy = edge/wall). 4-connectivity. Region
 * ids are compacted 0..count−1 in row-major first-touch order (deterministic).
 * Walls get −1.
 */
export function labelRegions(edge: ArrayLike<number>, w: number, h: number): LabelResult {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const prov = new Int32Array(n).fill(-1);
  // Union-find over provisional labels. union-by-MIN-index keeps roots
  // deterministic (lowest provisional label wins → stable compaction).
  const parent: number[] = [];
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    // path-compress
    while (parent[x] !== r) {
      const nx = parent[x]!;
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  let next = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (edge[i]) continue; // wall
      const leftI = x > 0 ? i - 1 : -1;
      const upI = y > 0 ? i - w : -1;
      const leftOk = leftI >= 0 && !edge[leftI];
      const upOk = upI >= 0 && !edge[upI];
      if (leftOk && upOk) {
        const a = prov[leftI]!, b = prov[upI]!;
        prov[i] = a < b ? a : b;
        union(a, b);
      } else if (leftOk) {
        prov[i] = prov[leftI]!;
      } else if (upOk) {
        prov[i] = prov[upI]!;
      } else {
        prov[i] = next;
        parent[next] = next;
        next++;
      }
    }
  }

  // Resolve + compact roots to 0..count−1 in first-touch order.
  const remap = new Map<number, number>();
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (prov[i] < 0) continue;
    const root = find(prov[i]!);
    let c = remap.get(root);
    if (c === undefined) {
      c = count++;
      remap.set(root, c);
    }
    labels[i] = c;
  }
  return { labels, count };
}

// ─────────────────────────── Stage 2: moment accumulation ───────────────────────────

export interface RegionAccum {
  /** raw label id (index into the accum array). */
  label: number;
  m00: number; m10: number; m01: number;
  m20: number; m11: number; m02: number;
  m30: number; m21: number; m12: number; m03: number;
  minX: number; minY: number; maxX: number; maxY: number;
  perimeter: number;
}

function emptyAccum(label: number): RegionAccum {
  return {
    label,
    m00: 0, m10: 0, m01: 0,
    m20: 0, m11: 0, m02: 0,
    m30: 0, m21: 0, m12: 0, m03: 0,
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    perimeter: 0,
  };
}

/**
 * One O(pixels) pass over `labels` (0..count−1, −1 = wall): raw moments (up to
 * 3rd order) + axis-aligned bbox + 4-neighbour perimeter per label. Returns one
 * RegionAccum per raw label, indexed by label id.
 */
export function accumulateRegions(
  labels: Int32Array,
  w: number,
  h: number,
  count: number,
): RegionAccum[] {
  const accums: RegionAccum[] = [];
  for (let i = 0; i < count; i++) accums.push(emptyAccum(i));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lab = labels[y * w + x]!;
      if (lab < 0) continue;
      const a = accums[lab]!;
      const x2 = x * x, y2 = y * y;
      a.m00 += 1;
      a.m10 += x; a.m01 += y;
      a.m20 += x2; a.m11 += x * y; a.m02 += y2;
      a.m30 += x2 * x; a.m21 += x2 * y; a.m12 += x * y2; a.m03 += y2 * y;
      if (x < a.minX) a.minX = x;
      if (y < a.minY) a.minY = y;
      if (x > a.maxX) a.maxX = x;
      if (y > a.maxY) a.maxY = y;
      // perimeter: a boundary pixel touches a different label or the grid edge
      // on at least one 4-neighbour.
      const up = y > 0 ? labels[(y - 1) * w + x]! : -1;
      const dn = y < h - 1 ? labels[(y + 1) * w + x]! : -1;
      const lf = x > 0 ? labels[y * w + (x - 1)]! : -1;
      const rt = x < w - 1 ? labels[y * w + (x + 1)]! : -1;
      if (up !== lab || dn !== lab || lf !== lab || rt !== lab) a.perimeter += 1;
    }
  }
  return accums;
}

// ─────────────────────────── Stage 3: cull + cap + absorb ───────────────────────────

export interface SelectResult {
  /** raw labels kept, sorted by DESCENDING area (deterministic tie-break: lower
   *  raw label first). Length ≤ maxRegions. */
  kept: number[];
  /** raw label → final index (0..kept.length−1), or −1 if culled. */
  rawToFinal: Int32Array;
  finalCount: number;
}

/** Min-area cull + area-rank hard cap. */
export function selectRegions(
  accums: RegionAccum[],
  opts: { minArea?: number; maxRegions?: number } = {},
): SelectResult {
  const minArea = opts.minArea ?? SOURCERY_MIN_AREA;
  const maxRegions = opts.maxRegions ?? SOURCERY_MAX_REGIONS;
  const survivors = accums.filter((a) => a.m00 >= minArea);
  survivors.sort((p, q) => (q.m00 - p.m00) || (p.label - q.label));
  const kept = survivors.slice(0, maxRegions).map((a) => a.label);
  const rawToFinal = new Int32Array(accums.length).fill(-1);
  kept.forEach((raw, idx) => { rawToFinal[raw] = idx; });
  return { kept, rawToFinal, finalCount: kept.length };
}

/**
 * Multi-source 4-neighbour BFS: every pixel (walls + culled-region pixels) is
 * assigned the FINAL index of the nearest surviving region, so the returned
 * `finalLabels` has NO holes (spec item 5 — all A area maps). Seeds are the kept
 * regions' own pixels. Deterministic: ties resolve to the lower final index
 * (seeded in kept order) since BFS is a single expanding front.
 */
export function absorbLabels(
  labels: Int32Array,
  w: number,
  h: number,
  rawToFinal: Int32Array,
  finalCount: number,
): Int32Array {
  const n = w * h;
  const finalLabels = new Int32Array(n).fill(-1);
  // A ring-buffer queue over pixel indices (preallocated, no per-pop shift()).
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    const raw = labels[i]!;
    const fin = raw >= 0 ? rawToFinal[raw]! : -1;
    if (fin >= 0) {
      finalLabels[i] = fin;
      queue[tail++] = i;
    }
  }
  // Degenerate: no surviving region → everything 0 (a single giant fill).
  if (tail === 0) {
    if (finalCount > 0) finalLabels.fill(0);
    else finalLabels.fill(0);
    return finalLabels;
  }
  while (head < tail) {
    const i = queue[head++]!;
    const fin = finalLabels[i]!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) { const j = i - 1; if (finalLabels[j] < 0) { finalLabels[j] = fin; queue[tail++] = j; } }
    if (x < w - 1) { const j = i + 1; if (finalLabels[j] < 0) { finalLabels[j] = fin; queue[tail++] = j; } }
    if (y > 0) { const j = i - w; if (finalLabels[j] < 0) { finalLabels[j] = fin; queue[tail++] = j; } }
    if (y < h - 1) { const j = i + w; if (finalLabels[j] < 0) { finalLabels[j] = fin; queue[tail++] = j; } }
  }
  return finalLabels;
}

// ─────────────────────────── Stage 4: descriptors ───────────────────────────

export interface ShapeDescriptor {
  /** 7 Hu invariants, |h7|, log-compressed (h' = −sign(h)·log10(|h|)). */
  hu: Float32Array;
  ecc: number;
  circularity: number;
  extent: number;
  logArea: number;
  // ── fill metadata (NOT in the match distance) ──
  cx: number; cy: number;
  theta: number;
  /** PCA eigenvalues of the 2nd-order central moments (λmax, λmin). */
  lambda1: number; lambda2: number;
  area: number;
}

const logComp = (v: number): number => {
  const a = Math.abs(v);
  if (a < 1e-30) return 0;
  return -Math.sign(v) * Math.log10(a);
};

/**
 * Central → normalized-central moments → 7 Hu invariants + eccentricity +
 * circularity + extent + principal angle θ (canonical sign via the 3rd-order
 * skew, so orientation never flips frame-to-frame) + PCA eigenvalues + logArea.
 */
export function describeRegion(a: RegionAccum): ShapeDescriptor {
  const m00 = Math.max(a.m00, EPS);
  const cx = a.m10 / m00;
  const cy = a.m01 / m00;

  // central moments
  const mu20 = a.m20 - cx * a.m10;
  const mu02 = a.m02 - cy * a.m01;
  const mu11 = a.m11 - cx * a.m01;
  const mu30 = a.m30 - 3 * cx * a.m20 + 2 * cx * cx * a.m10;
  const mu03 = a.m03 - 3 * cy * a.m02 + 2 * cy * cy * a.m01;
  const mu21 = a.m21 - 2 * cx * a.m11 - cy * a.m20 + 2 * cx * cx * a.m01;
  const mu12 = a.m12 - 2 * cy * a.m11 - cx * a.m02 + 2 * cy * cy * a.m10;

  // PCA of the 2nd-order central moments (per-area).
  const A = mu20 / m00;
  const B = mu11 / m00;
  const C = mu02 / m00;
  const common = (A + C) / 2;
  const diff = Math.sqrt(Math.max(0, ((A - C) / 2) ** 2 + B * B));
  const lambda1 = common + diff; // λmax
  const lambda2 = Math.max(0, common - diff); // λmin
  let theta = 0.5 * Math.atan2(2 * B, A - C);
  // Canonical sign: force the 3rd-order skew along the principal axis positive
  // so a shape's frame doesn't flip 180° between frames.
  const ct = Math.cos(theta), st = Math.sin(theta);
  const skew = mu30 * ct * ct * ct
    + 3 * mu21 * ct * ct * st
    + 3 * mu12 * ct * st * st
    + mu03 * st * st * st;
  if (skew < 0) theta += Math.PI;

  // normalized central moments η_pq = μ_pq / m00^(1+(p+q)/2)
  const n2 = m00 * m00; // m00^2 for (p+q)=2
  const n3 = Math.pow(m00, 2.5); // m00^2.5 for (p+q)=3
  const e20 = mu20 / n2, e02 = mu02 / n2, e11 = mu11 / n2;
  const e30 = mu30 / n3, e03 = mu03 / n3, e21 = mu21 / n3, e12 = mu12 / n3;

  const a1 = e30 + e12;
  const a2 = e21 + e03;
  const s1 = e30 - 3 * e12;
  const s2 = 3 * e21 - e03;

  const I1 = e20 + e02;
  const I2 = (e20 - e02) ** 2 + 4 * e11 * e11;
  const I3 = s1 * s1 + s2 * s2;
  const I4 = a1 * a1 + a2 * a2;
  const I5 = s1 * a1 * (a1 * a1 - 3 * a2 * a2) + s2 * a2 * (3 * a1 * a1 - a2 * a2);
  const I6 = (e20 - e02) * (a1 * a1 - a2 * a2) + 4 * e11 * a1 * a2;
  const I7 = s2 * a1 * (a1 * a1 - 3 * a2 * a2) - s1 * a2 * (3 * a1 * a1 - a2 * a2);

  const hu = new Float32Array(7);
  hu[0] = logComp(I1);
  hu[1] = logComp(I2);
  hu[2] = logComp(I3);
  hu[3] = logComp(I4);
  hu[4] = logComp(I5);
  hu[5] = logComp(I6);
  hu[6] = logComp(Math.abs(I7)); // |h7|: mirror images count as the same shape

  const ecc = lambda1 > EPS ? Math.sqrt(Math.max(0, 1 - lambda2 / lambda1)) : 0;
  const perim = Math.max(a.perimeter, EPS);
  const circularity = clamp((4 * Math.PI * m00) / (perim * perim), 0, 1);
  const bboxW = Math.max(1, a.maxX - a.minX + 1);
  const bboxH = Math.max(1, a.maxY - a.minY + 1);
  const extent = clamp(m00 / (bboxW * bboxH), 0, 1);

  return {
    hu, ecc, circularity, extent,
    logArea: Math.log(m00),
    cx, cy, theta, lambda1, lambda2, area: m00,
  };
}

/** Convenience: labels → accums → select → per-kept-region descriptors, in
 *  DESCENDING-area (final-index) order. Returns the descriptors + the
 *  finalLabels (all pixels labeled) + the select result. */
export function segmentAndDescribe(
  edge: ArrayLike<number>,
  w: number,
  h: number,
  opts: { minArea?: number; maxRegions?: number } = {},
): { descriptors: ShapeDescriptor[]; finalLabels: Int32Array; select: SelectResult } {
  const { labels, count } = labelRegions(edge, w, h);
  const accums = accumulateRegions(labels, w, h, count);
  const select = selectRegions(accums, opts);
  const descriptors = select.kept.map((raw) => describeRegion(accums[raw]!));
  const finalLabels = absorbLabels(labels, w, h, select.rawToFinal, select.finalCount);
  return { descriptors, finalLabels, select };
}

// ─────────────────────────── Stage 5: shape-first / size-second match ───────────────────────────

/** The shape feature vector (rotation/scale/reflection invariant): 7 Hu +
 *  ecc + circularity + extent. NOT logArea (that is the size tie-break). */
export function shapeFeatureVector(d: ShapeDescriptor): number[] {
  return [d.hu[0]!, d.hu[1]!, d.hu[2]!, d.hu[3]!, d.hu[4]!, d.hu[5]!, d.hu[6]!, d.ecc, d.circularity, d.extent];
}

const SHAPE_DIMS = 10;

/** Raw (un-z-scored) shape L2 distance — square vs rotated-square ≈ 0, square
 *  vs circle large. Exposed for the unit gate. */
export function shapeDistance(a: ShapeDescriptor, b: ShapeDescriptor): number {
  const va = shapeFeatureVector(a), vb = shapeFeatureVector(b);
  let s = 0;
  for (let i = 0; i < SHAPE_DIMS; i++) { const d = va[i]! - vb[i]!; s += d * d; }
  return Math.sqrt(s);
}

export interface MatchOptions {
  wShape?: number;
  wSize?: number;
  /** Previous-frame A→B assignment (same A ordering) for hysteresis. */
  prevMatch?: Int32Array | null;
  /** A challenger must beat the incumbent by more than this z-distance margin
   *  to steal an A region's match (temporal-flicker mitigation). */
  hysteresisMargin?: number;
}

export interface MatchResult {
  /** A→B index (length = descsA.length); −1 only when there are NO B regions. */
  match: Int32Array;
}

/**
 * Per-frame z-score each shape dimension + logArea across the POOLED A∪B
 * descriptors (auto-balances units, zero hand-tuned scale constants), then for
 * each A region linear-scan argmin over B on
 *   d = wShape·L2(zShape) + wSize·|Δ z(logArea)|.
 * Hysteresis keeps the previous B unless a challenger wins by `hysteresisMargin`.
 */
export function matchRegions(
  descsA: ShapeDescriptor[],
  descsB: ShapeDescriptor[],
  opts: MatchOptions = {},
): MatchResult {
  const wShape = opts.wShape ?? 0.9;
  const wSize = opts.wSize ?? 0.1;
  const margin = opts.hysteresisMargin ?? 0.15;
  const nA = descsA.length, nB = descsB.length;
  const match = new Int32Array(nA).fill(-1);
  if (nB === 0) return { match };

  // Pool means/stds per dimension (shape dims + size).
  const pool = [...descsA, ...descsB];
  const shapeVecs = pool.map(shapeFeatureVector);
  const mean = new Float64Array(SHAPE_DIMS);
  const std = new Float64Array(SHAPE_DIMS);
  for (const v of shapeVecs) for (let i = 0; i < SHAPE_DIMS; i++) mean[i]! += v[i]!;
  for (let i = 0; i < SHAPE_DIMS; i++) mean[i]! /= pool.length;
  for (const v of shapeVecs) for (let i = 0; i < SHAPE_DIMS; i++) { const d = v[i]! - mean[i]!; std[i]! += d * d; }
  for (let i = 0; i < SHAPE_DIMS; i++) std[i]! = Math.sqrt(std[i]! / pool.length) || 1;

  let sizeMean = 0, sizeStd = 0;
  for (const d of pool) sizeMean += d.logArea;
  sizeMean /= pool.length;
  for (const d of pool) sizeStd += (d.logArea - sizeMean) ** 2;
  sizeStd = Math.sqrt(sizeStd / pool.length) || 1;

  const zShape = (d: ShapeDescriptor): number[] => {
    const v = shapeFeatureVector(d);
    const out = new Array<number>(SHAPE_DIMS);
    for (let i = 0; i < SHAPE_DIMS; i++) out[i] = (v[i]! - mean[i]!) / std[i]!;
    return out;
  };
  const zSize = (d: ShapeDescriptor): number => (d.logArea - sizeMean) / sizeStd;

  const zA = descsA.map(zShape);
  const zB = descsB.map(zShape);
  const szA = descsA.map(zSize);
  const szB = descsB.map(zSize);

  const dist = (ai: number, bi: number): number => {
    let s = 0;
    const a = zA[ai]!, b = zB[bi]!;
    for (let i = 0; i < SHAPE_DIMS; i++) { const d = a[i]! - b[i]!; s += d * d; }
    return wShape * Math.sqrt(s) + wSize * Math.abs(szA[ai]! - szB[bi]!);
  };

  for (let ai = 0; ai < nA; ai++) {
    let best = 0, bestD = Infinity;
    for (let bi = 0; bi < nB; bi++) {
      const d = dist(ai, bi);
      // ascending tie-break by B index (deterministic)
      if (d < bestD) { bestD = d; best = bi; }
    }
    // Hysteresis: keep last frame's B unless the challenger beats it by margin.
    const prev = opts.prevMatch && ai < opts.prevMatch.length ? opts.prevMatch[ai]! : -1;
    if (prev >= 0 && prev < nB) {
      const prevD = dist(ai, prev);
      if (prevD <= bestD + margin) { match[ai] = prev; continue; }
    }
    match[ai] = best;
  }
  return { match };
}

// ─────────────────────────── Stage 6: relative-position color transfer ───────────────────────────

export interface Affine {
  /** 1 = this A region has a matched B region; 0 = no match → passthrough A. */
  valid: number;
  aCx: number; aCy: number; cosA: number; sinA: number; invSAx: number; invSAy: number;
  bCx: number; bCy: number; cosB: number; sinB: number; sBx: number; sBy: number;
}

const halfExtent = (lambda: number): number => Math.max(EPS, SOURCERY_EXTENT_K * Math.sqrt(Math.max(0, lambda)));

/** Build the A→B oriented-frame affine from the two matched descriptors. */
export function buildAffine(a: ShapeDescriptor, b: ShapeDescriptor): Affine {
  const sAx = halfExtent(a.lambda1), sAy = halfExtent(a.lambda2);
  return {
    valid: 1,
    aCx: a.cx, aCy: a.cy, cosA: Math.cos(a.theta), sinA: Math.sin(a.theta),
    invSAx: 1 / sAx, invSAy: 1 / sAy,
    bCx: b.cx, bCy: b.cy, cosB: Math.cos(b.theta), sinB: Math.sin(b.theta),
    sBx: halfExtent(b.lambda1), sBy: halfExtent(b.lambda2),
  };
}

/** Identity affine for an unmatched A region (samples B — or the passthrough
 *  source — at the same relative position: a no-op frame). */
export function identityAffine(a: ShapeDescriptor): Affine {
  const sAx = halfExtent(a.lambda1), sAy = halfExtent(a.lambda2);
  return {
    valid: 0,
    aCx: a.cx, aCy: a.cy, cosA: Math.cos(a.theta), sinA: Math.sin(a.theta),
    invSAx: 1 / sAx, invSAy: 1 / sAy,
    bCx: a.cx, bCy: a.cy, cosB: Math.cos(a.theta), sinB: Math.sin(a.theta),
    sBx: sAx, sBy: sAy,
  };
}

/**
 * Map an A pixel (px, py in PROC-grid coords) → uvB in [0,1] via the region's
 * local oriented frames + the intra-region ROTATE (radians). The EXACT CPU
 * mirror of the GLSL fill: A-local normalize → clamp to the unit box (stay
 * inside B's shape) → rotate → B-local reconstruct → normalize by proc dims.
 */
export function relToUvB(
  px: number,
  py: number,
  aff: Affine,
  rotate: number,
  procW: number = SOURCERY_PROC_W,
  procH: number = SOURCERY_PROC_H,
): [number, number] {
  const dx = px - aff.aCx, dy = py - aff.aCy;
  let u = (dx * aff.cosA + dy * aff.sinA) * aff.invSAx;
  let v = (-dx * aff.sinA + dy * aff.cosA) * aff.invSAy;
  u = clamp(u, -1, 1);
  v = clamp(v, -1, 1);
  const cr = Math.cos(rotate), sr = Math.sin(rotate);
  const ru = u * cr - v * sr;
  const rv = u * sr + v * cr;
  const pu = ru * aff.sBx, pv = rv * aff.sBy;
  const qx = pu * aff.cosB - pv * aff.sinB;
  const qy = pu * aff.sinB + pv * aff.cosB;
  const bx = aff.bCx + qx, by = aff.bCy + qy;
  return [clamp(bx / procW, 0, 1), clamp(by / procH, 0, 1)];
}

// ─────────────────────────── Stage 7: hue color-skew ───────────────────────────

/**
 * Global COLOR-SKEW: rotate an RGB triple's HSV hue. `skew01` is the 0..1 knob;
 * 0.5 = identity (no shift); it maps bipolarly to ±180°. Reuses the pure,
 * unit-pinned colourofmagic HSV mirror, so the GLSL fill (which copies the same
 * hsv2rgb/rgb2hsv) agrees. Saturation + value pass through untouched.
 */
export function hueSkew(rgb: Vec3, skew01: number): Vec3 {
  const hsv = rgb2hsv(rgb);
  const biasDeg = (skew01 - 0.5) * 360;
  const h = adjHue(hsv[0], biasDeg, null);
  return hsv2rgb([h, hsv[1], hsv[2]]);
}

// ─────────────────────────── Texture packing ───────────────────────────

/**
 * Pack finalLabels (row-major, all pixels 0..MAX−1) into an RGBA8 buffer with
 * region id = R + G·256 (NEAREST-sampled + decoded in the fill). B/A carry a
 * constant so a plain viewer sees a stable grey. Preallocated `out` reused
 * frame-to-frame by the module.
 */
export function packLabelTexture(finalLabels: Int32Array, w: number, h: number, out?: Uint8Array): Uint8Array {
  const dst = out ?? new Uint8Array(w * h * 4);
  for (let i = 0; i < finalLabels.length; i++) {
    const id = Math.max(0, finalLabels[i]!);
    dst[i * 4] = id & 0xff;
    dst[i * 4 + 1] = (id >> 8) & 0xff;
    dst[i * 4 + 2] = 0;
    dst[i * 4 + 3] = 255;
  }
  return dst;
}

/** LUT texel-row layout (RGBA32F, width = MAX_REGIONS, height = LUT_ROWS). One
 *  column per A region; texelFetch(ivec2(regionId, row)) in the fill. */
export const SOURCERY_LUT_ROWS = 4;

/**
 * Pack per-A-region affines into an RGBA32F LUT (Float32Array of
 * maxRegions·LUT_ROWS·4). Row 0: (aCx,aCy,cosA,sinA). Row 1:
 * (invSAx,invSAy,valid,0). Row 2: (bCx,bCy,cosB,sinB). Row 3: (sBx,sBy,0,0).
 * Preallocated `out` reused frame-to-frame.
 */
export function packRegionLUT(affines: Affine[], maxRegions: number = SOURCERY_MAX_REGIONS, out?: Float32Array): Float32Array {
  const dst = out ?? new Float32Array(maxRegions * SOURCERY_LUT_ROWS * 4);
  const n = Math.min(affines.length, maxRegions);
  for (let k = 0; k < n; k++) {
    const a = affines[k]!;
    // texel index for (col=k, row=r) in a row-major (row·width + col) layout.
    const idx = (r: number): number => (r * maxRegions + k) * 4;
    let o = idx(0);
    dst[o] = a.aCx; dst[o + 1] = a.aCy; dst[o + 2] = a.cosA; dst[o + 3] = a.sinA;
    o = idx(1);
    dst[o] = a.invSAx; dst[o + 1] = a.invSAy; dst[o + 2] = a.valid; dst[o + 3] = 0;
    o = idx(2);
    dst[o] = a.bCx; dst[o + 1] = a.bCy; dst[o + 2] = a.cosB; dst[o + 3] = a.sinB;
    o = idx(3);
    dst[o] = a.sBx; dst[o + 1] = a.sBy; dst[o + 2] = 0; dst[o + 3] = 0;
  }
  return dst;
}

// ─────────────────────────── Amortization ───────────────────────────

/**
 * The mandatory temporal amortizer: the expensive/flicker-prone shape stage
 * (segment → moments → match → LUT) recomputes every K frames (or on a forced
 * `recompute` gate — SHAPEGEN's cachedShapes/regenCount pattern), while the
 * cheap GPU fill sampling LIVE B runs every frame. `regenCount` is monotonic:
 * two regens across a K boundary → +1; reads within a hold window → unchanged.
 */
export class Amortizer {
  private frame = 0;
  regenCount = 0;
  constructor(private readonly k: number = SOURCERY_AMORTIZE_K) {}
  /** Advance one frame; returns whether the shape stage should recompute now. */
  step(force = false): boolean {
    const run = force || this.frame % this.k === 0;
    this.frame += 1;
    if (run) this.regenCount += 1;
    return run;
  }
}

/**
 * Run the whole offline shape pipeline for one processed frame: segment both
 * edge maps, describe, match A→B, and build the per-A-region affine table +
 * packed label texture. Pure + deterministic (given the edge grids). The module
 * calls this every K frames under the amortizer; between, it re-samples live B.
 */
export function computeTransfer(
  edgeA: ArrayLike<number>,
  edgeB: ArrayLike<number>,
  w: number,
  h: number,
  opts: { minArea?: number; maxRegions?: number; prevMatch?: Int32Array | null; hysteresisMargin?: number } = {},
): { finalLabelsA: Int32Array; affines: Affine[]; match: Int32Array } {
  const A = segmentAndDescribe(edgeA, w, h, opts);
  const B = segmentAndDescribe(edgeB, w, h, opts);
  const { match } = matchRegions(A.descriptors, B.descriptors, {
    prevMatch: opts.prevMatch ?? null,
    hysteresisMargin: opts.hysteresisMargin,
  });
  const affines: Affine[] = A.descriptors.map((da, ai) => {
    const bi = match[ai]!;
    return bi >= 0 && bi < B.descriptors.length ? buildAffine(da, B.descriptors[bi]!) : identityAffine(da);
  });
  return { finalLabelsA: A.finalLabels, affines, match };
}
