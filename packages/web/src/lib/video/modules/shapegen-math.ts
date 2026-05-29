// packages/web/src/lib/video/modules/shapegen-math.ts
//
// SHAPEGEN — shared 3D-shape-generation math, extracted from FOXY's
// `foxy-shapes.ts` so both:
//   • FOXY (audio-domain) — re-exports these symbols + adds its own
//     voxel→wavetable scan (see foxy-shapes.ts).
//   • SHAPEGEN (video-domain) — uses these symbols + the matching
//     shapegen-draw renderer.
//
// All functions here are PURE + side-effect-free. No canvas, no GL, no
// AudioContext. The behaviour is byte-identical to the original FOXY
// implementation (the module just moved files); existing FOXY tests
// continue to pass through the foxy-shapes.ts re-export shim.
//
// See foxy-shapes.ts for the original design header (feature extraction
// algorithm choices, NMS rationale, SDF derivations, smooth-min, etc.).

import { lumaAt } from '$lib/audio/modules/foxy-map';

/** The discrete primitive types. Six buckets so a single 0..1 luma value
 *  cleanly indexes them with `floor(c * 6)`. */
export type FoxyShapeType =
  | 'sphere'
  | 'cube'
  | 'cone'
  | 'cylinder'
  | 'ring'
  | 'tetraFrame';

/** Shape order matches the C-luma → type bucket mapping. Exported for tests
 *  + the on-card renderer (which iterates this order for color cycling). */
export const FOXY_SHAPE_TYPES: readonly FoxyShapeType[] = [
  'sphere', 'cube', 'cone', 'cylinder', 'ring', 'tetraFrame',
] as const;

/** One primitive in the unit bounding box. All numeric ranges are
 *  spec-mandated. Positions are in [-1,1]³ (the box spans (-1,-1,-1) →
 *  (+1,+1,+1)); radius is the primitive's characteristic dimension. */
export interface Shape {
  type: FoxyShapeType;
  pos: { x: number; y: number; z: number };
  /** Characteristic dimension in [0.05, 0.3]. */
  radius: number;
  /** Hue in [0,1] — derived from C luma; used only by the renderer. */
  hue: number;
}

/** Target shape count when raster A has enough features. */
export const FOXY_3D_TARGET_SHAPES = 8;

/** Downsampled feature-grid size for peak extraction. */
export const FOXY_3D_FEATURE_GRID = 16;

/** Non-maximum-suppression radius (in feature-grid cells). */
export const FOXY_3D_NMS_RADIUS = 1;

/** Voxel grid dimension. */
export const FOXY_3D_VOXEL_GRID = 32;

/** Smooth-min blend constant. */
export const FOXY_3D_SMIN_K = 8;

/** Below this raster-A luma variance we treat A as flat and emit NO shapes. */
export const FOXY_3D_FLAT_VARIANCE_EPS = 1e-6;

/** Upper clamp on the final per-primitive radius after A×B modulation.
 *  At factor=2.0 the largest C-driven baseline (0.05 + 1*0.25 = 0.3)
 *  reaches 0.6, which is the max we tolerate inside the unit box before
 *  primitives start poking outside it. */
export const FOXY_3D_MAX_RADIUS = 0.6;

// ── Step 1: shape generation ──────────────────────────────────────────────

/** A single feature-grid cell. */
export interface FeatureCell {
  row: number;
  col: number;
  /** Mean luma over the cell's raster patch, in [0,1]. */
  luma: number;
}

/**
 * Downsample a `srcW × srcH` RGBA raster into a `grid × grid` mean-luma
 * grid. Pure + deterministic.
 */
export function featureGrid(
  rgba: Uint8ClampedArray | readonly number[],
  srcW: number,
  srcH: number,
  grid: number = FOXY_3D_FEATURE_GRID,
): Float32Array {
  const out = new Float32Array(grid * grid);
  if (srcW <= 0 || srcH <= 0 || grid <= 0) return out;
  const cellW = srcW / grid;
  const cellH = srcH / grid;
  for (let r = 0; r < grid; r++) {
    const y0 = Math.floor(r * cellH);
    const y1 = Math.max(y0 + 1, Math.floor((r + 1) * cellH));
    for (let c = 0; c < grid; c++) {
      const x0 = Math.floor(c * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((c + 1) * cellW));
      let acc = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < srcH; y++) {
        for (let x = x0; x < x1 && x < srcW; x++) {
          acc += lumaAt(rgba, srcW, srcH, x, y);
          n++;
        }
      }
      out[r * grid + c] = n > 0 ? acc / n : 0;
    }
  }
  return out;
}

/** Population variance (denominator N). */
export function variance(arr: Float32Array | readonly number[]): number {
  const n = arr.length;
  if (n === 0) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += arr[i] ?? 0;
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = (arr[i] ?? 0) - mean;
    v += d * d;
  }
  return v / n;
}

