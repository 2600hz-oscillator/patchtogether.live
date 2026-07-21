// packages/web/src/lib/video/videocube-core.ts
//
// VIDEOCUBE — pure math CORE. Every function here is the CPU MIRROR of the GLSL
// ray-march COMBINE shader in ./modules/videocube.ts (the FRAMETABLE / cube-dsp
// source-of-truth discipline): unit-testing them pins the semantics the shader
// transliterates 1:1. NO WebGL in this file — it runs in jsdom.
//
// VIDEOCUBE is the VIDEO isomorph of the audio CUBE oscillator. It stacks THREE
// video-luma SURFACES (A/B/C = FLOOR/WALL/CEILING — the reader-selected frame of
// each 60-frame ring) into a GENUINE 3D scalar field over (x,y,z) ∈ [0,1]³, the
// SAME field the audio CUBE builds from three wavetables:
//
//     F(x,y,z) = cube-dsp.fieldFromHeights(z; S_A(x,y), S_B(x,y), S_C(x,y), …)
//
// where S_?(x,y) are the three surfaces' luma and `z` is a REAL connecting depth
// axis — occ() fills solid density BETWEEN the surfaces exactly as it does
// between three wavetables (the earlier v1 collapsed z = (lumaA+lumaB+lumaC)/3
// at ONE point per pixel → a flat 2D blend, the owner-rejected bug this rebuild
// fixes). The occupancy structure (occ / MORPH FC / CONNECT / CONNECT STRENGTH /
// CRUSH / SPACE CRUSH / SPACE DIFFUSE / WRAP / MATERIAL) is the EXACT audio-CUBE
// field math from `cube-dsp.ts`, reused wholesale so a single knob drives BOTH
// the picture (a volumetric ray-march of this field) AND the timbre
// (cube-dsp.sampleSlice through the SAME field, fed the SAME luma-reduced
// surfaces — see ./modules/videocube.ts §audio).
//
// This file only adds what CUBE's audio field has no analog for: the per-voxel
// occupancy-weighted COLOUR of the three source surfaces (so the ray-march
// TEXTURES the solid), and the single-frame ring→luma-heightfield reduction that
// feeds the audio scan. The per-slot temporal ring READ (frame select / lag /
// first-fill / freeze) is FRAMETABLE's machinery (frametable-core.ts), reused
// verbatim by the shader; the field/slice math (occ / fieldFromHeights /
// spaceCrushCoord / crushCoord / diffusePull / wrapFold / lowestInfoFace) is
// cube-dsp's, imported below.

import {
  clamp01,
  occ,
  fieldFromHeights,
  lowestInfoFace,
  crushLevels,
  crush,
  crushCoord,
  spaceCrushCoord,
  wrapFold,
  HARD_THRESHOLD,
  DIFFUSE_DEFAULT_TARGET,
  type Material,
  type DiffuseTarget,
  type FieldParams,
} from '../../../../dsp/src/lib/cube-dsp';
import {
  FRAMETABLE_RING_FRAMES,
  FRAMETABLE_RENDER_SCALE,
} from './frametable-core';

export type { DiffuseTarget, Material } from '../../../../dsp/src/lib/cube-dsp';

// ── Ring geometry — reuse FRAMETABLE's constants (VIDEOCUBE embeds 3 of its rings). ──
/** Ring depth per slot (60 layers, one per recorded frame). */
export const VIDEOCUBE_RING_FRAMES = FRAMETABLE_RING_FRAMES; // 60
/** video_out (+ ring) render resolution — half-res, the SwiftShader/CI budget.
 *  3 rings × ~45 MiB ≈ 135 MiB at the 4:3 default — the spec's memory ceiling. */
export const VIDEOCUBE_RENDER_SCALE = FRAMETABLE_RENDER_SCALE; // 0.5

/** The volumetric ray-march renders at QUARTER engine res into a small
 *  intermediate target, then LINEAR-upscales to the half-res video_out. Marching
 *  at quarter res quarters the per-frame shader-invocation count (the perf lever
 *  the spec calls for — "render the volume at quarter-to-half res") while the
 *  upscaled output keeps the half-res video_out the e2e reads. */
export const VIDEOCUBE_MARCH_SCALE = 0.25;

