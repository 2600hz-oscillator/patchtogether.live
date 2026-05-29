// packages/web/src/lib/audio/modules/foxy-shapes.ts
//
// FOXY — 3dShapeGen path (alternative to the XYZ continuous-heightfield
// path in foxy-map.ts). Reads the 3 rasters (A,B,C) as DISCRETE FEATURE
// extractors and instantiates a handful of 3D primitives (sphere / cube /
// cone / cylinder / ring / tetraFrame) inside a unit bounding box. The
// scene is then VOXELIZED via signed-distance fields, blended with smooth-
// min, and SCANNED into the same 64×256 wavetable wire format the XYZ
// path produces, so WAVECEL on the audio side never knows the difference.
//
// ── Design choices (flagged so we can iterate) ────────────────────────────
//
// Step 1 — Shape generation:
//   • Raster A → primitive XY position. We take a downsampled NxN grid
//     of column×row means of A's luma (default N = 16) and pick the top
//     TARGET_SHAPES (default 8) cells by luma, with non-maximum suppression
//     (NMS_RADIUS grid cells) so two peaks can't sit on top of each other.
//     Why downsample-then-top-K rather than full per-pixel peak finding:
//       (a) deterministic order (cell index gives a stable tie-break)
//       (b) cheap (256 cells vs 65k pixels for argmax)
//       (c) the grid spacing IS our NMS minimum-distance bound for free.
//     If A is flat (luma variance ≈ 0) we early-out and return an empty
//     shape list — the caller's voxel pass then yields silence.
//   • Raster B luma at that same XY → Z position ∈ [-1,1] (low B = back).
//   • Raster C luma at that XY → type bucket (6 types) + size + hue.
//     Type uses `floor(c * 6)` clamped to 0..5; size scales linearly
//     `r = 0.05 + c * 0.25` so even dark cells still get a small shape.
//
// Step 2 — Voxel scan:
//   • GRID = 32 (32³ = 32k cells; cheap CPU-side per bridge tick).
//   • For each voxel we compute the smooth-min of every shape's SDF, with
//     k=8 (medium blend — visible blob fusion without making everything
//     look gooey). All standard iquilezles.org SDFs.
//   • Output is clamped to [-1, 1] where INSIDE = +1, OUTSIDE = -1, the
//     surface itself = 0. So the wavetable carries positive excursions
//     when the scan path crosses a shape.
//
// Step 3 — Wavetable scan:
//   • Frame f ∈ [0..63] maps to a Z slice (f / 63 → z ∈ [0, GRID-1]).
//   • Sample s ∈ [0..255] walks a DIAGONAL through that Z slice, from
//     (0,0) to (GRID-1, GRID-1), with linear interpolation along the way.
//     Picked diagonal over Hilbert/spiral because:
//       (a) it's the smoothest spatial walk (monotone in both axes), so
//           shape silhouettes read as smooth audio excursions rather than
//           ringy zig-zags;
//       (b) deterministic + trivial — no curve-state tables to maintain;
//       (c) a sphere sounds smooth, a cube sounds square-ish, and a ring
//           sounds bimodal (two crossings per slice) — which is what the
//           spec calls for as the audible-character target.
//
// Determinism: same rasters → same shapes → same wavetable. No
// Math.random anywhere; tie-breaks resolve by cell-index ordering.
//
// All functions in this file are PURE + side-effect-free so the unit tests
// can pin them without a canvas, a GL context, or an AudioContext (mirror
// of how foxy-map.ts is structured).

import { lumaAt } from './foxy-map';
import { FOXY_WT_FRAMES, FOXY_WT_SAMPLES } from './foxy-map';

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

/** Target shape count when raster A has enough features. The spec asks for
 *  N=6..12; 8 is a happy medium — busy enough to read as a SCENE, sparse
 *  enough for each primitive to remain distinguishable in 32³ voxels. */
export const FOXY_3D_TARGET_SHAPES = 8;

/** Downsampled feature-grid size for peak extraction (Step 1). 16×16 = 256
 *  cells across the 256×256 raster: each cell averages a 16×16 raster patch,
 *  which is a comfortable NMS minimum-distance bound. */
export const FOXY_3D_FEATURE_GRID = 16;

/** Non-maximum-suppression radius (in feature-grid cells). 1 = a peak
 *  blocks its 8-neighbors; bigger = sparser, more spread-out scene. */
export const FOXY_3D_NMS_RADIUS = 1;

