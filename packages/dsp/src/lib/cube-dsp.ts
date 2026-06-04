// packages/dsp/src/lib/cube-dsp.ts
//
// CUBE — pure DSP for the 3D wavetable-navigator oscillator (slice 1 of ~8).
//
// CUBE builds a 3D scalar field ("the cube") out of THREE e352 wavetables —
// FLOOR, WALL, CEILING — and lets you fly an arbitrary planar slice through it;
// the slice is read out as the played waveform via a SURFACE-HEIGHT SCAN (at
// each of 256 x-positions the sample = how far the solid material extends along
// the slice, i.e. the intersection depth). See .myrobots/CUBE/PLAN.md §5 for the
// full math + the locked artistic decisions (§2).
//
// This file lives under lib/ for two reasons:
//   1. esbuild inlines lib/ files into the worklet entry (a later slice,
//      packages/dsp/src/cube.ts) at build time — lib/ files MAY `export` freely
//      (unlike the worklet entries, which must not top-level-export or they leak
//      into the ESM bundle + break ART's classic-script eval).
//   2. It is pure + deterministic, so it is unit-testable here and reused
//      verbatim by node-ART (no AudioContext needed).
//
// Reuses WAVETABLE_FRAME_SIZE + sampleFrame's spirit from wavetable-osc.ts; the
// data shape is the same canonical e352 wavetable: Float32Array[], 64 frames ×
// 256 samples, each value in [-1, 1].
//
// ───────────────────────────────────────────────────────────────────────────
// Plan-default choices made here (the §10 questions the plan left to a default):
//   • Q1 field orientation: x → sample-phase (u), y → frame (v). The wavetable's
//     2D "image" paints the floor/wall/ceiling relief. (Plan's stated default.)
//   • Q3 slice→1D collapse: SURFACE-HEIGHT SCAN — confirmed in §2. For each x we
//     march z upward through the field and measure how far the solid extends
//     (intersection depth), so the cube's shape literally becomes the wave.
//   • Q4 readout value: density-of-solid → intersection depth → sample amplitude
//     (confirmed surface-height scan, not frame-index modulation).
//   • Q5 CRUSH curve: linear-in-k on BOTH spatial grid steps (256→4) and
//     amplitude levels (256→2), no separate sample-clock decimation in the lib
//     (a worklet may add sample-rate reduction later). Monotonic.
//   • Material (§2 confirmed): SMOOTH = continuous density; HARD = binary in/out
//     at a 0.5 threshold.

import { WAVETABLE_FRAME_SIZE } from './wavetable-osc';

/** Canonical e352 frame size (256 samples per frame) — re-exported so CUBE
 *  consumers + tests can refer to it without reaching into wavetable-osc. */
export { WAVETABLE_FRAME_SIZE };

/** Number of x-positions scanned per slice = the readout waveform length. We
 *  scan one sample per wavetable column so the cube's horizontal resolution
 *  matches the output frame. */
export const CUBE_SLICE_SIZE = WAVETABLE_FRAME_SIZE; // 256

/** Number of z-march steps used to estimate the surface-height / intersection
 *  depth of the field along a slice ray. Higher = smoother depth estimate at a
 *  per-sample cost; 64 matches the wavetable frame count and is plenty for a
 *  256-sample readout. */
export const CUBE_Z_STEPS = 64;

/** HARD-material occupancy threshold: field density ≥ this counts as solid. */
export const HARD_THRESHOLD = 0.5;

/** Stereo L/R SPREAD depth at spread=1 (fraction of the cube depth the L slice
 *  is read below center and the R slice above center). This does NOT change any
 *  `sampleSlice` math — it's the explicit `depthOffset` the caller passes for
 *  the L (−) and R (+) channels — so the deterministic ART `.f32` baselines
 *  (which pin their own explicit depthOffsets) are unaffected. Shared by the
 *  worklet (fallback path) and the web factory (production off-thread path) so
 *  both agree on the spread amount. ±0.18 is clearly audible yet stays well
 *  inside the unit cube's ±0.866 half-diagonal march extent. */
export const CUBE_SPREAD_DEPTH = 0.18;

/** Depth offset for the L (sign −1) / R (sign +1) channel given a spread knob in
 *  [0,1]. Linear in spread; clamped. Pure so the worklet + factory + tests all
 *  compute the identical offset. */
export function spreadDepthOffset(spread: number, sign: number): number {
  const s = spread < 0 ? 0 : spread > 1 ? 1 : spread;
  return sign * CUBE_SPREAD_DEPTH * s;
}

/** True if a rendered slice waveform is effectively all-zero (the slice sits
 *  fully outside the cube with WRAP off → silent by design). The worklet + the
 *  factory use this to KEEP the last non-silent wave instead of dropping the
 *  audio out while a param is being swept (issue #4). */