// ── Renderer-gated ray-march step counts (§4 perf) — the owner chose the SOLID
// (ray-march) look, accepting the GPU cost because the heavy pixel-truth test
// goes through the WebGL ATTEST on a trusted GPU, not the CI SwiftShader shards.
// Still, bound the SOFTWARE cost from a renderer probe: a flat step count that is
// affordable on a real GPU is far too slow on SwiftShader (recorderbox/edges
// class). SOFT=32 on the software renderer (CI), GPU=64 on real hardware.
export const VIDEOCUBE_MARCH_SOFT = 32;
export const VIDEOCUBE_MARCH_GPU = 64;
/** Compile-time upper bound of the shader march loop (uMarch ≤ this). */
export const VIDEOCUBE_MARCH_MAX = VIDEOCUBE_MARCH_GPU;

// ── SPREAD = FrameTable-style temporal WINDOW (owner 2026-07-20). SPREAD no longer
// offsets the audio slice depth (the audio-CUBE heritage); it is now the SAMPLING
// SIZE, TEMPORALLY, of the reader window — how many ring frames are blended into
// each surface. A frozen ring + a widening SPREAD OOZES through time (exactly what
// FRAMETABLE's SMOOTH spread does). The reader (SMOOTH lag / MORPH newest) picks
// the window CENTRE; SPREAD sets its WIDTH; a Hann kernel weights the taps. Both
// the picture surfaces AND the audio reduce read through this window, so the drone
// oozes in lockstep with the image (the "unified field / isomorphic" promise).
// SPREAD=0 collapses to the single centre frame → byte-identical to the pre-window
// read (default look/sound unchanged; only the shader source hash moves). ──
/** SMOOTH temporal-window tap counts (Hann-weighted taps across the ±window).
 *  Renderer-gated exactly like the march steps — fewer taps on the SwiftShader
 *  software renderer (CI), more on a real GPU. Mirrors FRAMETABLE's 4/8 split. */
export const VIDEOCUBE_SMOOTH_TAPS_SOFT = 4;
export const VIDEOCUBE_SMOOTH_TAPS_GPU = 8;
/** Compile-time upper bound of the shader window loop (uWindowTaps ≤ this). */
export const VIDEOCUBE_SMOOTH_TAPS_MAX = VIDEOCUBE_SMOOTH_TAPS_GPU;
/** Below this half-width (frames) the window collapses to the single centre frame,
 *  so SPREAD=0 is byte-identical to the pre-window single-frame read. */
export const VIDEOCUBE_WINDOW_EPS = 1e-3;

/** Beer-Lambert absorption for the front-to-back composite: per-step opacity is
 *  1 − exp(−F · ABSORB · dt). Tuned so a fully-solid column (F≈1) saturates over
 *  a handful of steps → the field reads as a real SOLID, not a faint haze. */
export const VIDEOCUBE_ABSORB = 7.0;

/** Reader trailing-frame lag (frames back from the newest) for the SMOOTH read.
 *  MORPH reads the newest frame (lag 0); CHAOS dithers a per-pixel frame across
 *  the ring window. Kept well inside the 60-frame ring. */
export const VIDEOCUBE_READER_LAG = 6;

/** Rows of the audio field reduction: each ring's reader-selected frame is
 *  reduced to a `FIELD_ROWS`×256 luma heightfield (image-row × phase), stacked as
 *  the three "wavetables" cube-dsp.sampleSlice flies its plane through. 64 =
 *  the canonical e352 frame count, so the audio field matches CUBE's table shape
 *  and the SAME slice-plane reads BOTH the picture volume and the sound. */
export const VIDEOCUBE_FIELD_ROWS = 64;

/** Global reader-mode encoding (one selector for all 3 rings — spec default).
 *  Mirrors FRAMETABLE's mode ints so the two share a mental model. */
export const VIDEOCUBE_MODE_SMOOTH = 0; // trailing single frame (sub-frame lerp), default
export const VIDEOCUBE_MODE_MORPH = 1; // newest frame (crisp, no trailing)
export const VIDEOCUBE_MODE_CHAOS = 2; // per-pixel dithered frame across the window

/** CHAOS is a PER-PIXEL dithered frame in the picture (no single frame). The
 *  audio slice is a 1-D scan of ONE reduced frame, so it can't be per-pixel —
 *  it reads the CHAOS window's REPRESENTATIVE frame, the statistical MEAN of the
 *  per-pixel hash lag (hash·(N−1), uniform on [0,N−1) → mean (N−1)/2). Documented
 *  choice (B3): audio + video read the SAME field per mode; for CHAOS the audio
 *  reads the average of what the picture dithers across. */
export const VIDEOCUBE_CHAOS_REPRESENTATIVE_LAG = Math.round((VIDEOCUBE_RING_FRAMES - 1) / 2); // 30