/** Voxel grid dimension. Cheap enough at 32: 32³ = 32k SDF evaluations per
 *  bridge tick; doubles to 262k at 64 which is borderline at 24Hz so we
 *  hold the line at 32. Wavetable doesn't need more spatial resolution. */
export const FOXY_3D_VOXEL_GRID = 32;

/** Smooth-min blend constant. Bigger k = sharper union (closer to
 *  hard-min); smaller = more melding. 8 is the sweet spot — shapes
 *  visibly fuse at intersections but stay individually readable. */
export const FOXY_3D_SMIN_K = 8;

/** Below this raster-A luma variance we treat A as flat and emit NO
 *  shapes (the wavetable then becomes silence — by design, per spec). */
export const FOXY_3D_FLAT_VARIANCE_EPS = 1e-6;

// ── Step 1: shape generation ──────────────────────────────────────────────

/** A single feature-grid cell: row,col + the cell's mean luma over the
 *  raster patch it covers. Exported for the unit tests. */
export interface FeatureCell {
  row: number;
  col: number;
  /** Mean luma over the cell's raster patch, in [0,1]. */
  luma: number;
}

/**
 * Downsample a `srcW × srcH` RGBA raster into a `grid × grid` mean-luma
 * grid. Each output cell averages the luma of `srcW/grid × srcH/grid`
 * source pixels (nearest-cell partition, edges clipped). Pure +
 * deterministic.
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

/**
 * Variance of a Float32Array (population, not sample — denominator N).
 * Pure helper exported for tests + the early-out flat-A detection.
 */
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

/**
 * Extract up to `count` top-luma peaks from a feature grid with
 * non-maximum suppression. A cell is a peak iff no already-picked peak
 * sits within `nmsRadius` grid cells (Chebyshev distance — i.e., the
 * window is square, side 2*r+1). Deterministic — ties broken by
 * row-major cell index (so the SAME grid always yields the SAME peaks).
 *
 * Empty grid / all-zero grid → empty result. Pure + side-effect-free.
 */
export function extractPeaks(
  grid: Float32Array | readonly number[],
  gridSize: number,
  count: number,
  nmsRadius: number = FOXY_3D_NMS_RADIUS,
): FeatureCell[] {
  if (gridSize <= 0 || count <= 0 || grid.length < gridSize * gridSize) return [];
  // Build a (luma, row, col) list; sort descending by luma, then row-major
  // index (so ties resolve deterministically without Math.random).
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
    // Skip zero-luma cells — they're not "features", just background.
    if (e.luma <= 0) break;
    // NMS: reject if any already-picked peak is within `nmsRadius`.
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
 * Per the design header:
 *   • A's feature-grid peaks → XY positions (in [-1,1]², box space).
 *   • B's luma at each peak  → Z position (in [-1,1], box space).
 *   • C's luma at each peak  → type bucket (6 options) + radius + hue.
 *
 * Pure + deterministic: same buffers + sizes → same Shape list. If A is
 * flat (variance below `FOXY_3D_FLAT_VARIANCE_EPS`) we early-out with an
 * empty list — that's by design (spec: "no NaN, no crash, returns valid
 * wavetable downstream").
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
  // Flat A → no features → no shapes. The wavetable scan will see an empty
  // voxel grid and emit silence (the spec-required behaviour).
  if (variance(aGrid) < FOXY_3D_FLAT_VARIANCE_EPS) return [];

  const peaks = extractPeaks(aGrid, gridSize, target, FOXY_3D_NMS_RADIUS);
  if (peaks.length === 0) return [];

  const out: Shape[] = [];
  for (const p of peaks) {
    // Map grid (row, col) → continuous box coords in [-1, 1].
    // Use the cell CENTER (row + 0.5) / grid → ∈ (0, 1) → ×2 - 1 → ∈ (-1, 1).
    const xn = (p.col + 0.5) / gridSize;       // [0, 1]
    const yn = (p.row + 0.5) / gridSize;       // [0, 1]
    const x = xn * 2 - 1;
    // Box-Y axis: flip so a top-row peak (low grid row) sits HIGH in the
    // box — matches the on-card display's "up = front of the scene" feel.
    const y = -(yn * 2 - 1);

    // Look up B + C at the matching raster pixel (cell center).
    const sx = Math.max(0, Math.min(srcW - 1, Math.round(xn * (srcW - 1))));
    const sy = Math.max(0, Math.min(srcH - 1, Math.round(yn * (srcH - 1))));
    const bL = lumaAt(rgbaB, srcW, srcH, sx, sy);
    const cL = lumaAt(rgbaC, srcW, srcH, sx, sy);

    // B → Z: low luma = back of box (-1), high = front (+1).
    const z = bL * 2 - 1;

    // C → type bucket. floor(c * 6) clamped — note: c==1 maps to 6 which
    // we clamp to 5 (the tetraFrame). Buckets are evenly distributed.
    const tIdx = Math.max(0, Math.min(FOXY_SHAPE_TYPES.length - 1, Math.floor(cL * FOXY_SHAPE_TYPES.length)));
    const type = FOXY_SHAPE_TYPES[tIdx]!;
    // C → radius in [0.05, 0.3]. Even a dark cell still gets the minimum
    // 0.05 so the shape is visible in the voxel grid (sub-2-voxel shapes
    // would alias badly).
    const radius = 0.05 + cL * 0.25;
    // Hue follows C luma — simple but produces the vaporwave gradient
    // sweep across the scene since different shapes get different hues.
    const hue = cL;
    out.push({ type, pos: { x, y, z }, radius, hue });
  }
  return out;
}

