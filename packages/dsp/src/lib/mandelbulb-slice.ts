// packages/dsp/src/lib/mandelbulb-slice.ts
//
// MANDELBULB slice → waveform readout — the bulb analogue of cube-dsp's
// sliceRay / rayDepth / sampleSlice. CUBE marches a rotatable slice plane
// through its scalar field to turn the cube's shape into a 256-sample waveform;
// this does the SAME for the MANDELBULB, marching the bulb DISTANCE ESTIMATOR
// (mandelbulb-de.ts → the exact function the GLSL shader mirrors) instead of the
// cube field.
//
// KEY DESIGN — FIXED-SIZE SLICE (camera-independent):
//   The slice plane spans a FIXED extent in fractal OBJECT space
//   ([-MB_SLICE_HALF, +MB_SLICE_HALF] around the bulb origin) and is built ONLY
//   from the slice controls (sliceY + rx/ry/rz). NO camera params (zoom / orbit)
//   enter mbSliceRay or mbRayDepth — so the audio waveform stays STABLE as the
//   user zooms / orbits the on-card view. This is the whole point: the picture's
//   camera is decoupled from the sound's slice. (Mirrors CUBE, where the
//   view-only camera knobs never touch the slice readout.)
//
// Output contract is identical to cube-dsp.sampleSlice: a fresh Float32Array of
// MB_SLICE_SIZE samples, each in [-1, 1], deterministic for a given param set.
//
// lib/ placement rationale is the same as cube-dsp.ts / mandelbulb-de.ts:
// esbuild inlines lib/ files into the worklet entry at build time, and the file
// is pure + unit-testable + reusable by node-ART.

import { jsDistanceEstimate } from './mandelbulb-de';
// Reuse the cube DSP's slice-plane rotation + amplitude helpers verbatim so the
// geometry / crush / clamp behaviour matches CUBE exactly (rotate was promoted
// from module-private to exported for this).
import { rotate, crush, clampRange } from './cube-dsp';

/** Readout waveform length (one wavetable-frame's worth of samples), matching
 *  CUBE_SLICE_SIZE so the bulb slice is a drop-in 256-sample wavetable. */
export const MB_SLICE_SIZE = 256;

/** March steps per slice ray. The bulb DE is far more expensive than a cube
 *  field read, so we use a leaner budget than CUBE_RAY_STEPS (96) — 64 is plenty
 *  to resolve the bulb's surface band across the fixed extent. */
export const MB_RAY_STEPS = 64;

/** Half-extent of the slice plane in FRACTAL object-space units. The Mandelbulb
 *  surface lives in roughly |p| < 1.2, so ±1.2 frames the whole bulb. This is
 *  the constant that makes the slice SIZE-STABLE under camera zoom: the plane is
 *  this big in the bulb's own coordinates regardless of how the camera frames
 *  it on screen. */
export const MB_SLICE_HALF = 1.2;

/** Surface-proximity band (fractal units): a marched point with DE d in
 *  (0, MB_SURF_BAND] reads as partial occupancy ramping 1→0, so the readout is a
 *  smooth surface-thickness scan rather than a hard binary in/out. d<=0 (inside
 *  / on the surface) is full occupancy; d>band is empty. 0.06 ≈ 5% of the full
 *  extent — thin enough to trace surface detail, wide enough to stay continuous
 *  for audio. */
export const MB_SURF_BAND = 0.06;

/** Slice-shaping params for the bulb readout. sliceY + rx/ry/rz position the
 *  plane (NO camera params here — fixed-size, camera-independent). power + iters
 *  are the fractal controls (shared with the video DE). crush (optional) is the
 *  same amplitude bitcrush CUBE uses. */
export interface MbSliceParams {
  /** Slice plane offset along its (rotated) normal, fractal units. 0 = centered
   *  on the bulb origin. */
  sliceY: number;
  /** Euler rotation of the slice square (radians) about x/y/z, matching
   *  cube-dsp.rotate's X→Y→Z order. */
  rx: number;
  ry: number;
  rz: number;
  /** Fractal power (8 = classic Mandelbulb) — same control the GLSL uses. */
  power: number;
  /** Fractal iteration budget — same control the GLSL uses. */
  iters: number;
  /** Optional amplitude bitcrush k ∈ [0,1] (CUBE's crush). 0 / omitted =
   *  transparent. */
  crush?: number;
}