/**
 * Trailing-frame LAG (frames back from the newest fully-written layer) the reader
 * selects for a given mode — the SINGLE source of truth for BOTH the video march
 * surface pick AND the audio reduce-frame pick, so the two read the SAME temporal
 * frame (the "unified field" promise, B3). Matches the COMBINE shader's per-mode
 * branch exactly:
 *   • MORPH  → 0        (the newest crisp frame)
 *   • SMOOTH → the trailing VIDEOCUBE_READER_LAG frame (LIVE forces 0)
 *   • CHAOS  → the window-mean representative (per-pixel in the picture; the shader
 *              ignores LIVE for CHAOS, so the audio does too)
 */
export function readerLagFor(mode: number, live: boolean): number {
  if (mode === VIDEOCUBE_MODE_CHAOS) return VIDEOCUBE_CHAOS_REPRESENTATIVE_LAG;
  if (live) return 0;
  if (mode === VIDEOCUBE_MODE_MORPH) return 0;
  return VIDEOCUBE_READER_LAG; // SMOOTH (default)
}

// ----------------------------------------------------------------------
// SPREAD temporal window (FrameTable-style). The reader picks the window CENTRE
// (readerLagFor); SPREAD sets its WIDTH; a Hann kernel weights the taps. These
// pure functions are the CPU MIRROR of the SMOOTH/MORPH window the shaders run —
// REDUCE_FRAG (audio) transliterates them 1:1, and COMBINE/SLICE/DEPTH `surfWindow`
// matches for SMOOTH/MORPH. (CHAOS is the one asymmetry, by design B3: the PICTURE
// shaders early-return a single per-pixel frame for CHAOS while the audio reduce
// reads the window MEAN — see readerLagFor's CHAOS note. Both collapse to one frame
// at spread=0.) Unit-testing pins the "oozing through time" semantics.
// ----------------------------------------------------------------------

/**
 * Half-width (in ring frames) of the SPREAD temporal window. SPREAD is a
 * normalized 0..1 knob: `h = 0.5 · spread · (N−1)`, so spread=0 → h=0 (one frame)
 * and spread=1 → h=(N−1)/2 (the window spans nearly the whole ring as one bell) —
 * EXACTLY FRAMETABLE's spread→half-width mapping (its spread is 1..N−1 frames with
 * h=0.5·spread). "The sampling size, temporally, of the window."
 */
export function windowHalfWidth(spreadNorm: number, ringFrames: number = VIDEOCUBE_RING_FRAMES): number {
  return 0.5 * clamp01(spreadNorm) * (ringFrames - 1);
}

/** One temporal tap: a signed frame `offset` from the window centre + its
 *  NORMALIZED Hann weight (the taps' weights sum to 1). */
export interface TemporalTap {
  offset: number;
  weight: number;
}

/**
 * The Hann-weighted temporal window: `taps` bin-centre offsets spanning [−h, +h]
 * (h = windowHalfWidth) with normalized Hann weights (Σw = 1). SPREAD≈0 (h <
 * VIDEOCUBE_WINDOW_EPS) OR taps ≤ 1 collapses to the single centre tap
 * `{offset:0, weight:1}` — the exact single-frame read the pre-window reader did,
 * so SPREAD=0 is byte-identical. Bin-centre sampling (`off_k = −h + 2h·(k+0.5)/T`)
 * keeps every tap weight > 0 (no wasted end taps). Deterministic + symmetric.
 */
export function temporalWindow(
  spreadNorm: number,
  taps: number,
  ringFrames: number = VIDEOCUBE_RING_FRAMES,
): TemporalTap[] {
  const h = windowHalfWidth(spreadNorm, ringFrames);
  const T = Math.floor(taps);
  if (T <= 1 || h < VIDEOCUBE_WINDOW_EPS) return [{ offset: 0, weight: 1 }];
  const out: TemporalTap[] = [];
  let wsum = 0;
  for (let k = 0; k < T; k++) {
    const off = -h + (2 * h * (k + 0.5)) / T;
    const w = 0.5 * (1 + Math.cos((Math.PI * off) / h)); // Hann — peak 1 at centre
    out.push({ offset: off, weight: w });
    wsum += w;
  }
  const inv = wsum > 0 ? 1 / wsum : 0;
  for (const t of out) t.weight *= inv;
  return out;
}

