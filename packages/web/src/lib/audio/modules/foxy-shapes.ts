// packages/web/src/lib/audio/modules/foxy-shapes.ts
//
// FOXY — 3dShapeGen path. The shared shape-generation math (feature
// extraction, SDFs, smooth-min, voxel scan) has been EXTRACTED into
// `packages/web/src/lib/video/modules/shapegen-math.ts` so the new
// SHAPEGEN video module can reuse it byte-for-byte. This file re-exports
// those symbols so FOXY's existing import surface (`import { ... } from
// './foxy-shapes'`) stays unchanged. The FOXY-specific
// `voxelsToWavetable` + `shapesPipeline` (which scan a voxel grid into a
// 64×256 wavetable for WAVECEL) stay here — SHAPEGEN doesn't need them.
//
// See shapegen-math.ts for the full design header (feature extraction
// algorithm choices, NMS rationale, SDF derivations, smooth-min, etc.).

import { FOXY_WT_FRAMES, FOXY_WT_SAMPLES } from './foxy-map';
import {
  generateShapes,
  scanShapesToVoxels,
  FOXY_3D_VOXEL_GRID,
  type Shape,
} from '$lib/video/modules/shapegen-math';

// Re-export everything FOXY callers + the existing unit tests pull from
// the old location. Behavior is identical — only the source file moved.
export {
  // Types + enums
  type FoxyShapeType,
  type Shape,
  type FeatureCell,
  FOXY_SHAPE_TYPES,
  // Constants
  FOXY_3D_TARGET_SHAPES,
  FOXY_3D_FEATURE_GRID,
  FOXY_3D_NMS_RADIUS,
  FOXY_3D_VOXEL_GRID,
  FOXY_3D_SMIN_K,
  FOXY_3D_FLAT_VARIANCE_EPS,
  FOXY_3D_MAX_RADIUS,
  // Pure feature-extraction
  featureGrid,
  variance,
  extractPeaks,
  generateShapes,
  // SDF helpers
  sdfSphere,
  sdfCube,
  sdfCone,
  sdfCylinder,
  sdfRing,
  sdfTetraFrame,
  sdf,
  smin,
  scanShapesToVoxels,
  // Size-modulation helper (shared with SHAPEGEN's size knob).
  abSizeFactor,
} from '$lib/video/modules/shapegen-math';

// ── Step 3: voxel → wavetable scan (FOXY-only) ────────────────────────────

/**
 * Linear-interpolate a Z slice of the voxel grid at fractional (x, y).
 * Z is INTEGER (the frame index walks Z slice by slice — no inter-slice
 * interpolation by design). FOXY-only helper.
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
 * Convert the voxel grid into the 64×256 wavetable. FOXY-only — SHAPEGEN
 * doesn't produce wavetables.
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
 * Convenience: full Step1→Step3 pipeline. FOXY-only.
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
