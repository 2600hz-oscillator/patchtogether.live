// packages/web/src/lib/video/videocube-core.ts
//
// VIDEOCUBE — pure math CORE. Every function here is the CPU MIRROR of the GLSL
// COMBINE shader in ./modules/videocube.ts (the FRAMETABLE / cube-dsp
// source-of-truth discipline): unit-testing them pins the semantics the shader
// transliterates 1:1. NO WebGL in this file — it runs in jsdom.
//
// VIDEOCUBE is the VIDEO isomorph of the audio CUBE oscillator. It ingests THREE
// 60-frame video rings (A/B/C = FLOOR/WALL/CEILING) and combines them the way
// CUBE combines its three wavetables into one output: an OCCUPANCY-WEIGHTED
// trilinear morph. The occupancy structure (occ / MORPH FC / CONNECT / CONNECT
// STRENGTH / CRUSH / SPACE CRUSH / SPACE DIFFUSE / WRAP) is the EXACT audio-CUBE
// field math from `cube-dsp.ts` — reused wholesale so a single knob drives BOTH
// the picture (this GLSL-mirrored combine) AND the timbre (cube-dsp.sampleSlice
// fed luma-reduced rings, see ./modules/videocube.ts §audio). This file only adds
// what CUBE's audio field has no analog for: the per-pixel COLOUR blend and the
// ring→luma-heightfield reduction that feeds the audio scan.
//
// The per-slot temporal ring READ (SMOOTH weighted average / CHAOS single pick /
// lag / first-fill) is NOT re-derived here — it is FRAMETABLE's machinery
// (frametable-core.ts: smoothCentre, selectOffset, sampleRingLerp, advanceHead,
// fillOnFirstFrame), reused verbatim by both the shader and its own unit tests.

import {
  clamp01,
  occ,
  crushLevels,
  spaceCrushCoord,
  diffusePull,
  wrapFold,
} from '../../../../dsp/src/lib/cube-dsp';
import {
  FRAMETABLE_RING_FRAMES,
  FRAMETABLE_RENDER_SCALE,
} from './frametable-core';

// ── Ring geometry — reuse FRAMETABLE's constants (VIDEOCUBE embeds 3 of its rings). ──
/** Ring depth per slot (60 layers, one per recorded frame). */
export const VIDEOCUBE_RING_FRAMES = FRAMETABLE_RING_FRAMES; // 60
/** Reduced render resolution (half-res, SwiftShader/CI budget). 3 rings × 45 MiB
 *  ≈ 135 MiB at the 4:3 default — the spec's flagged memory ceiling. */
export const VIDEOCUBE_RENDER_SCALE = FRAMETABLE_RENDER_SCALE; // 0.5

// ── Renderer-gated combine tap counts (§4 perf) — the FrameTable budget ×3. ──
// The COMBINE reads all THREE rings per output pixel; each SMOOTH read is T taps
// × 2 array fetches. T=8 GPU (48 fetches) / T=4 SwiftShader (24 fetches) — a flat
// pixel/perf assert that passes on a GPU goes red on the CI software renderer, so
// the software cost is bounded from a renderer probe (recorderbox/edges class).
export const VIDEOCUBE_TAPS_GPU = 8;
export const VIDEOCUBE_TAPS_SOFT = 4;

/** Fixed reader window (frames). VIDEOCUBE keeps CUBE's control layout, so it does
 *  NOT expose FrameTable's per-frame MORPH/SPREAD knobs — the reader scans a
 *  moderate trailing window near the newest frames and the per-pixel temporal
 *  offset comes from the SLICE Y / ROT field (videoField below). */
export const VIDEOCUBE_READ_MORPH = 0;
export const VIDEOCUBE_READ_SPREAD = 12;

/** Global reader-mode encoding (one selector for all 3 rings — spec default).
 *  Mirrors FRAMETABLE's mode ints so the two share a mental model. */
export const VIDEOCUBE_MODE_SMOOTH = 0; // weighted temporal average + per-pixel field (default)
export const VIDEOCUBE_MODE_MORPH = 1;  // spatially-uniform temporal average (field flattened)
export const VIDEOCUBE_MODE_CHAOS = 2;  // per-pixel single-frame pick (dither/mosaic)