/**
 * The windowed temporal average of a ring at one point: sum the Hann-weighted
 * taps around `centreLayer`, reading each via the caller's `sampleAt(layer)` (a
 * fractional, ring-wrapped layer sampler). The CPU mirror of the shader's
 * `surfWindow`; the unit tests drive it with a synthetic ring to pin that a wide
 * SPREAD genuinely blends more of the ring (oozes) while SPREAD=0 is the single
 * centre sample.
 */
export function sampleTemporalWindow(
  sampleAt: (layer: number) => number,
  centreLayer: number,
  spreadNorm: number,
  taps: number,
  ringFrames: number = VIDEOCUBE_RING_FRAMES,
): number {
  const win = temporalWindow(spreadNorm, taps, ringFrames);
  let acc = 0;
  for (const t of win) acc += t.weight * sampleAt(centreLayer + t.offset);
  return acc;
}

/** Surface-texture tiling factor when WRAP is ON — the source videos mirror-tile
 *  this many times across the cube. 2 = one mirror fold per axis (a kaleidoscopic
 *  seam at the cube mid-planes / faces). */
export const VIDEOCUBE_WRAP_TILES = 2.0;

/**
 * Warp a SURFACE-texture uv coordinate by WRAP (the video analog of the audio
 * slice's out-of-range mirror-fold). WRAP OFF clamps to the cube face (identity
 * for an in-range coord → the pre-WRAP look is byte-identical). WRAP ON extends
 * the sampling domain by VIDEOCUBE_WRAP_TILES and mirror-folds it, so the source
 * videos MIRROR-TILE across the cube (visibly different at the faces) — the fix
 * for "WRAP does nothing to the picture" (B1). Mirrors the COMBINE shader's
 * surface-uv branch 1:1.
 *
 * (Distinct from `warpCoord`, which is the FIELD-lookup coord warp — the DEPTH
 * axis z and the audio slice ray — where cube-dsp already mirror-folds coords
 * that genuinely leave [0,1].)
 */
