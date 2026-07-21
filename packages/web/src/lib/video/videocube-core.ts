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

/**
 * SCAN offset (in ring frames) — the video analog of FRAMETABLE's MORPH knob.
 * SCAN is a normalized 0..1 knob that MOVES the reading CENTRE through the whole
 * 60-frame ring: `scan·(N−1)` frames further back from the reader's per-mode
 * trailing centre (readerLagFor), wrapping at the ring seam. scan=0 → 0 (NO
 * offset ⇒ the reader centre is exactly today's, byte-identical); scan=1 →
 * (N−1), a full sweep across the ring (wraps back to the same layer). Where
 * SPREAD sets the WIDTH of the temporal window, SCAN sets its POSITION — together
 * they reach FRAMETABLE's morph/spread 1:1: a FROZEN ring can be oozed AND
 * scrubbed through its ~2 seconds of captured frames.
 */
export function scanOffsetFrames(scan: number, ringFrames: number = VIDEOCUBE_RING_FRAMES): number {
  return clamp01(scan) * (ringFrames - 1);
}

/**
 * The reader window CENTRE layer (fractional, ring-wrapped into [0, N)) for a
 * given mode + LIVE + SCAN, from the newest fully-written layer. Composes the
 * per-mode trailing lag (readerLagFor) with the SCAN offset (scanOffsetFrames)
 * exactly as the shaders do inline — `centre = newest − lag(mode) − scan·(N−1)`,
 * wrapped — and is the SINGLE source of truth for the AUDIO reduce frame pick, so
 * SCAN moves the picture surfaces AND the derived drone through the ring in
 * lockstep (the unified-field promise, B3). scan=0 ⇒ `newest − lag(mode)` wrapped
 * = the pre-scan centre (byte-identical). CHAOS reduces its window-mean
 * representative (readerLagFor), then SCAN shifts that base the same way it shifts
 * the picture's per-pixel dither base.
 */