// ── Step 2: voxel scan via signed-distance fields ─────────────────────────

/**
 * Sphere SDF. `length(p) - r`. Pure; deterministic.
 */
export function sdfSphere(px: number, py: number, pz: number, r: number): number {
  return Math.sqrt(px * px + py * py + pz * pz) - r;
}

/**
 * Cube (axis-aligned, half-extents r) SDF. The standard iq form:
 *   q = max(abs(p) - r, 0)
 *   d = length(q) + min(max(q.x, q.y, q.z), 0)
 * For r = half-extent of the cube. Pure; deterministic.
 */
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

/**
 * Vertical cone SDF (apex at origin pointing UP +Y, base at y=-r), height
 * = r, base radius = r — a 45° half-angle cone.
 *
 *   q = (length(p.xz), p.y)
 *   slant = qx * cos(a) - qy * sin(a)   ← signed distance to infinite slant;
 *                                          negative INSIDE the conical region
 *                                          ABOVE the apex (y > 0 inside).
 *   cap   = -qy - r                      ← signed distance to y = -r plane;
 *                                          negative ABOVE the base.
 *   d     = max(slant, cap)              ← intersection: inside ⇔ both negative.
 *
 * Wait — we want the cone OPENING DOWN so it has a recognizable triangular
 * silhouette in the box. Negate Y so the apex-up local math still works
 * but the visible cone POINTS UP in world space (apex up, base down). The
 * silhouette renderer draws apex-up triangles to match.
 */
export function sdfCone(px: number, py: number, pz: number, r: number): number {
  // Local frame: cone apex at origin, opens UP (+y is INSIDE the cone).
  // Pass the negated py so a "high-Y" point in the world reads as "inside".
  const qx = Math.sqrt(px * px + pz * pz);
  const qy = py;
  const SQRT2_OVER_2 = Math.SQRT1_2; // sin(45°) == cos(45°) == 1/√2
  // Slant: qx*cos(45°) - qy*sin(45°). NEGATIVE inside (above apex, narrow
  // enough that qx < qy).
  const slant = qx * SQRT2_OVER_2 - qy * SQRT2_OVER_2;
  // Base cap: y = -r plane (the bottom of the cone). NEGATIVE above the cap.
  const cap = -qy - r;
  return Math.max(slant, cap);
}

/**
 * Capped cylinder SDF (oriented along Z), radius r, half-length r. The
 * iq formulation:
 *   d = max(length(p.xy) - r, abs(p.z) - r)
 * — i.e., the intersection of an infinite cylinder + an axis-aligned slab.
 */
export function sdfCylinder(px: number, py: number, pz: number, r: number): number {
  const radial = Math.sqrt(px * px + py * py) - r;
  const axial = Math.abs(pz) - r;
  return Math.max(radial, axial);
}

/**
 * Torus (ring) SDF in the XZ plane. Major radius = r, minor radius = r*0.3.
 *   q = vec2(length(p.xz) - r, p.y)
 *   d = length(q) - r * 0.3
 * 30% minor-radius gives a recognizably "ringy" shape (thin enough to
 * pulse twice per slice through, fat enough to read as a primitive).
 */
export function sdfRing(px: number, py: number, pz: number, r: number): number {
  const qx = Math.sqrt(px * px + pz * pz) - r;
  const qy = py;
  const minor = r * 0.3;
  return Math.sqrt(qx * qx + qy * qy) - minor;
}