/** Top-K peak extraction with NMS. Deterministic; ties broken by row-major
 *  cell index. Pure + side-effect-free. */
export function extractPeaks(
  grid: Float32Array | readonly number[],
  gridSize: number,
  count: number,
  nmsRadius: number = FOXY_3D_NMS_RADIUS,
): FeatureCell[] {
  if (gridSize <= 0 || count <= 0 || grid.length < gridSize * gridSize) return [];
  interface Entry { luma: number; row: number; col: number; idx: number }
  const entries: Entry[] = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      entries.push({ luma: grid[idx] ?? 0, row: r, col: c, idx });
    }
  }
  entries.sort((a, b) => {
    if (a.luma !== b.luma) return b.luma - a.luma;
    return a.idx - b.idx;
  });
  const picked: FeatureCell[] = [];
  for (const e of entries) {
    if (picked.length >= count) break;
    if (e.luma <= 0) break;
    let blocked = false;
    for (const p of picked) {
      if (Math.abs(p.row - e.row) <= nmsRadius && Math.abs(p.col - e.col) <= nmsRadius) {
        blocked = true;
        break;
      }
    }
    if (!blocked) picked.push({ row: e.row, col: e.col, luma: e.luma });
  }
  return picked;
}

/**
 * Generate the list of 3D primitives from the three rasters.
 *
 *   • A's feature-grid peaks → XY positions (in [-1,1]², box space).
 *   • B's luma at each peak  → Z position (in [-1,1], box space).
 *   • C's luma at each peak  → type bucket (6 options) + radius + hue.
 */
export function generateShapes(
  rgbaA: Uint8ClampedArray | readonly number[],
  rgbaB: Uint8ClampedArray | readonly number[],
  rgbaC: Uint8ClampedArray | readonly number[],
  srcW: number,
  srcH: number,
  target: number = FOXY_3D_TARGET_SHAPES,
  gridSize: number = FOXY_3D_FEATURE_GRID,
): Shape[] {
  if (srcW <= 0 || srcH <= 0 || target <= 0) return [];
  const aGrid = featureGrid(rgbaA, srcW, srcH, gridSize);
  if (variance(aGrid) < FOXY_3D_FLAT_VARIANCE_EPS) return [];

  const peaks = extractPeaks(aGrid, gridSize, target, FOXY_3D_NMS_RADIUS);
  if (peaks.length === 0) return [];

  const out: Shape[] = [];
  for (const p of peaks) {
    const xn = (p.col + 0.5) / gridSize;       // [0, 1]
    const yn = (p.row + 0.5) / gridSize;       // [0, 1]
    const x = xn * 2 - 1;
    const y = -(yn * 2 - 1);

    // Look up A + B + C at the matching raster pixel (cell center). A is
    // sampled at the per-pixel location (not the grid-cell mean) so the
    // size factor reflects the EXACT peak's A intensity, matching B/C.
    const sx = Math.max(0, Math.min(srcW - 1, Math.round(xn * (srcW - 1))));
    const sy = Math.max(0, Math.min(srcH - 1, Math.round(yn * (srcH - 1))));
    const aL = lumaAt(rgbaA, srcW, srcH, sx, sy);
    const bL = lumaAt(rgbaB, srcW, srcH, sx, sy);
    const cL = lumaAt(rgbaC, srcW, srcH, sx, sy);

    const z = bL * 2 - 1;

    const tIdx = Math.max(0, Math.min(FOXY_SHAPE_TYPES.length - 1, Math.floor(cL * FOXY_SHAPE_TYPES.length)));
    const type = FOXY_SHAPE_TYPES[tIdx]!;
    // C → baseline radius in [0.05, 0.3]. A × B → per-primitive size factor
    // in [0.5, 2.0]. Multiplies the C-baseline so bright-on-both peaks puff
    // up, dim peaks shrink. Clamp to FOXY_3D_MAX_RADIUS so nothing escapes
    // the unit bounding box.
    const rBase = 0.05 + cL * 0.25;
    const factor = abSizeFactor(aL, bL);
    let radius = rBase * factor;
    if (radius > FOXY_3D_MAX_RADIUS) radius = FOXY_3D_MAX_RADIUS;
    const hue = cL;
    out.push({ type, pos: { x, y, z }, radius, hue });
  }
  return out;
}

// ── SDF helpers ───────────────────────────────────────────────────────────

export function sdfSphere(px: number, py: number, pz: number, r: number): number {
  return Math.sqrt(px * px + py * py + pz * pz) - r;
}

export function sdfCube(px: number, py: number, pz: number, r: number): number {
  const qx = Math.abs(px) - r;
  const qy = Math.abs(py) - r;
  const qz = Math.abs(pz) - r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const inside = Math.min(Math.max(qx, qy, qz), 0);
  return outside + inside;
}