export function readerCentreLayer(
  newest: number,
  mode: number,
  live: boolean,
  scan: number,
  ringFrames: number = VIDEOCUBE_RING_FRAMES,
): number {
  const lag = readerLagFor(mode, live) + scanOffsetFrames(scan, ringFrames);
  return (((newest - lag) % ringFrames) + ringFrames) % ringFrames;
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

// ══════════════════════════════════════════════════════════════════════════
// CHROMASTACK — dynamic CHROMA → timbre derivation (owner 2026-07-20).
//
// VIDEOCUBE's audio was too static: the luma cube carrier (Ws) barely moved with
// the picture's COLOUR ("video content doesn't change the audio much"). CHROMASTACK
// keeps that luma ray-march as the structural CARRIER and LAYERS a HUE → TIMBRE
// morph on top, so a colour change AUDIBLY drives the sound while a GRAYSCALE frame
// stays byte-identical to today's luma-only drone (the clean fallback).
//
// The ONLY GPU change is REDUCE_FRAG writing `vec4(c.rgb, lm)` (colour in .rgb,
// Rec.601 luma in .a) so the audio readback carries COLOUR — zero extra cost, the
// RGB was already in the bytes. Everything below is PURE + deterministic (jsdom):
//
//   rgbStripToHueHist  RGB→HSV, an 8-bin hue histogram weighted by sat·val, plus
//                      mean saturation (dry/wet), mean value (level) and the
//                      weighted-mean hue-bin (the tilt/brightness position).
//   colorMorphWave     blend 8 band-limited harmonic ARCHETYPES by the hue weights
//                      + a hue-centroid spectral TILT — so a PURE hue rotation at
//                      CONSTANT luma sweeps the spectral centroid (the axis that is
//                      silent today; the "not-subtle" guarantee).
//   combineCarrierChroma  fuse the chroma morph onto the carrier: mix by
//                      saturation·depth, drive by brightness + MOTION, DC-remove.
//   motionEnergy       frame-to-frame RGB change → an "alive" energy the MOTION
//                      amount blends into the drive (static colourful frame still
//                      sounds rich; MOTION 0 ⇒ pure content).
//
// TWO BANKS (a CV-gated toggle picks one): MUSICAL (tonal: red=root/dark/hollow →
// violet=bright/rich) and INSTRUMENT (warm=analog-ish → cool=digital-ish). Both are
// ordered by monotone spectral centroid so the hue axis reads as a brightness ramp.
//
// NOTE (attest): this file lives under lib/video/, so it IS in the WebGL attest
// basis (resolveWebglBasis sweeps the whole tree minus *.test.ts) — these pure
// additions fold into the SAME one-time WebGL re-attest REDUCE_FRAG already forces;
// they are NOT shaders and add no GPU cost.
// ══════════════════════════════════════════════════════════════════════════

/** Hue bins == harmonic archetypes per bank (one archetype per hue sextant-ish). */
export const CHROMA_HUE_BINS = 8;
/** Archetype table length — matches CUBE_SLICE_SIZE / the posted wave length. */
export const CHROMA_ARCH_LEN = 256;
/** Max harmonic partials per archetype (band-limited: 32 ≪ the 128 Nyquist). */
export const CHROMA_ARCH_PARTIALS = 32;
/** Peak amplitude each archetype table is normalized to (kept < 1 so blends stay
 *  bounded before shapeInto RMS-matches them to the carrier). */
export const CHROMA_ARCH_PEAK = 0.9;
/** Strength of the hue-centroid spectral tilt (± high-harmonic emphasis added as a
 *  scaled circular derivative of the blend). */
export const CHROMA_TILT_STRENGTH = 0.6;
/** How hard full frame-to-frame MOTION drives loudness at full MOTION amount
 *  (motionEnergy is a small mean |Δ|, so the gain makes it audible when turned up). */
export const CHROMA_MOTION_DRIVE_GAIN = 4.0;

/** The reduced-strip colour summary CHROMASTACK maps to timbre. */
export interface HueHistogram {
  /** Per-bin hue weight (Σ sat·val over pixels in that bin); NOT pre-normalized. */
  hueWeights: Float32Array;
  /** Mean HSV saturation over the strips ∈ [0,1] — the dry/wet chroma amount. */
  meanSat: number;
  /** Mean HSV value/brightness over the strips ∈ [0,1] — the level drive. */
  meanVal: number;
  /** Weighted-mean hue-BIN position ∈ [0,1] (0 = red/dark end, 1 = violet/bright
   *  end). LINEAR (not circular): the hue axis is treated as the red→violet
   *  brightness ramp the banks are ordered along. 0.5 (neutral) when colourless. */
  centroidHue: number;
}

// ── Archetype bank synthesis (module-load, pure). Each table is an inverse-DFT of
//    harmonic-series partials at phase 0 → seamlessly periodic (period 256) and
//    exactly zero-mean (no k=0 term), then peak-normalized. ──
function synthArchetype(amp: (k: number) => number): Float32Array {
  const t = new Float32Array(CHROMA_ARCH_LEN);
  for (let k = 1; k <= CHROMA_ARCH_PARTIALS; k++) {
    const a = amp(k);
    if (a === 0) continue;
    const w = (2 * Math.PI * k) / CHROMA_ARCH_LEN;
    for (let n = 0; n < CHROMA_ARCH_LEN; n++) t[n]! += a * Math.sin(w * n);
  }
  let peak = 0;
  for (let n = 0; n < CHROMA_ARCH_LEN; n++) peak = Math.max(peak, Math.abs(t[n]!));
  if (peak > 0) {
    const g = CHROMA_ARCH_PEAK / peak;
    for (let n = 0; n < CHROMA_ARCH_LEN; n++) t[n]! *= g;
  }
  return t;
}

function buildBank(spec: (bin: number, k: number) => number): Float32Array[] {
  const bank: Float32Array[] = [];
  for (let b = 0; b < CHROMA_HUE_BINS; b++) bank.push(synthArchetype((k) => spec(b, k)));
  return bank;
}

/** MUSICAL bank — red (bin 0) = ROOT/DARK/HOLLOW (odd-biased, steep rolloff → few
 *  low harmonics), violet (bin 7) = BRIGHT/RICH (full series, shallow rolloff).
 *  Monotone spectral centroid across the 8. */
export const CHROMA_BANK_MUSICAL: readonly Float32Array[] = buildBank((bin, k) => {
  const bright = bin / (CHROMA_HUE_BINS - 1);         // 0 dark .. 1 bright
  const p = 2.6 + (0.6 - 2.6) * bright;               // steep → shallow rolloff
  const evenGain = 0.15 + (1.0 - 0.15) * bright;      // hollow(odd) → full(rich)
  const g = k % 2 === 0 ? evenGain : 1.0;
  return g / Math.pow(k, p);
});

/** INSTRUMENT bank — warm (bin 0) = ANALOG-ish (soft, full gentle saw series), cool
 *  (bin 7) = DIGITAL-ish (harsher, odd-biased buzz, shallow rolloff). A distinct
 *  character from MUSICAL; also monotone spectral centroid. */
export const CHROMA_BANK_INSTRUMENT: readonly Float32Array[] = buildBank((bin, k) => {
  const cool = bin / (CHROMA_HUE_BINS - 1);           // 0 warm/analog .. 1 cool/digital
  const p = 1.4 + (0.5 - 1.4) * cool;                 // analog soft → digital flat
  const oddBoost = k % 2 === 1 ? 1.0 + 0.7 * cool : Math.max(0, 1.0 - 0.35 * cool);
  return oddBoost / Math.pow(k, p);
});

/** Pick a bank by mode int: 0 = MUSICAL (default), 1 = INSTRUMENT. */
export function chromaBank(mode: number): readonly Float32Array[] {
  return Math.round(mode) >= 1 ? CHROMA_BANK_INSTRUMENT : CHROMA_BANK_MUSICAL;
}

/**
 * Reduce one or more RGBA readback strips (the REDUCE-pass output — `.rgb` = the
 * source colour, `.a` = Rec.601 luma) to a hue HISTOGRAM: an 8-bin hue tally
 * weighted by HSV sat·val (so vivid, bright pixels dominate the colour identity),
 * plus mean saturation (dry/wet), mean value (level) and the weighted-mean hue-bin
 * (the brightness/tilt position). A grayscale strip has saturation 0 everywhere →
 * meanSat 0 and all-zero hue weights → the chroma layer contributes nothing (the
 * byte-identical luma fallback). Deterministic; reads every RGB pixel of every strip.
 */
export function rgbStripToHueHist(
  strips: readonly (Uint8Array | Uint8ClampedArray)[],
): HueHistogram {
  const hueWeights = new Float32Array(CHROMA_HUE_BINS);
  let sumW = 0, sumS = 0, sumV = 0, count = 0;
  for (const strip of strips) {
    const len = strip.length - (strip.length % 4);
    for (let i = 0; i < len; i += 4) {
      const r = (strip[i] ?? 0) / 255;
      const g = (strip[i + 1] ?? 0) / 255;
      const b = (strip[i + 2] ?? 0) / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const delta = mx - mn;
      const v = mx;
      const s = mx > 0 ? delta / mx : 0;
      let h = 0;
      if (delta > 1e-6) {
        if (mx === r) h = ((g - b) / delta) % 6;
        else if (mx === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
        h /= 6;
        if (h < 0) h += 1; // [0,1)
      }
      const w = s * v;
      const bin = Math.min(CHROMA_HUE_BINS - 1, Math.floor(h * CHROMA_HUE_BINS));
      hueWeights[bin]! += w;
      sumW += w;
      sumS += s;
      sumV += v;
      count++;
    }
  }
  const meanSat = count > 0 ? sumS / count : 0;
  const meanVal = count > 0 ? sumV / count : 0;
  let centroidHue = 0.5;
  if (sumW > 1e-9) {
    let binSum = 0;
    for (let b = 0; b < CHROMA_HUE_BINS; b++) binSum += b * hueWeights[b]!;
    centroidHue = binSum / sumW / (CHROMA_HUE_BINS - 1); // [0,1]
  }
  return { hueWeights, meanSat, meanVal, centroidHue };
}

/**
 * The chroma MORPH wave Wc from a hue histogram + a bank: a linear blend of the 8
 * harmonic archetypes by the normalized hue weights, PLUS a hue-centroid spectral
 * TILT. The tilt adds a scaled CIRCULAR DERIVATIVE of the blend (which boosts each
 * partial ∝ its harmonic number) so a brighter dominant hue lifts the spectral
 * centroid and a darker one lowers it — this is what makes a PURE hue rotation at
 * constant luma AUDIBLY sweep the timbre (the axis that is silent today). Zero-mean
 * and band-limited by construction; returns all-zeros when there is no colour.
 */
export function colorMorphWave(hist: HueHistogram, bank: readonly Float32Array[]): Float32Array {
  const N = CHROMA_ARCH_LEN;
  const out = new Float32Array(N);
  const w = hist.hueWeights;
  let sw = 0;
  for (let b = 0; b < w.length; b++) sw += w[b]!;
  if (sw <= 1e-9) return out; // colourless → silent chroma (Ws-only upstream)
  for (let b = 0; b < w.length && b < bank.length; b++) {
    const wb = w[b]! / sw;
    if (wb === 0) continue;
    const tbl = bank[b]!;
    for (let n = 0; n < N; n++) out[n]! += wb * tbl[n]!;
  }
  const tilt = (hist.centroidHue - 0.5) * 2 * CHROMA_TILT_STRENGTH; // [-S, +S]
  if (tilt !== 0) {
    const base = Float32Array.from(out);
    for (let n = 0; n < N; n++) {
      const d = (base[(n + 1) % N]! - base[(n - 1 + N) % N]!) * 0.5; // circular central diff
      out[n] = base[n]! + tilt * d;
    }
  }
  return out;
}

function rmsOf(wave: Float32Array): number {
  let s = 0;
  for (let i = 0; i < wave.length; i++) { const v = wave[i]!; s += v * v; }
  return Math.sqrt(s / (wave.length || 1));
}

/**
 * "Shape" the chroma morph Wc INTO the carrier Ws: RMS-match Wc to Ws so the chroma
 * layer carries the carrier's LEVEL (the morph never jumps the loudness as it mixes
 * in) while KEEPING its own spectral identity (RMS scaling is amplitude-only, so the
 * hue-driven spectral centroid survives). Returns a fresh array. Wc ≈ 0 → zeros.
 */
export function shapeInto(wc: Float32Array, ws: Float32Array): Float32Array {
  const out = new Float32Array(wc.length);
  const rc = rmsOf(wc);
  if (rc < 1e-9) return out;
  const g = rmsOf(ws) / rc;
  for (let i = 0; i < wc.length; i++) out[i] = wc[i]! * g;
  return out;
}

/**
 * Fuse the chroma morph Wc onto the luma carrier Ws into the final posted wave:
 *
 *   wet   = meanSat · chromaDepth            how much chroma REPLACES the carrier
 *   body  = mix(Ws, shapeInto(Wc, Ws), wet) per-sample morph (level-matched)
 *   drive = bright · motionDrive            brightness (gated by wet) + MOTION
 *   final = DC-remove(body · drive)
 *
 * Fallback (owner-locked): a GRAYSCALE frame has meanSat 0 → wet 0 → body = Ws, and
 * the brightness drive is gated by wet (so grayscale ≠ dimmed), so with the default
 * MOTION amount 0 the output is BYTE-IDENTICAL to the luma-only carrier. chromaDepth
 * 0 is the master off switch (wet 0 for any frame). DC-removal (anti-click on bold
 * swaps) is applied ONLY when chroma is active — the pure carrier is left exactly as
 * today (which does not DC-remove). MOTION is a SEPARATE axis (gated by motionAmt,
 * not saturation) so a moving grayscale can still gain "alive" energy when turned up.
 */
export function combineCarrierChroma(
  ws: Float32Array,
  wc: Float32Array,
  meanSat: number,
  meanVal: number,
  motion: number,
  motionAmt: number,
  chromaDepth: number,
): Float32Array {
  const N = ws.length;
  const out = new Float32Array(N);
  const wet = clamp01(meanSat) * clamp01(chromaDepth);
  const motionDrive = 1 + clamp01(motionAmt) * clamp01(motion) * CHROMA_MOTION_DRIVE_GAIN;
  if (wet <= 0) {
    // Grayscale / chroma off → the pure luma carrier. Only the separately-gated
    // MOTION drive applies (default motion/amt 0 → 1 → byte-identical fallback).
    if (motionDrive === 1) { out.set(ws); return out; }
    for (let i = 0; i < N; i++) out[i] = ws[i]! * motionDrive;
    return out;
  }
  const bright = 1 + wet * (clamp01(meanVal) - 1); // grayscale-safe brightness→level
  const drive = bright * motionDrive;
  const shaped = shapeInto(wc, ws);
  for (let i = 0; i < N; i++) out[i] = (ws[i]! * (1 - wet) + shaped[i]! * wet) * drive;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += out[i]!;
  mean /= N || 1;
  for (let i = 0; i < N; i++) out[i]! -= mean;
  return out;
}

/**
 * Frame-to-frame MOTION energy: the mean absolute per-channel RGB difference
 * between the previous and current reduced strips, normalized to [0,1] (RGB carries
 * BOTH luma and chroma change). 0 for identical frames; grows with picture change.
 * Deterministic. Fed to combineCarrierChroma as the "alive" drive.
 */
export function motionEnergy(
  prev: readonly (Uint8Array | Uint8ClampedArray)[],
  cur: readonly (Uint8Array | Uint8ClampedArray)[],
): number {
  let sum = 0, n = 0;
  const rings = Math.min(prev.length, cur.length);
  for (let s = 0; s < rings; s++) {
    const a = prev[s]!, b = cur[s]!;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i + 2 < len; i += 4) {
      sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
      sum += Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0));
      sum += Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
      n += 3;
    }
  }
  return n > 0 ? sum / n / 255 : 0;
}