/**
 * Tetrahedron-FRAME SDF. We use a simple regular-tetrahedron SDF and
 * subtract a small thickness so the result reads as a hollow frame
 * (negative inside the surface SHELL only). The "frame" character comes
 * from the thin-shell subtraction:
 *   d_solid = max of the four plane SDFs of a regular tetrahedron
 *   d_frame = abs(d_solid) - thickness
 * with the four plane normals being the regular-tetrahedron vertices.
 *
 * The tetra fits inside a sphere of radius r * √3 / 2.
 */
export function sdfTetraFrame(px: number, py: number, pz: number, r: number): number {
  // Vertices of a regular tetrahedron centered at origin (unit-radius).
  // The four plane normals are (per iq's tet SDF):
  //   n0 = ( 1,  1,  1) / √3
  //   n1 = (-1, -1,  1) / √3
  //   n2 = (-1,  1, -1) / √3
  //   n3 = ( 1, -1, -1) / √3
  // For a tet of size r the SDF is the largest signed plane offset:
  //   d_solid = max_i (dot(p, n_i)) - r * something
  // Iq's solid-tetra: d = (max(|x+y|-z, |x-y|+z) - 1) / sqrt(3)
  // We use that compact form, scaled by r, then turn it into a frame.
  const ax = Math.abs(px + py) - pz;
  const ay = Math.abs(px - py) + pz;
  const solid = (Math.max(ax, ay) - r) * (1 / Math.SQRT2);
  // Thin shell: |solid| - thickness. Thickness scales with r so larger
  // tets get proportionally thicker frames.
  const thickness = r * 0.08;
  return Math.abs(solid) - thickness;
}

/**
 * Dispatch SDF by shape type. Pure; deterministic. Used by both the voxel
 * scan and any future per-shape readback.
 */
export function sdf(shape: Shape, px: number, py: number, pz: number): number {
  // Translate the eval point into the shape's local frame.
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

/**
 * Smooth-min blend of two SDFs. The classic exponential smin:
 *   smin(a, b, k) = -log(exp(-k*a) + exp(-k*b)) / k
 *
 * In code we compute it via the numerically-stable
 *   m = min(a, b);  smin = m - log(1 + exp(-k * |a - b|)) / k
 * which avoids overflow when a, b are large positives.
 */
export function smin(a: number, b: number, k: number = FOXY_3D_SMIN_K): number {
  const m = Math.min(a, b);
  const diff = Math.abs(a - b);
  // For large k * diff, the log term goes to 0 — clamp the exp() to keep
  // it numerically tame and avoid NaN. Exp arg always negative so safe.
  const t = Math.exp(-k * diff);
  return m - Math.log1p(t) / k;
}

/**
 * Voxelize the shape set into a `grid³` Float32Array.
 *
 * For each voxel at (vx, vy, vz) ∈ [-1, 1]³ we compute the smooth-min
 * of every shape's SDF. The result is then mapped into [-1, 1] via:
 *   raw INSIDE  (d < 0): output = +1   (clamped to +1 for deep interiors)
 *   raw OUTSIDE (d > 0): output = -1   (clamped to -1 for distant exteriors)
 *   raw AT surface (d == 0): output =  0
 * Specifically: output = clamp(-d / EDGE_BAND, -1, 1) where EDGE_BAND
 * controls how steep the transition is across the surface. We use
 * EDGE_BAND = 0.15 so most voxels far from any shape clamp to -1 and
 * INSIDE voxels clamp to +1, with a smooth ramp in the ~15% of the box
 * near the surface — that ramp is what gives the wavetable its
 * audible shape character (instead of a hard square wave).
 *
 * Empty shape list → all -1 (everything is "outside"). Wavetable then
 * reads as silence (the constant DC offset gets handled downstream).
 *
 * Returns row-major `(z * grid + y) * grid + x` indexing (Z is the slowest
 * axis since the wavetable's FRAME index walks Z).
 *
 * Pure + deterministic.
 */
export function scanShapesToVoxels(
  shapes: readonly Shape[],
  grid: number = FOXY_3D_VOXEL_GRID,
): Float32Array {
  const out = new Float32Array(grid * grid * grid);
  if (grid <= 0) return out;
  // Empty scene → all -1 (no shape anywhere).
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
        // Smooth-min over all shapes (init to first SDF, then fold).
        let d = sdf(shapes[0]!, px, py, pz);
        for (let s = 1; s < shapes.length; s++) {
          d = smin(d, sdf(shapes[s]!, px, py, pz), FOXY_3D_SMIN_K);
        }
        // Map signed distance → [-1, 1] excursion. Inside = positive.
        let v = -d / EDGE_BAND;
        if (v < -1) v = -1;
        else if (v > 1) v = 1;
        out[(zi * grid + yi) * grid + xi] = v;
      }
    }
  }
  return out;
}