export function wrapSurfaceCoord(coord: number, wrap: boolean): number {
  return wrap ? wrapFold(coord * VIDEOCUBE_WRAP_TILES) : clamp01(coord);
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

// ----------------------------------------------------------------------
// Scalar helpers (transliterated 1:1 into GLSL).
// ----------------------------------------------------------------------

/** Rec.601 luma of an RGB in [0,1] → [0,1]. The occupancy "height" the field
 *  reads out of a surface colour (the video meaning of a wavetable height). */
export function luma(r: number, g: number, b: number): number {
  return clamp01(0.299 * r + 0.587 * g + 0.114 * b);
}

/**
 * Posterize an RGB to `crushLevels(k)` discrete levels per channel — the video
 * meaning of CUBE's amplitude CRUSH (the SAME `crushLevels` curve, so the picture
 * quantizes exactly as the derived audio does). k=0 = identity.
 */
export function posterize(c: RGB, crushK: number): RGB {
  const k = clamp01(crushK);
  if (k <= 0) return c;
  const levels = crushLevels(k);
  if (levels >= 256) return c;
  const q = (v: number) => Math.round(clamp01(v) * (levels - 1)) / (levels - 1);
  return { r: q(c.r), g: q(c.g), b: q(c.b) };
}

// ----------------------------------------------------------------------
// SPACE CRUSH (voxelize) + CRUSH (spatial coord-snap) + WRAP — applied to each
// (x,y,z) field-lookup coordinate BEFORE the surface reads, EXACTLY as cube-dsp
// voxelizes the field-lookup coords along a slice ray (rayDepth composes
// crushCoord(spaceCrushCoord(coord, sc), crush)). SPACE DIFFUSE is per-AXIS
// (toward the field's lowestInfoFace) so it is applied by the caller, not here.
// WRAP mirror-folds an out-of-range coord; otherwise the coord clamps.
// ----------------------------------------------------------------------

/** Warp one FIELD-lookup coordinate (the DEPTH axis z, and the audio slice ray):
 *  SPACE CRUSH voxelize, then CRUSH spatial snap, then WRAP mirror-fold (or
 *  clamp). Composition order + the underlying cube-dsp functions match the GLSL
 *  1:1. NOTE: the picture's SURFACE uv (x,y) uses `wrapSurfaceCoord` instead —
 *  its in-cube coords never leave [0,1], so WRAP tiles the sampling domain there
 *  to stay visible (B1); the depth/audio coords here genuinely can leave [0,1]. */
export function warpCoord(
  coord: number,
  spaceCrush: number,
  crushK: number,
  wrap: boolean,
): number {
  const c = crushCoord(spaceCrushCoord(coord, spaceCrush), crushK);
  return wrap ? wrapFold(c) : clamp01(c);
}

// ----------------------------------------------------------------------
// The per-voxel FIELD SAMPLE — the heart of the volumetric ray-march. Given the
// three SURFACE colours read at a field (x,y) and the depth z, return the field
// DENSITY (occupancy → alpha) and the occupancy-weighted source COLOUR (→ the
// solid's texture). This is the video isomorph of cube-dsp's field: the density
// is byte-for-byte `fieldFromHeights`; the colour is the analog CUBE's audio has
// no need for.
// ----------------------------------------------------------------------

export interface VoxelParams {
  /** MORPH FC m ∈ [0,1]: cross-fade the FLOOR-fill (A) toward the CEILING-fill (C)
   *  through the WALL (B). */
  morphFC: number;
  /** CONNECTION MORPH ∈ [0,1]: circle arc ↔ sawtooth-V connector profile. */
  connect: number;
  /** CONNECT STRENGTH ∈ [0,1]: overshoot the connector's base swell. */
  connectStrength: number;
  /** SMOOTH = continuous translucent density + soft A/B/C blend; HARD = binary
   *  solid + one-surface-wins colour. */
  material: Material;
  /** CRUSH ∈ [0,1]: posterize the colour + amplitude-crush the density. */
  crush: number;
}

export interface VoxelSample {
  /** Field occupancy density ∈ [0,1] (→ the composite alpha). Byte-for-byte
   *  cube-dsp.fieldFromHeights, then amplitude-crushed by CRUSH. */
  density: number;
  /** The occupancy-weighted source colour at this voxel (→ the solid's texture),
   *  posterized by CRUSH. */
  color: RGB;
}

/**
 * Sample the 3D field at depth z given the three surface colours (cA/cB/cC =
 * FLOOR/WALL/CEILING) read at one (x,y). Mirrors the GLSL ray-march step:
 *
 *   floorH/wallH/ceilH = luma(cA)/luma(cB)/luma(cC)      surface heights
 *   dF = occ(z; floorH, wallH, connect, cs)              floor→wall fill
 *   dC = occ(z; ceilH,  wallH, connect, cs)              ceiling→wall fill
 *   density = fieldFromHeights(z; …) = (1−m)·dF + m·dC   (HARD → 0/1 @ 0.5)
 *   wf = dF·(1−m),  wc = dC·m,  wWall = clamp(1 − (dF+dC))
 *   colour = SMOOTH: (wf·cA + wc·cC + wWall·cB)/Σ  |  HARD: the max-weight surface
 *
 * `z` is a GENUINE depth axis (0 = cube floor, 1 = ceiling), so the solid fills
 * the volume BETWEEN the three videos — connecting them through space exactly as
 * three wavetables connect in the audio cube. CRUSH posterizes the colour and
 * amplitude-crushes the density.
 */
export function voxelSample(
  cA: RGB,
  cB: RGB,
  cC: RGB,
  z: number,
  p: VoxelParams,
): VoxelSample {
  const floorH = luma(cA.r, cA.g, cA.b);
  const wallH = luma(cB.r, cB.g, cB.b);
  const ceilH = luma(cC.r, cC.g, cC.b);
  const m = clamp01(p.morphFC);
  const cs = clamp01(p.connectStrength);

  // DENSITY — byte-for-byte the audio-CUBE field (reuse fieldFromHeights so the
  // picture's solidity and the sound's slice-depth agree exactly).
  const fp: FieldParams = {
    morphFC: m,
    connect: p.connect,
    connectStrength: cs,
    material: p.material,
  };
  const densityRaw = fieldFromHeights(z, { floorH, wallH, ceilH }, fp);
  const density = crush(densityRaw, p.crush);

  // COLOUR weights — the occupancy shares of the FLOOR-fill (A), CEILING-fill (C)
  // and the WALL/connector (B) at this depth.
  const dF = occ(z, floorH, wallH, p.connect, cs);
  const dC = occ(z, ceilH, wallH, p.connect, cs);
  const wf = dF * (1 - m);
  const wc = dC * m;
  const wWall = clamp01(1 - (dF + dC));

  let color: RGB;
  if (p.material === 'hard') {
    if (wWall >= wf && wWall >= wc) color = { ...cB };
    else if (wf >= wc) color = { ...cA };
    else color = { ...cC };
  } else {
    const denom = Math.max(wf + wc + wWall, 1e-3);
    color = {
      r: (wf * cA.r + wc * cC.r + wWall * cB.r) / denom,
      g: (wf * cA.g + wc * cC.g + wWall * cB.g) / denom,
      b: (wf * cA.b + wc * cC.b + wWall * cB.b) / denom,
    };
  }
  return { density, color: posterize(color, p.crush) };
}

// ----------------------------------------------------------------------
// SPACE DIFFUSE target — the field's lowest-information face the cloud is pulled
// toward. Computed on the reduced heightfields (the SAME field the audio reads),
// so the picture's diffuse gravity and the sound's agree. Thin wrapper over
// cube-dsp.lowestInfoFace, latched on the field (not the diffuse amount).
// ----------------------------------------------------------------------

/** The default gravity face when the field has no clear emptiest wall (re-export
 *  of cube-dsp's default target: the top / z-high). */
export const VIDEOCUBE_DIFFUSE_DEFAULT: DiffuseTarget = DIFFUSE_DEFAULT_TARGET;

/**
 * The SPACE DIFFUSE gravity face for the 3-surface field, from the reduced
 * heightfields (FLOOR/WALL/CEILING as `Float32Array[rows]` of 256, the audio
 * field). Deterministic; depends only on the field + morph/connect, not the
 * diffuse amount.
 */
export function diffuseTargetFor(
  floorH: readonly Float32Array[],
  wallH: readonly Float32Array[],
  ceilH: readonly Float32Array[],
  p: { morphFC: number; connect: number; connectStrength: number; material: Material },
): DiffuseTarget {
  if (!floorH.length || !wallH.length || !ceilH.length) return VIDEOCUBE_DIFFUSE_DEFAULT;
  return lowestInfoFace(floorH, wallH, ceilH, {
    morphFC: clamp01(p.morphFC),
    connect: p.connect,
    connectStrength: clamp01(p.connectStrength),
    material: p.material,
  });
}

// ----------------------------------------------------------------------
// Audio derivation — reduce ONE reader-selected ring frame to a luma HEIGHTFIELD
// (image-row × phase) for cube-dsp.sampleSlice. The three surfaces stacked in z
// are the SAME field the ray-march textures, so slice Y / ROT drive ONE plane
// through BOTH the picture volume and the derived sound.
// ----------------------------------------------------------------------

/**
 * Reduce a ring's single-frame REDUCE-pass readback — a `rows`×`cols` RGBA8 strip
 * (row-major: `rows` image rows of `cols` luma pixels, sampled across ONE
 * reader-selected frame) — to a `Float32Array[rows]` of `cols` samples in
 * [-1,1], shaped exactly like an e352 wavetable (rows = image-y axis, cols =
 * image-x/phase axis). Fed straight into cube-dsp.sampleSlice so the derived
 * audio is the audio-CUBE engine sourced from the SAME video surface the picture
 * marches. Empty/short strips → zero rows (silent, never NaN).
 */
export function stripToHeightfield(
  strip: Uint8Array | Uint8ClampedArray,
  cols: number,
  rows: number,
): Float32Array[] {
  const out: Float32Array[] = [];
  for (let f = 0; f < rows; f++) out.push(new Float32Array(cols));
  return stripToHeightfieldInto(strip, cols, rows, out);
}

/**
 * Allocation-free variant of `stripToHeightfield`: fills a PERSISTENT
 * `Float32Array[rows]` (each length `cols`) in place and returns it, so the
 * audio-slice readback path can reuse one scratch heightfield across recomputes
 * instead of allocating `rows` new Float32Arrays every call (B2 — no per-frame
 * allocation on the hot path). Rows missing from `out` are created once (first
 * call); short rows are left untouched. Same math as `stripToHeightfield`.
 */
export function stripToHeightfieldInto(
  strip: Uint8Array | Uint8ClampedArray,
  cols: number,
  rows: number,
  out: Float32Array[],
): Float32Array[] {
  for (let f = 0; f < rows; f++) {
    let row = out[f];
    if (!row || row.length !== cols) { row = new Float32Array(cols); out[f] = row; }
    for (let x = 0; x < cols; x++) {
      const i = (f * cols + x) * 4;
      row[x] = i + 2 < strip.length
        ? luma((strip[i] ?? 0) / 255, (strip[i + 1] ?? 0) / 255, (strip[i + 2] ?? 0) / 255) * 2 - 1
        : 0;
    }
  }
  return out;
}

// Re-export the HARD threshold so tests can reason about the SMOOTH↔HARD cut
// without reaching into cube-dsp.
export { HARD_THRESHOLD };