export function isSilentWave(wave: Float32Array, eps = 1e-6): boolean {
  for (let i = 0; i < wave.length; i++) {
    if (Math.abs(wave[i] ?? 0) > eps) return false;
  }
  return true;
}

export type Material = 'smooth' | 'hard';

/** Clamp to [0, 1]. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Clamp to an arbitrary range. */
export function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Heightfield read (§5.1) — a wavetable as a 2D image H(u,v) ∈ [-1, 1].
// ───────────────────────────────────────────────────────────────────────────

/**
 * Bilinearly sample a wavetable as a 2D heightfield image H(u, v) ∈ [-1, 1].
 *   u ∈ [0, 1] → sample-phase  (the 256 columns of a frame)
 *   v ∈ [0, 1] → frame index   (the 64 rows / morph axis)
 * u wraps around the column axis (the waveform is periodic in phase); v clamps
 * to the first/last frame (the morph axis has hard ends). Out-of-[0,1] u/v are
 * handled by the caller (slice / wrap logic) — here u/v are assumed in range
 * except for the natural phase wrap.
 *
 * Empty frames → 0.
 */
export function bilinearHeight(
  frames: readonly Float32Array[],
  u: number,
  v: number,
): number {
  const FC = frames.length;
  if (FC === 0) return 0;
  const cols = frames[0]!.length || WAVETABLE_FRAME_SIZE;

  // Column (phase) axis: wrap into [0, cols).
  const uu = u - Math.floor(u); // → [0, 1)
  const colPos = uu * cols;
  const c0 = Math.floor(colPos) % cols;
  const c1 = (c0 + 1) % cols;
  const cFrac = colPos - Math.floor(colPos);

  // Row (frame) axis: clamp to [0, FC-1].
  const rowPos = clamp01(v) * (FC - 1);
  const r0 = Math.floor(rowPos);
  const r1 = Math.min(FC - 1, r0 + 1);
  const rFrac = rowPos - r0;

  const a = frames[r0]!;
  const b = frames[r1]!;
  const top = a[c0]! + (a[c1]! - a[c0]!) * cFrac;
  const bot = b[c0]! + (b[c1]! - b[c0]!) * cFrac;
  return top + (bot - top) * rFrac;
}

/** Heightfield value mapped to a physical height in [0, 1]: (H + 1) / 2. */
export function heightAt(
  frames: readonly Float32Array[],
  u: number,
  v: number,
): number {
  return clamp01((bilinearHeight(frames, u, v) + 1) * 0.5);
}