/** SLICE-field temporal displacement amplitude, in FRAMES (the per-pixel read
 *  centre is offset by up to ±this). N/4 keeps the shear well inside the ring. */
export const VIDEOCUBE_FIELD_FRAMES = VIDEOCUBE_RING_FRAMES / 4; // 15

export interface RGB {
  r: number;
  g: number;
  b: number;
}

// ----------------------------------------------------------------------
// Scalar helpers (transliterated 1:1 into GLSL).
// ----------------------------------------------------------------------

/** Rec.601 luma of an RGB in [0,1] → [0,1]. The occupancy coordinate the combine
 *  reads out of a colour (the video meaning of "height" in the audio field). */
export function luma(r: number, g: number, b: number): number {
  return clamp01(0.299 * r + 0.587 * g + 0.114 * b);
}

// ----------------------------------------------------------------------
// SLICE field — the per-pixel temporal-offset gradient (the video meaning of the
// slice tilt). At the defaults (sliceY=0.5, rx=ry=rz=0) the field is EXACTLY 0
// everywhere ⇒ a uniform temporal read ⇒ a stable morphable image. Raising Y
// tilts a vertical time-gradient across the frame; the rotations add a
// directional temporal SHEAR. MORPH mode flattens this to 0 (spatially uniform).
// ----------------------------------------------------------------------

/**
 * Per-pixel temporal displacement (FRAMES) for output pixel (ux,uy) ∈ [0,1]²,
 * given SLICE Y ∈ [0,1] and the three plane rotations rx/ry/rz (±π). `ampFrames`
 * scales the whole field. Continuous + 0 at the neutral slice (Y=0.5, no
 * rotation), so a default VIDEOCUBE reads a clean, still combine.
 */
export function videoField(
  ux: number,
  uy: number,
  sliceY: number,
  rx: number,
  ry: number,
  rz: number,
  ampFrames: number,
): number {
  const gx = ux - 0.5;
  const gy = uy - 0.5;
  const yTilt = (sliceY - 0.5) * 2; // 0 at the centred slice
  return (
    ampFrames *
    (yTilt * gy + Math.sin(rx) * gx + Math.sin(ry) * gy + Math.sin(rz) * (gx * gy) * 2)
  );
}

// ----------------------------------------------------------------------
// SPACE CRUSH (mosaic) + SPACE DIFFUSE (warp) — applied to the sampling UV BEFORE
// the ring reads, EXACTLY as cube-dsp voxelizes + warps the field-lookup coords.
// SPACE DIFFUSE for video pulls toward the LOW corner (0,0) — the fixed "emptiest
// wall" v1 approximation of cube-dsp.lowestInfoFace (the per-frame darkest-region
// latch is a documented follow-up). WRAP mirror-folds an out-of-range coord.
// ----------------------------------------------------------------------

/** Warp one sampling coordinate: SPACE CRUSH voxelize, then SPACE DIFFUSE pull
 *  toward 0, then (if wrap) mirror-fold back into [0,1]. Composition order + the
 *  underlying cube-dsp functions match the GLSL 1:1. */
export function warpCoord(
  coord: number,
  spaceCrush: number,
  spaceDiffuse: number,
  wrap: boolean,
): number {
  let c = spaceCrushCoord(coord, spaceCrush);
  c = diffusePull(c, spaceDiffuse, -1);
  if (wrap) c = wrapFold(c);
  return c;
}

// ----------------------------------------------------------------------
// The 3-way COMBINE — the video isomorph of CUBE's 3-wavetable field morph.
// ----------------------------------------------------------------------

/**
 * Posterize an RGB to `crushLevels(k)` discrete levels per channel — the video
 * meaning of CUBE's amplitude CRUSH (the SAME `crushLevels` curve, so the picture
 * quantizes exactly as the derived audio does). k=0 = identity.
 */
export function posterize(c: RGB, crush: number): RGB {
  const k = clamp01(crush);
  if (k <= 0) return c;
  const levels = crushLevels(k);
  if (levels >= 256) return c;
  const q = (v: number) => Math.round(clamp01(v) * (levels - 1)) / (levels - 1);
  return { r: q(c.r), g: q(c.g), b: q(c.b) };
}