// ── Step 3: voxel → wavetable scan ────────────────────────────────────────

/**
 * Linear-interpolate a Z slice of the voxel grid at fractional (x, y).
 * Pure helper for the diagonal walk. Z is INTEGER (the frame index walks
 * Z slice by slice — no inter-slice interpolation by design, since the
 * morph axis is already discrete in WAVECEL's frame walker).
 *
 * Clamps coords to [0, grid-1] then does standard 4-corner bilerp.
 */
export function sampleVoxelSlice(
  voxels: Float32Array | readonly number[],
  grid: number,
  x: number,
  y: number,
  zi: number,
): number {
  if (grid <= 0) return 0;
  const cx = x < 0 ? 0 : x > grid - 1 ? grid - 1 : x;
  const cy = y < 0 ? 0 : y > grid - 1 ? grid - 1 : y;
  const cz = zi < 0 ? 0 : zi > grid - 1 ? grid - 1 : Math.round(zi);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = x0 + 1 >= grid ? grid - 1 : x0 + 1;
  const y1 = y0 + 1 >= grid ? grid - 1 : y0 + 1;
  const fx = cx - x0;
  const fy = cy - y0;
  const base = cz * grid * grid;
  const v00 = voxels[base + y0 * grid + x0] ?? 0;
  const v10 = voxels[base + y0 * grid + x1] ?? 0;
  const v01 = voxels[base + y1 * grid + x0] ?? 0;
  const v11 = voxels[base + y1 * grid + x1] ?? 0;
  const vt = v00 * (1 - fx) + v10 * fx;
  const vb = v01 * (1 - fx) + v11 * fx;
  return vt * (1 - fy) + vb * fy;
}

/**
 * Convert the voxel grid into the 64×256 wavetable.
 *
 * Frame f → Z slice index `z = round((f / (frames-1)) * (grid-1))`.
 * Sample s → diagonal walk from (0, 0) to (grid-1, grid-1):
 *   x = (s / (samples-1)) * (grid-1)
 *   y = (s / (samples-1)) * (grid-1)
 * with `sampleVoxelSlice` bilerping between cells.
 *
 * Output values are CLAMPED to [-1, 1] (same contract WAVECEL expects).
 * Wire format is plain `number[][]` — matches `loadWavetable`'s shape
 * (never Float32Array, never Yjs proxies; see wavecel.ts PR-94 note).
 *
 * Pure + deterministic.
 */
export function voxelsToWavetable(
  voxels: Float32Array | readonly number[],
  grid: number = FOXY_3D_VOXEL_GRID,
  frames: number = FOXY_WT_FRAMES,
  samples: number = FOXY_WT_SAMPLES,
): number[][] {
  const out: number[][] = [];
  for (let f = 0; f < frames; f++) {
    const zi = frames > 1 ? (f / (frames - 1)) * (grid - 1) : 0;
    const frame = new Array<number>(samples);
    for (let s = 0; s < samples; s++) {
      const t = samples > 1 ? s / (samples - 1) : 0;
      const x = t * (grid - 1);
      const y = t * (grid - 1);
      const v = sampleVoxelSlice(voxels, grid, x, y, zi);
      frame[s] = v < -1 ? -1 : v > 1 ? 1 : v;
    }
    out.push(frame);
  }
  return out;
}

/**
 * Convenience: full Step1→Step3 pipeline. Equivalent to:
 *   const shapes = generateShapes(A, B, C, srcW, srcH);
 *   const voxels = scanShapesToVoxels(shapes);
 *   return voxelsToWavetable(voxels);
 * Exposed so foxy.ts (and the unit tests) can call ONE function for the
 * full 3dShapeGen path.
 */
export function shapesPipeline(
  rgbaA: Uint8ClampedArray | readonly number[],
  rgbaB: Uint8ClampedArray | readonly number[],
  rgbaC: Uint8ClampedArray | readonly number[],
  srcW: number,
  srcH: number,
): { shapes: Shape[]; voxels: Float32Array; wavetable: number[][] } {
  const shapes = generateShapes(rgbaA, rgbaB, rgbaC, srcW, srcH);
  const voxels = scanShapesToVoxels(shapes);
  const wavetable = voxelsToWavetable(voxels);
  return { shapes, voxels, wavetable };
}