/** One slice ray: an origin in fractal space + a unit direction along the
 *  slice plane's (rotated) normal. Centered on the bulb ORIGIN — the scan axis
 *  spans [-MB_SLICE_HALF, +MB_SLICE_HALF] in fractal units (NOT [0,1] like
 *  CUBE's unit-cube version), and the plane is offset by sliceY along its
 *  rotated normal. Built ONLY from sliceY/rx/ry/rz so it is camera-invariant. */
export interface MbSliceRay {
  origin: [number, number, number];
  dir: [number, number, number];
}

/**
 * Build the slice ray for readout index n ∈ [0, MB_SLICE_SIZE).
 *
 * The slice is a square centered on the bulb origin (0,0,0), spanning the fixed
 * fractal-space extent [-MB_SLICE_HALF, +MB_SLICE_HALF] along its first ("scan")
 * axis, rotated by the Euler angles, then offset by sliceY along its rotated
 * normal. n drives the scan axis; the ray is cast along the plane's (rotated)
 * normal so the depth march measures how much bulb the ray passes through —
 * making sliceY + rotation acoustically load-bearing, exactly like CUBE.
 */
export function mbSliceRay(n: number, p: MbSliceParams): MbSliceRay {
  // Scan axis in [-MB_SLICE_HALF, +MB_SLICE_HALF) (fractal units).
  const sxAxis = (n / MB_SLICE_SIZE) * 2 * MB_SLICE_HALF - MB_SLICE_HALF;
  // Plane local axes: scan = (1,0,0), normal = (0,0,1) before rotation.
  const [sx, sy, sz] = rotate(sxAxis, 0, 0, p.rx, p.ry, p.rz); // scan offset
  const [nx, ny, nz] = rotate(0, 0, 1, p.rx, p.ry, p.rz);      // unit normal
  // Origin = rotated scan offset, shifted by sliceY along the rotated normal.
  // Centered on the ORIGIN (no +0.5 cube-center offset — the bulb lives at 0).
  const ox = sx + nx * p.sliceY;
  const oy = sy + ny * p.sliceY;
  const oz = sz + nz * p.sliceY;
  return { origin: [ox, oy, oz], dir: [nx, ny, nz] };
}

/**
 * March one slice ray through the bulb + return the normalized occupancy depth
 * ∈ [0,1]: for each of MB_RAY_STEPS steps across [-MB_SLICE_HALF, +MB_SLICE_HALF]
 * along the ray, evaluate the DE d and accumulate occupancy
 *   occ = d <= 0 ? 1 : max(0, 1 - d / MB_SURF_BAND)
 * (inside the surface = 1, just outside ramps 1→0 over the band, far outside =
 * 0). NaN guarded → 0 (the origin singularity: a fixed-step march can land on
 * (0,0,0) where acos(z/r) is NaN). Returns acc / MB_RAY_STEPS — a ray that
 * mostly misses the bulb reads quieter (the "silent outside" rule, like CUBE).
 */
export function mbRayDepth(ray: MbSliceRay, p: MbSliceParams): number {
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.dir;
  let acc = 0;
  for (let i = 0; i < MB_RAY_STEPS; i++) {
    const t = (i / (MB_RAY_STEPS - 1)) * 2 * MB_SLICE_HALF - MB_SLICE_HALF; // [-HALF,+HALF]
    const x = ox + dx * t;
    const y = oy + dy * t;
    const z = oz + dz * t;
    const d = jsDistanceEstimate(x, y, z, p.power, p.iters);
    if (Number.isNaN(d)) continue; // origin singularity → contributes 0
    const occ = d <= 0 ? 1 : Math.max(0, 1 - d / MB_SURF_BAND);
    acc += occ;
  }
  return acc / MB_RAY_STEPS;
}

/**
 * The played waveform for one bulb slice — the analogue of cube-dsp.sampleSlice.
 *
 * For each of MB_SLICE_SIZE x-positions: build the slice ray, march it for the
 * occupancy depth ∈ [0,1], optionally CRUSH the amplitude, then map [0,1] →
 * [-1,1]. Returns a fresh Float32Array(256) in [-1, 1] — the SAME contract as
 * CUBE's sampleSlice, so it phase-accumulates through the mandelbulb-osc worklet
 * identically.
 */
export function mbSampleSlice(p: MbSliceParams): Float32Array {
  const out = new Float32Array(MB_SLICE_SIZE);
  const k = p.crush ?? 0;
  for (let n = 0; n < MB_SLICE_SIZE; n++) {
    const ray = mbSliceRay(n, p);
    const depth = mbRayDepth(ray, p);
    const amp = k > 0 ? crush(depth, k) : depth;
    out[n] = clampRange(amp * 2 - 1, -1, 1); // → [-1, 1]
  }
  return out;
}