// ───────────────────────────────────────────────────────────────────────────
// 2. The connecting curve / occupancy (§5.2) — occ(z; bottom, top, connect).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Occupancy (density of solid material) at vertical position z ∈ [0, 1] of the
 * connector that fills the volume between a `bottom` height and a `top` height,
 * both in [0, 1]. Returns a scalar density in [0, 1] ("a space that is a mix of
 * solid and filled").
 *
 * The material is fully solid up to the lower of the two heights, vanishes above
 * the upper one, and is shaped between them by `connect` ∈ [0, 1]:
 *   • connect = 0 (CIRCLE): a smooth half-ellipse bulge — more material in the
 *     middle of the span, rounding off toward the top point. Profile sqrt(1-t²).
 *   • connect = 1 (V): a sawtooth "V" / linear ramp that touches the floor — a
 *     straight density falloff from the bottom up to the top point. Profile 1-t.
 *   • 0 < connect < 1: linear blend of the two profiles (continuous + monotonic
 *     in connect at every fixed z).
 *
 * Both profiles anchor at the same endpoints: density = 1 at the bottom height
 * and density = 0 at the top height, so swapping connect only reshapes the
 * interior, never the touch points (a build requirement).
 *
 * `top` < `bottom` is tolerated (the connector spans whichever pair) — we always
 * fill from the lower height upward to the higher one.
 */
export function occ(
  z: number,
  bottom: number,
  top: number,
  connect: number,
  connectStrength = 0,
): number {
  const lo = Math.min(bottom, top);
  const hi = Math.max(bottom, top);
  const zz = clamp01(z);
  if (zz <= lo) return 1; // fully inside the solid base
  if (zz >= hi) return 0; // above the connector → empty
  const span = hi - lo;
  if (span <= 1e-9) return zz < hi ? 1 : 0; // degenerate (bottom == top)

  const t = (zz - lo) / span; // 0 at bottom height, 1 at top height
  const c = clamp01(connect);
  const s = clamp01(connectStrength);
  if (s <= 0) {
    // OFF = today's EXACT path (verbatim) — load-bearing for byte-identity.
    const circle = Math.sqrt(Math.max(0, 1 - t * t)); // half-ellipse bulge
    const vee = 1 - t; // linear ramp ("V" to the floor)
    return clamp01(circle * (1 - c) + vee * c);
  }
  // CONNECT STRENGTH > 0 — push the shape's interior control point "out of the
  // cube": LIFT each profile so its base region overshoots past density 1, then
  // clamp back into the cube. The endpoints stay anchored (the zz<=lo / zz>=hi
  // guards above return 1 / 0 regardless), so the connector still touches the
  // floor/ceiling — but the solid band near the base swells dramatically as the
  // 3rd point is pushed further out (lift 1→3 across s).
  const lift = 1 + s * 2;
  const circle = clamp01(Math.sqrt(Math.max(0, 1 - t * t)) * lift);
  const vee = clamp01((1 - t) * lift);
  return clamp01(circle * (1 - c) + vee * c);
}

// ───────────────────────────────────────────────────────────────────────────
// 3. The cube scalar field (§5.3) — fieldAt(x, y, z; morphFC, connect, material)
// ───────────────────────────────────────────────────────────────────────────

export interface FieldParams {
  /** MORPH FLOOR/CEILING m ∈ [0,1]: 0 → floor-fill only (ceiling ignored),
   *  1 → ceiling-fill only (floor ignored); in between a weighted average. */
  morphFC: number;
  /** CONNECTION MORPH c ∈ [0,1]: circle arc ↔ sawtooth-V (see occ). */
  connect: number;
  /** CONNECT STRENGTH s ∈ [0,1]: 0 = today; >0 pushes the connector's interior
   *  control point out of the cube (overshoot) for a more dramatic base swell. */
  connectStrength?: number;
  /** HYPERCUBE ALPHA a ∈ [0,1]: the slice's 4th-dimension (w) coordinate. The
   *  field's occupancy is blended toward the HOLO cell `f4 = (1-a)*f3 + a*dH` —
   *  a genuine tesseract cross-section. UNDEFINED (or no holoH) ⇒ the plain 3-
   *  table CUBE field, byte-for-byte. a=0 also collapses f4→f3. CV-able. */
  alpha?: number;
  /** Material readout: SMOOTH = continuous density, HARD = binary in/out. */
  material: Material;
}

/** Heightfields the field needs, pre-read at one (x, y) column. All in [0,1]. */
export interface ColumnHeights {
  floorH: number;
  wallH: number;
  ceilH: number;
  /** HYPERCUBE 4th-table (HOLO) height at this column, in [0,1]. UNDEFINED
   *  when no holo table is supplied (the plain CUBE path) — fieldFromHeights
   *  then returns the EXACT 3-table f3 result. */
  holoH?: number;
}

/**
 * Read the three source heights for a horizontal position (x, y). x → sample-
 * phase (u), y → frame (v) of each table (field orientation Q1 default).
 *
 * HYPERCUBE: `holoFrames` is a TRAILING OPTIONAL arg. When supplied, the 4th
 * (HOLO) table's height is read into `holoH`; when omitted, `holoH` is left
 * `undefined` so fieldFromHeights takes the byte-identical 3-table path.
 */
export function columnHeights(
  floorFrames: readonly Float32Array[],
  wallFrames: readonly Float32Array[],
  ceilFrames: readonly Float32Array[],
  x: number,
  y: number,
  holoFrames?: readonly Float32Array[],
): ColumnHeights {
  return {
    floorH: heightAt(floorFrames, x, y),
    wallH: heightAt(wallFrames, x, y),
    ceilH: heightAt(ceilFrames, x, y),
    holoH: holoFrames ? heightAt(holoFrames, x, y) : undefined,
  };
}

/**
 * The cube scalar field density at (x, y, z) given the three column heights.
 *
 *   floor-fill   dF = occ(z; floorH, wallH, connect)  — wall connected to floor
 *   ceiling-fill dC = occ(z; ceilH,  wallH, connect)  — wall connected to ceiling
 *   field        F  = (1 - m)·dF + m·dC               — weighted average
 *
 * m = 0 → ceiling table ignored, m = 1 → floor table ignored (matches the spec).
 * SMOOTH returns the continuous density F ∈ [0,1]; HARD returns 1 if
 * F ≥ HARD_THRESHOLD else 0 (binary solid).
 *
 * (z is the only argument that varies along a slice ray, so callers that march z
 * pass the pre-read ColumnHeights to avoid re-sampling the tables per z-step.)
 */
export function fieldFromHeights(
  z: number,
  h: ColumnHeights,
  p: FieldParams,
): number {
  const m = clamp01(p.morphFC);
  const cs = p.connectStrength ?? 0;
  const dF = occ(z, h.floorH, h.wallH, p.connect, cs);
  const dC = occ(z, h.ceilH, h.wallH, p.connect, cs);
  const f3 = (1 - m) * dF + m * dC;
  // ── PLAIN CUBE path (off = byte-identity) ──
  // When there's no HOLO height OR no ALPHA, return the EXACT current f3
  // material/clamp result — verbatim, no extra arithmetic (load-bearing for
  // the off-thread byte-identity guarantee + the untouched CUBE baselines).
  if (h.holoH === undefined || p.alpha === undefined) {
    if (p.material === 'hard') return f3 >= HARD_THRESHOLD ? 1 : 0;
    return clamp01(f3);
  }
  // ── HYPERCUBE tesseract cross-section ──
  // dH = the HOLO cell's occupancy (the 4th table connected to the wall);
  // f4 = (1-a)*f3 + a*dH blends the field toward it as ALPHA rises. a=0
  // collapses f4→f3 exactly (1*f3 + 0*dH = f3) so HYPERCUBE-off is identity.
  const dH = occ(z, h.holoH, h.wallH, p.connect, cs);
  const a = clamp01(p.alpha);
  const f4 = (1 - a) * f3 + a * dH;
  if (p.material === 'hard') return f4 >= HARD_THRESHOLD ? 1 : 0;
  return clamp01(f4);
}

/**
 * Convenience: full field read from the three wavetables at a 3D point. Reads
 * the column heights then evaluates the field. Use fieldFromHeights in hot z
 * loops to hoist the table reads out of the loop.
 */
export function fieldAt(
  floorFrames: readonly Float32Array[],
  wallFrames: readonly Float32Array[],
  ceilFrames: readonly Float32Array[],
  x: number,
  y: number,
  z: number,
  p: FieldParams,
): number {
  const h = columnHeights(floorFrames, wallFrames, ceilFrames, x, y);
  return fieldFromHeights(z, h, p);
}

// ───────────────────────────────────────────────────────────────────────────
// 4. CRUSH (§5.4) — 3D bitcrush: spatial grid + amplitude quantization.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Spatial grid resolution (steps per axis) for CRUSH amount k ∈ [0,1].
 *   k = 0 → 256 (transparent), k = 1 → 4 (blocky voxelization). Linear, rounded.
 */
export function crushGridSteps(k: number): number {
  const kk = clamp01(k);
  return Math.max(1, Math.round(256 + (4 - 256) * kk));
}

/**
 * Amplitude quantization levels for CRUSH amount k ∈ [0,1].
 *   k = 0 → 256 (transparent), k = 1 → 2 (eliminates substantial data). Linear.
 */
export function crushLevels(k: number): number {
  const kk = clamp01(k);
  return Math.max(2, Math.round(256 + (2 - 256) * kk));
}

/**
 * Quantize a coordinate in [0,1] onto the CRUSH spatial grid (snap-to-grid
 * before the field lookup → blocky cube). k = 0 → identity. Snaps to the grid
 * cell centers so the result stays in [0,1] and is monotonic in `coord`.
 */
export function crushCoord(coord: number, k: number): number {
  const kk = clamp01(k);
  if (kk <= 0) return coord;
  const n = crushGridSteps(k);
  if (n >= 256) return coord;
  const c = clamp01(coord);
  // Snap to cell center: floor(c*n)/n + half a cell.
  const cell = Math.min(n - 1, Math.floor(c * n));
  return (cell + 0.5) / n;
}

/**
 * Amplitude bitcrush of a field/density value v ∈ [0,1] for CRUSH amount k.
 *   k = 0 → identity; k = 1 → ≤ 2 levels (steppy). Monotonic non-decreasing in
 *   v. Quantizes to `crushLevels(k)` discrete levels spanning [0,1].
 */
export function crush(value: number, k: number): number {
  const kk = clamp01(k);
  if (kk <= 0) return value;
  const levels = crushLevels(k);
  if (levels >= 256) return value;
  const v = clamp01(value);
  return Math.round(v * (levels - 1)) / (levels - 1);
}

// ───────────────────────────────────────────────────────────────────────────
// 4b. SPACE CRUSH — independent spatial voxelization of the FIELD itself.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Spatial grid steps for SPACE CRUSH amount k ∈ [0,1], INDEPENDENT of CRUSH.
 *   k = 0 → 256 (transparent); k = 1 → 6 (chunky voxels). Linear, rounded.
 * Distinct range from crushGridSteps (256→4) so the two crushers read
 * differently when stacked. SPACE CRUSH voxelizes the (x,y,z) LOOKUP coords —
 * coarsening the volumetric data the slice intersects — whereas CRUSH also
 * quantizes the output amplitude.
 */
export function spaceCrushGridSteps(k: number): number {
  const kk = clamp01(k);
  return Math.max(2, Math.round(256 + (6 - 256) * kk));
}

/**
 * Snap a coordinate in [0,1] onto the SPACE-CRUSH voxel grid (cell centers).
 * k = 0 → identity (returns the literal argument before any float math). Snaps
 * to cell centers so the result stays in [0,1] and is monotonic in `coord`.
 */
export function spaceCrushCoord(coord: number, k: number): number {
  const kk = clamp01(k);
  if (kk <= 0) return coord; // OFF = exact identity, no arithmetic
  const n = spaceCrushGridSteps(k);
  if (n >= 256) return coord;
  const c = clamp01(coord);
  const cell = Math.min(n - 1, Math.floor(c * n));
  return (cell + 0.5) / n;
}

// ───────────────────────────────────────────────────────────────────────────
// 4c. SPACE DIFFUSE — gravity toward the cube's lowest-information wall.
// ───────────────────────────────────────────────────────────────────────────

/** A cube face: axis 0=x,1=y,2=z; dir +1 = high face, -1 = low face. */
export interface DiffuseTarget {
  axis: 0 | 1 | 2;
  dir: -1 | 1;
}

/** Default gravity face when the field has no clear emptiest wall (ties /
 *  uniform field): the top (z-high), which is usually emptiest anyway. */
export const DIFFUSE_DEFAULT_TARGET: DiffuseTarget = { axis: 2, dir: 1 };

/** Relative margin the winning (emptiest) half must beat the runner-up by
 *  before we trust it; below this we fall back to the default face. Keeps the
 *  gravity direction from chattering as the field morphs continuously. */
const DIFFUSE_MARGIN = 0.05;

/**
 * Find the lowest-information cube FACE — the emptiest wall the cloud should be
 * pulled toward. "Information" = summed field density over a half-space, sampled
 * on a coarse GRID³ (default 8 → ~512 field reads). Deterministic (no RNG), and
 * depends ONLY on the field (tables + FieldParams), NOT on the diffuse amount —
 * so turning SPACE DIFFUSE never changes the target (it only re-evaluates when
 * the tables/morph/connect change = "latch on table change"). Returns the
 * default face when the winner doesn't clear DIFFUSE_MARGIN over the runner-up.
 */
export function lowestInfoFace(
  floorFrames: readonly Float32Array[],
  wallFrames: readonly Float32Array[],
  ceilFrames: readonly Float32Array[],
  p: FieldParams,
  grid = 8,
): DiffuseTarget {
  // sums[axis][half]: half 0 = low (coord < 0.5), half 1 = high.
  const sums = [
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  const step = 1 / grid;
  for (let i = 0; i < grid; i++) {
    const x = (i + 0.5) * step;
    const hx = x < 0.5 ? 0 : 1;
    for (let j = 0; j < grid; j++) {
      const y = (j + 0.5) * step;
      const hy = y < 0.5 ? 0 : 1;
      const h = columnHeights(floorFrames, wallFrames, ceilFrames, x, y);
      for (let kk = 0; kk < grid; kk++) {
        const z = (kk + 0.5) * step;
        const hz = z < 0.5 ? 0 : 1;
        const d = fieldFromHeights(z, h, p);
        sums[0][hx] += d;
        sums[1][hy] += d;
        sums[2][hz] += d;
      }
    }
  }
  // Candidate = each (axis, half); emptiest = smallest sum. Deterministic order.
  const cands: Array<{ axis: 0 | 1 | 2; dir: -1 | 1; sum: number }> = [
    { axis: 0, dir: -1, sum: sums[0][0] },
    { axis: 0, dir: 1, sum: sums[0][1] },
    { axis: 1, dir: -1, sum: sums[1][0] },
    { axis: 1, dir: 1, sum: sums[1][1] },
    { axis: 2, dir: -1, sum: sums[2][0] },
    { axis: 2, dir: 1, sum: sums[2][1] },
  ];
  cands.sort((a, b) => a.sum - b.sum); // ascending; stable tiebreak by order
  const best = cands[0];
  const next = cands[1];
  const denom = Math.max(1e-9, next.sum);
  if ((next.sum - best.sum) / denom < DIFFUSE_MARGIN) {
    return DIFFUSE_DEFAULT_TARGET; // ambiguous → predictable default (top)
  }
  return { axis: best.axis, dir: best.dir };
}

/**
 * Pull a coordinate c ∈ [0,1] toward a face (dir) by amount k ∈ [0,1]. k = 0 →
 * identity (returns the literal argument). kk² ease: gentle at low knob, strong
 * near 1. Moving the sample positions deforms what the slice intersects → the
 * cloud spreads toward the emptiest wall and the sound changes.
 */
export function diffusePull(c: number, k: number, dir: -1 | 1): number {
  const kk = clamp01(k);
  if (kk <= 0) return c; // OFF = exact identity, no arithmetic
  const target = dir > 0 ? 1 : 0;
  return c + (target - c) * (kk * kk);
}

// ───────────────────────────────────────────────────────────────────────────
// 5. WRAP fold (§5.5) — triangle-wave mirror fold of an out-of-cube coord.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Triangle-wave mirror fold of a coordinate back into [0,1] — the "mirrored
 * copy tiled next to the cube", computed on the single cube via coordinate
 * folding. Examples: -0.1 → 0.1, 1.2 → 0.8, 2.3 → 0.3, -1.4 → 0.6. Period 2,
 * peak 1, trough 0. In-range coords pass through unchanged.
 */
export function wrapFold(coord: number): number {
  // Map to a sawtooth of period 2, then reflect the upper half.
  let m = coord % 2;
  if (m < 0) m += 2; // → [0, 2)
  return m <= 1 ? m : 2 - m; // reflect [1,2) back down to [0,1]
}

// ───────────────────────────────────────────────────────────────────────────
// 5b. FOLD (West-coast wavefolder) — classic triangle/sine folding on the
//     output sample. Adds harmonics as the amount increases; at 0 it is a
//     pass-through identity. Applied AFTER the slice is sampled and BEFORE the
//     output level/gain (see the worklet + the web factory).
// ───────────────────────────────────────────────────────────────────────────

/** Drive gain at fold=1: how hard the signal is pushed into the sine folder.
 *  ~4.0 gives roughly 2 extra fold-overs at full peak (±1) — a rich but bounded
 *  West-coast timbre. Bigger = more folds = more harmonics. */
export const FOLD_MAX_DRIVE = 4.0;

/**
 * West-coast wavefold of one sample x ∈ [-1, 1] for FOLD amount k ∈ [0, 1].
 *
 *   k = 0 → identity (exact pass-through, no harmonics added).
 *   k > 0 → drive the sample by g = 1 + k·FOLD_MAX_DRIVE and pass it through a
 *           sine folder sin(π/2 · g·x). Past ±1 the sine reflects (folds), the
 *           hallmark of a triangle/sine wavefolder: each new fold-over injects a
 *           fresh set of odd-ish harmonics while the output stays bounded in
 *           [-1, 1] (|sin| ≤ 1). Monotonic in k at the low end (more fold), and
 *           continuous at k = 0 (g → 1 ⇒ sin(π/2·x) ≈ x near 0, exact at the
 *           ±1 endpoints; the explicit k≤0 short-circuit keeps it a true
 *           identity so the unfolded baseline is byte-stable).
 *
 * Bounded by construction (output = sin(...) ∈ [-1, 1]); never NaN/Inf for
 * finite x. The π/2 scale makes the folder pass ±1 through to ±1 at k→0.
 */
export function wavefold(x: number, k: number): number {
  const kk = clamp01(k);
  if (kk <= 0) return x;
  const drive = 1 + kk * FOLD_MAX_DRIVE;
  return Math.sin((Math.PI / 2) * drive * x);
}

/**
 * Apply the wavefolder in place across a whole slice waveform (each sample in
 * [-1, 1]). k = 0 leaves the buffer untouched (returns the same array). Used by
 * the worklet (audio thread) + the web factory (off-thread render) so the played
 * audio and the WAVEFORM viz both show the FOLDED wave.
 */
export function applyFold(wave: Float32Array, k: number): Float32Array {
  if (clamp01(k) <= 0) return wave;
  for (let i = 0; i < wave.length; i++) {
    wave[i] = wavefold(wave[i] ?? 0, k);
  }
  return wave;
}

// ───────────────────────────────────────────────────────────────────────────
// 6. The slice plane + SURFACE-HEIGHT SCAN readout (§5.5 / §5.6).
// ───────────────────────────────────────────────────────────────────────────

export interface SliceParams {
  /** Slice plane center height sliceY ∈ [0,1] (offset up/down in the cube). */
  sliceY: number;
  /** Euler rotation of the slice square (radians) about cube x/y/z axes. */
  rx: number;
  ry: number;
  rz: number;
  /** MORPH FLOOR/CEILING m ∈ [0,1]. */
  morphFC: number;
  /** CONNECTION MORPH c ∈ [0,1]. */
  connect: number;
  /** Material readout (SMOOTH | HARD). */
  material: Material;
  /** CRUSH k ∈ [0,1]. */
  crush: number;
  /** SPACE CRUSH k ∈ [0,1]: voxelize the field lookup coords (default 0 = off). */
  spaceCrush?: number;
  /** SPACE DIFFUSE k ∈ [0,1]: pull the cloud toward the emptiest wall (0 = off). */
  spaceDiffuse?: number;
  /** CONNECT STRENGTH s ∈ [0,1]: overshoot the connector's base (0 = off). */
  connectStrength?: number;
  /** HYPERCUBE ALPHA a ∈ [0,1]: the slice's 4th-dimension (w) coordinate.
   *  Threaded into the FieldParams the ray march builds; UNDEFINED (or no
   *  holoFrames passed to sampleSlice/rayDepth) ⇒ the plain 3-table CUBE
   *  render, byte-for-byte. CV-able; default off. */
  alpha?: number;
  /** WRAP toggle: out-of-cube coords mirror-fold back in when true. */
  wrap: boolean;
}

/** Rotate a vector by Euler angles (rx, ry, rz), applied X then Y then Z.
 *  EXPORTED (PR feat/mandelbulb-slice) so the MANDELBULB bulb-slice readout can
 *  reuse the IDENTICAL slice-plane rotation geometry (so its 2D slice viz +
 *  3D plane + audio readout all agree on where the plane sits). */
export function rotate(
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
): [number, number, number] {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // X rotation
  const x1 = x;
  const y1 = y * cx - z * sx;
  const z1 = y * sx + z * cx;
  // Y rotation
  const x2 = x1 * cy + z1 * sy;
  const y2 = y1;
  const z2 = -x1 * sy + z1 * cy;
  // Z rotation
  const x3 = x2 * cz - y2 * sz;
  const y3 = x2 * sz + y2 * cz;
  const z3 = z2;
  return [x3, y3, z3];
}

/**
 * The slice ray for readout index n ∈ [0,256): an origin point in cube space and
 * a unit direction along the slice plane's normal.
 *
 * The slice is a unit square centered on the cube center (0.5, 0.5, sliceY),
 * spanning [-0.5, 0.5] along its first ("scan") axis, rotated by the Euler
 * angles, then translated to the center. n drives the scan axis; the ray is cast
 * from the square's plane along its (rotated) normal so the surface-height scan
 * measures how far the solid extends *through* the slice — making sliceY +
 * rotation acoustically load-bearing.
 *
 * `depthOffset` shifts the ray origin along the normal (used by L/R spread to
 * read the slice ±5% off-center; default 0 = the selection slice itself).
 */
export interface SliceRay {
  origin: [number, number, number];
  dir: [number, number, number];
}
export function sliceRay(n: number, p: SliceParams, depthOffset = 0): SliceRay {
  const px = n / CUBE_SLICE_SIZE - 0.5; // scan axis, [-0.5, 0.5)
  // Plane local axes: scan = (1,0,0), normal = (0,0,1) before rotation.
  const [sx, sy, sz] = rotate(px, 0, 0, p.rx, p.ry, p.rz); // scan offset
  const [nx, ny, nz] = rotate(0, 0, 1, p.rx, p.ry, p.rz); // unit normal
  const ox = sx + 0.5 + nx * depthOffset;
  const oy = sy + 0.5 + ny * depthOffset;
  const oz = sz + p.sliceY + nz * depthOffset;
  return { origin: [ox, oy, oz], dir: [nx, ny, nz] };
}

/** Number of steps marched along a slice ray to measure intersection depth. The
 *  ray can be up to √3 long inside the unit cube, so we sample generously. */
export const CUBE_RAY_STEPS = 96;

/**
 * SURFACE-HEIGHT SCAN depth for one ray: march from the slice plane along its
 * normal across the unit cube and accumulate how much solid the ray passes
 * through (intersection depth ∈ [0,1]). With SMOOTH material this integrates the
 * continuous density; with HARD it counts the solid fraction. Samples whose
 * marched point falls outside [0,1]³ contribute 0 (silent) unless `wrap`, where
 * each coord mirror-folds back into the cube. CRUSH snaps the lookup coords to
 * the spatial grid.
 *
 * This is THE surface-height scan: the deeper the solid extends along the ray,
 * the larger the sample — the cube's shape literally becomes the wave.
 */
export function rayDepth(
  floorFrames: readonly Float32Array[],
  wallFrames: readonly Float32Array[],
  ceilFrames: readonly Float32Array[],
  ray: SliceRay,
  p: SliceParams,
  diffuseTarget: DiffuseTarget | null = null,
  holoFrames?: readonly Float32Array[],
): number {
  const fp: FieldParams = {
    morphFC: p.morphFC,
    connect: p.connect,
    connectStrength: p.connectStrength ?? 0,
    // HYPERCUBE ALPHA — only bites when holoFrames is also supplied (the
    // columnHeights call below leaves holoH undefined without it, so
    // fieldFromHeights stays on the byte-identical 3-table path).
    alpha: p.alpha,
    material: p.material,
  };
  const sd = p.spaceDiffuse ?? 0;
  const sc = p.spaceCrush ?? 0;
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.dir;
  // March a fixed extent centered on the origin so depth grows with how much
  // solid the ray crosses regardless of sign of the normal. Range covers the
  // full diagonal of the cube either side of the plane.
  const HALF = Math.sqrt(3) / 2; // ≈0.866
  let acc = 0;
  let counted = 0;
  for (let i = 0; i < CUBE_RAY_STEPS; i++) {
    const t = (i / (CUBE_RAY_STEPS - 1)) * 2 * HALF - HALF; // [-HALF, +HALF]
    let x = ox + dx * t;
    let y = oy + dy * t;
    let z = oz + dz * t;
    // SPACE DIFFUSE — warp the sample toward the emptiest wall BEFORE the
    // inside-test, so the cloud spreads (and rays warped out read quieter via
    // the /CUBE_RAY_STEPS normalizer). diffuseTarget is null when sd === 0.
    if (diffuseTarget) {
      if (diffuseTarget.axis === 0) x = diffusePull(x, sd, diffuseTarget.dir);
      else if (diffuseTarget.axis === 1) y = diffusePull(y, sd, diffuseTarget.dir);
      else z = diffusePull(z, sd, diffuseTarget.dir);
    }
    const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1 && z >= 0 && z <= 1;
    if (!inside) {
      if (!p.wrap) continue; // out-of-cube → silent (no contribution)
      x = wrapFold(x);
      y = wrapFold(y);
      z = wrapFold(z);
    }
    // SPACE CRUSH voxelizes the lookup coords, THEN CRUSH snaps (compose).
    const cx = crushCoord(spaceCrushCoord(x, sc), p.crush);
    const cy = crushCoord(spaceCrushCoord(y, sc), p.crush);
    const cz = crushCoord(spaceCrushCoord(z, sc), p.crush);
    const h = columnHeights(floorFrames, wallFrames, ceilFrames, cx, cy, holoFrames);
    acc += fieldFromHeights(cz, h, fp);
    counted++;
  }
  // Normalize by the number of marched steps (constant CUBE_RAY_STEPS) so a ray
  // that is mostly outside the cube reads quieter — the "silent outside" rule.
  return acc / CUBE_RAY_STEPS;
}

/**
 * SURFACE-HEIGHT SCAN readout — the played waveform for one slice.
 *
 * For each of 256 x-positions: build the slice ray, march it to measure the
 * intersection depth ∈ [0,1], apply CRUSH amplitude quantization, then map
 * [0,1] → [-1,1]. Out-of-cube ray samples read 0 (silent) unless `wrap`, where
 * coords mirror-fold back in.
 *
 * `depthOffset` shifts the whole slice along its normal (used by L/R spread to
 * read the slice ±5% off-center; default 0 = the selection slice).
 *
 * Returns a fresh Float32Array(256) in [-1, 1].
 */
export function sampleSlice(
  floorFrames: readonly Float32Array[],
  wallFrames: readonly Float32Array[],
  ceilFrames: readonly Float32Array[],
  p: SliceParams,
  depthOffset = 0,
  holoFrames?: readonly Float32Array[],
): Float32Array {
  const out = new Float32Array(CUBE_SLICE_SIZE);
  // SPACE DIFFUSE target: resolve the emptiest wall ONCE per render (it depends
  // only on the field, not the diffuse amount → stable while the knob moves;
  // re-evaluated only when the tables/morph/connect change). null when off.
  // NOTE lowestInfoFace samples the plain 3-table field (no holo) — the diffuse
  // GRAVITY DIRECTION is intentionally HYPERCUBE-independent, mirroring how it
  // already ignores the diffuse amount itself ("latch on table change"). The
  // per-ray march below DOES use the alpha-blended field via holoFrames.
  const sd = p.spaceDiffuse ?? 0;
  const tgt =
    sd > 0
      ? lowestInfoFace(floorFrames, wallFrames, ceilFrames, {
          morphFC: p.morphFC,
          connect: p.connect,
          connectStrength: p.connectStrength ?? 0,
          alpha: p.alpha,
          material: p.material,
        })
      : null;
  for (let n = 0; n < CUBE_SLICE_SIZE; n++) {
    const ray = sliceRay(n, p, depthOffset);
    const depth = rayDepth(floorFrames, wallFrames, ceilFrames, ray, p, tgt, holoFrames);
    const crushed = crush(depth, p.crush); // amplitude crush in [0,1]
    out[n] = clampRange(crushed * 2 - 1, -1, 1); // → [-1, 1]
  }
  return out;
}