/**
 * Combine the three ring colours at one output pixel into the morphed frame — the
 * OCCUPANCY-WEIGHTED trilinear blend that mirrors CUBE's field:
 *
 *   z      = luma(cB)                            occupancy position (the connector)
 *   wFloor = occ(z; lumaA, lumaB, connect, cs)   A (floor) bound to B (wall)
 *   wCeil  = occ(z; lumaC, lumaB, connect, cs)   C (ceiling) bound to B (wall)
 *   wf = wFloor·(1−m),  wc = wCeil·m             MORPH FC cross-fade A↔C
 *   wWall = clamp(1 − (wFloor + wCeil), 0, 1)    the connector's own share
 *   outc  = (wf·cA + wc·cC + wWall·cB) / Σ       SMOOTH soft blend
 *
 * MATERIAL HARD ⇒ a one-table-wins mosaic (the max-weight table's colour). CRUSH
 * posterizes the result. `occ`, the weights + the MORPH/CONNECT/CONNECT-STRENGTH
 * semantics are byte-for-byte the audio-CUBE field math (cube-dsp.occ).
 */
export function combinePixel(
  cA: RGB,
  cB: RGB,
  cC: RGB,
  p: {
    morphFC: number;
    connect: number;
    connectStrength: number;
    material: 'smooth' | 'hard';
    crush: number;
  },
): RGB {
  const lA = luma(cA.r, cA.g, cA.b);
  const lB = luma(cB.r, cB.g, cB.b);
  const lC = luma(cC.r, cC.g, cC.b);
  // Occupancy position z = the luma of a REFERENCE BLEND (the 3-way average, the
  // spec's "luma of a reference blend"). Using the WALL luma alone would pin z to
  // a connector endpoint (occ collapses to 0/1 and CONNECT never engages); the
  // average sits in the connector INTERIOR so CONNECT / CONNECT STRENGTH shape it.
  const z = (lA + lB + lC) / 3;
  const m = clamp01(p.morphFC);
  const cs = clamp01(p.connectStrength);
  const wFloor = occ(z, lA, lB, p.connect, cs);
  const wCeil = occ(z, lC, lB, p.connect, cs);
  const wf = wFloor * (1 - m);
  const wc = wCeil * m;
  const wWall = clamp01(1 - (wFloor + wCeil));

  let out: RGB;
  if (p.material === 'hard') {
    // One-table-wins mosaic: the largest weight picks the whole pixel.
    if (wWall >= wf && wWall >= wc) out = { ...cB };
    else if (wf >= wc) out = { ...cA };
    else out = { ...cC };
  } else {
    const denom = Math.max(wf + wc + wWall, 1e-3);
    out = {
      r: (wf * cA.r + wc * cC.r + wWall * cB.r) / denom,
      g: (wf * cA.g + wc * cC.g + wWall * cB.g) / denom,
      b: (wf * cA.b + wc * cC.b + wWall * cB.b) / denom,
    };
  }
  return posterize(out, p.crush);
}

// ----------------------------------------------------------------------
// Audio derivation — reduce a ring to a luma HEIGHTFIELD for cube-dsp.sampleSlice.
// ----------------------------------------------------------------------

/**
 * Reduce a ring's REDUCE-pass readback — a `frames`×`cols` RGBA8 strip
 * (row-major: `frames` rows of `cols` luma pixels, one row per ring layer in
 * CHRONOLOGICAL order) — to a `Float32Array[frames]` of `cols` samples in
 * [-1,1], shaped exactly like an e352 wavetable (rows = temporal/morph axis,
 * cols = phase axis). Fed straight into cube-dsp.sampleSlice so the derived
 * audio is the audio-CUBE engine sourced from video luma. Empty/short strips →
 * zero rows (silent, never NaN).
 */
export function stripToHeightfield(
  strip: Uint8Array | Uint8ClampedArray,
  cols: number,
  frames: number,
): Float32Array[] {
  const out: Float32Array[] = [];
  for (let f = 0; f < frames; f++) {
    const row = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      const i = (f * cols + x) * 4;
      if (i + 2 < strip.length) {
        const lm = luma((strip[i] ?? 0) / 255, (strip[i + 1] ?? 0) / 255, (strip[i + 2] ?? 0) / 255);
        row[x] = lm * 2 - 1; // [0,1] → [-1,1]
      }
    }
    out.push(row);
  }
  return out;
}