export function sdfCone(px: number, py: number, pz: number, r: number): number {
  const qx = Math.sqrt(px * px + pz * pz);
  const qy = py;
  const SQRT2_OVER_2 = Math.SQRT1_2;
  const slant = qx * SQRT2_OVER_2 - qy * SQRT2_OVER_2;
  const cap = -qy - r;
  return Math.max(slant, cap);
}

export function sdfCylinder(px: number, py: number, pz: number, r: number): number {
  const radial = Math.sqrt(px * px + py * py) - r;
  const axial = Math.abs(pz) - r;
  return Math.max(radial, axial);
}

export function sdfRing(px: number, py: number, pz: number, r: number): number {
  const qx = Math.sqrt(px * px + pz * pz) - r;
  const qy = py;
  const minor = r * 0.3;
  return Math.sqrt(qx * qx + qy * qy) - minor;
}

export function sdfTetraFrame(px: number, py: number, pz: number, r: number): number {
  const ax = Math.abs(px + py) - pz;
  const ay = Math.abs(px - py) + pz;
  const solid = (Math.max(ax, ay) - r) * (1 / Math.SQRT2);
  const thickness = r * 0.08;
  return Math.abs(solid) - thickness;
}

/** Dispatch SDF by shape type. Translates the eval point into the shape's
 *  local frame first. */
export function sdf(shape: Shape, px: number, py: number, pz: number): number {
  const lx = px - shape.pos.x;
  const ly = py - shape.pos.y;
  const lz = pz - shape.pos.z;
  switch (shape.type) {
    case 'sphere':     return sdfSphere(lx, ly, lz, shape.radius);
    case 'cube':       return sdfCube(lx, ly, lz, shape.radius);
    case 'cone':       return sdfCone(lx, ly, lz, shape.radius);
    case 'cylinder':   return sdfCylinder(lx, ly, lz, shape.radius);
    case 'ring':       return sdfRing(lx, ly, lz, shape.radius);
    case 'tetraFrame': return sdfTetraFrame(lx, ly, lz, shape.radius);
  }
}

/** Smooth-min blend of two SDFs (numerically-stable form). */
export function smin(a: number, b: number, k: number = FOXY_3D_SMIN_K): number {
  const m = Math.min(a, b);
  const diff = Math.abs(a - b);
  const t = Math.exp(-k * diff);
  return m - Math.log1p(t) / k;
}

/**
 * Voxelize the shape set into a `grid³` Float32Array. See foxy-shapes.ts
 * for the full rationale. Pure + deterministic.
 */
export function scanShapesToVoxels(
  shapes: readonly Shape[],
  grid: number = FOXY_3D_VOXEL_GRID,
): Float32Array {
  const out = new Float32Array(grid * grid * grid);
  if (grid <= 0) return out;
  if (shapes.length === 0) {
    out.fill(-1);
    return out;
  }
  const EDGE_BAND = 0.15;
  for (let zi = 0; zi < grid; zi++) {
    const pz = grid > 1 ? (zi / (grid - 1)) * 2 - 1 : 0;
    for (let yi = 0; yi < grid; yi++) {
      const py = grid > 1 ? (yi / (grid - 1)) * 2 - 1 : 0;
      for (let xi = 0; xi < grid; xi++) {
        const px = grid > 1 ? (xi / (grid - 1)) * 2 - 1 : 0;
        let d = sdf(shapes[0]!, px, py, pz);
        for (let s = 1; s < shapes.length; s++) {
          d = smin(d, sdf(shapes[s]!, px, py, pz), FOXY_3D_SMIN_K);
        }
        let v = -d / EDGE_BAND;
        if (v < -1) v = -1;
        else if (v > 1) v = 1;
        out[(zi * grid + yi) * grid + xi] = v;
      }
    }
  }
  return out;
}

/**
 * Per-primitive size modulation: `factor = 0.5 + 1.5 * (lumaA * lumaB)`.
 *
 * Maps the product `lumaA * lumaB ∈ [0, 1]` to a multiplicative factor in
 * `[0.5, 2.0]` — applied on TOP of the existing C-derived baseline radius
 * (`0.05 + c*0.25`). The intent: shapes where BOTH A and B are bright at
 * the peak get scaled up (toward 2×); shapes where either is dim get
 * scaled down (toward 0.5×). Per-primitive — each shape uses its OWN A,B
 * sample at its own peak, no global renormalization.
 *
 * Inputs are clamped into [0, 1] so out-of-range values from upstream
 * (e.g. SHAPEGEN's GL reads) can't push the factor outside [0.5, 2.0].
 *
 * Pure + deterministic.
 */
export function abSizeFactor(aLuma: number, bLuma: number): number {
  const a = Math.max(0, Math.min(1, aLuma));
  const b = Math.max(0, Math.min(1, bLuma));
  return 0.5 + 1.5 * (a * b);
}
