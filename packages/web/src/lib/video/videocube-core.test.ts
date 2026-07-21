// packages/web/src/lib/video/videocube-core.test.ts
//
// VIDEOCUBE pure-CORE certification (jsdom, no WebGL). Pins the NEW math the GLSL
// ray-march COMBINE shader transliterates 1:1 — the per-voxel FIELD SAMPLE
// (density + occupancy-weighted colour over a GENUINE z axis), the SPACE
// CRUSH/CRUSH/WRAP coord warp, the SPACE-DIFFUSE gravity face, and the single-
// frame ring→luma-heightfield reduction that feeds the audio scan. The REUSED
// field math (occ / fieldFromHeights / crushLevels / spaceCrushCoord / crushCoord
// / wrapFold / lowestInfoFace) is pinned by cube-dsp.test.ts; the ring READ
// machinery by frametable-core.test.ts.

import { describe, it, expect } from 'vitest';
import {
  luma,
  posterize,
  warpCoord,
  wrapSurfaceCoord,
  readerLagFor,
  voxelSample,
  diffuseTargetFor,
  stripToHeightfield,
  stripToHeightfieldInto,
  windowHalfWidth,
  temporalWindow,
  sampleTemporalWindow,
  VIDEOCUBE_SMOOTH_TAPS_SOFT,
  VIDEOCUBE_SMOOTH_TAPS_GPU,
  VIDEOCUBE_SMOOTH_TAPS_MAX,
  VIDEOCUBE_WINDOW_EPS,
  VIDEOCUBE_RING_FRAMES,
  VIDEOCUBE_RENDER_SCALE,
  VIDEOCUBE_MARCH_SCALE,
  VIDEOCUBE_MARCH_SOFT,
  VIDEOCUBE_MARCH_GPU,
  VIDEOCUBE_MARCH_MAX,
  VIDEOCUBE_FIELD_ROWS,
  VIDEOCUBE_READER_LAG,
  VIDEOCUBE_MODE_SMOOTH,
  VIDEOCUBE_MODE_MORPH,
  VIDEOCUBE_MODE_CHAOS,
  VIDEOCUBE_CHAOS_REPRESENTATIVE_LAG,
  VIDEOCUBE_WRAP_TILES,
  VIDEOCUBE_DIFFUSE_DEFAULT,
  type RGB,
  type VoxelParams,
} from './videocube-core';
import {
  crushLevels,
  spaceCrushCoord,
  crushCoord,
  wrapFold,
  clamp01,
  fieldFromHeights,
  lowestInfoFace,
  type Material,
} from '../../../../dsp/src/lib/cube-dsp';

const RED: RGB = { r: 1, g: 0, b: 0 };
const BLUE: RGB = { r: 0, g: 0, b: 1 };
const GRAY: RGB = { r: 0.5, g: 0.5, b: 0.5 };
const smoothP: VoxelParams = { morphFC: 0, connect: 0, connectStrength: 0, material: 'smooth', crush: 0 };

describe('videocube-core constants', () => {
  it('reuse FrameTable ring geometry (60 frames, half-res video_out)', () => {
    expect(VIDEOCUBE_RING_FRAMES).toBe(60);
    expect(VIDEOCUBE_RENDER_SCALE).toBe(0.5);
  });
  it('the ray-march renders at quarter res (perf lever)', () => {
    expect(VIDEOCUBE_MARCH_SCALE).toBe(0.25);
    expect(VIDEOCUBE_MARCH_SCALE).toBeLessThan(VIDEOCUBE_RENDER_SCALE);
  });
  it('the march step count is renderer-gated (soft < gpu, gpu = the loop cap)', () => {
    expect(VIDEOCUBE_MARCH_SOFT).toBeLessThan(VIDEOCUBE_MARCH_GPU);
    expect(VIDEOCUBE_MARCH_SOFT).toBe(32);
    expect(VIDEOCUBE_MARCH_GPU).toBe(64);
    expect(VIDEOCUBE_MARCH_MAX).toBe(VIDEOCUBE_MARCH_GPU);
  });
  it('the audio field is a 64-row heightfield (e352 frame count) + distinct reader modes', () => {
    expect(VIDEOCUBE_FIELD_ROWS).toBe(64);
    expect(new Set([VIDEOCUBE_MODE_SMOOTH, VIDEOCUBE_MODE_MORPH, VIDEOCUBE_MODE_CHAOS]).size).toBe(3);
  });
});

describe('luma', () => {
  it('Rec.601 weights, clamped to [0,1]', () => {
    expect(luma(0, 0, 0)).toBe(0);
    expect(luma(1, 1, 1)).toBeCloseTo(1, 6);
    expect(luma(1, 0, 0)).toBeCloseTo(0.299, 6);
    expect(luma(0, 1, 0)).toBeCloseTo(0.587, 6);
    expect(luma(0, 0, 1)).toBeCloseTo(0.114, 6);
    expect(luma(5, 5, 5)).toBe(1); // clamps
  });
});

describe('voxelSample — the per-voxel FIELD sample (density + occupancy colour)', () => {
  it('THREE IDENTICAL surfaces return that colour exactly, at any depth (identity)', () => {
    for (const c of [RED, BLUE, GRAY, { r: 0.2, g: 0.7, b: 0.4 }]) {
      for (const z of [0, 0.3, 0.6, 1]) {
        const out = voxelSample(c, c, c, z, smoothP).color;
        expect(out.r).toBeCloseTo(c.r, 6);
        expect(out.g).toBeCloseTo(c.g, 6);
        expect(out.b).toBeCloseTo(c.b, 6);
      }
    }
  });

  it('density is byte-for-byte cube-dsp.fieldFromHeights (the SAME field the audio scans)', () => {
    for (const z of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      for (const m of [0, 0.5, 1]) {
        for (const mat of ['smooth', 'hard'] as const) {
          const p: VoxelParams = { morphFC: m, connect: 0.3, connectStrength: 0, material: mat, crush: 0 };
          const got = voxelSample(RED, GRAY, BLUE, z, p).density;
          const want = fieldFromHeights(
            z,
            { floorH: luma(1, 0, 0), wallH: luma(0.5, 0.5, 0.5), ceilH: luma(0, 0, 1) },
            { morphFC: m, connect: 0.3, connectStrength: 0, material: mat },
          );
          expect(got, `z=${z} m=${m} ${mat}`).toBeCloseTo(want, 6);
        }
      }
    }
  });

  it('the field is a GENUINE z axis — solid at the base, empty above the ceiling', () => {
    // A/B/C distinct; at z=0 the field is fully solid, at z≈1 it is empty. (The
    // v1 bug collapsed z to one point → this monotone-in-z fill was impossible.)
    const base = voxelSample(RED, GRAY, BLUE, 0, { ...smoothP, morphFC: 0.5 }).density;
    const top = voxelSample(RED, GRAY, BLUE, 0.98, { ...smoothP, morphFC: 0.5 }).density;
    expect(base, 'solid at the floor').toBeGreaterThan(0.9);
    expect(top, 'empty above the ceiling').toBeLessThan(0.1);
    expect(base).toBeGreaterThan(top);
  });

  it('MORPH cross-fades FLOOR (A) → CEILING (C) through B at a connector depth', () => {
    const z = 0.4; // inside both the floor→wall and ceiling→wall fills
    const at0 = voxelSample(RED, GRAY, BLUE, z, { ...smoothP, morphFC: 0 }).color;
    const at1 = voxelSample(RED, GRAY, BLUE, z, { ...smoothP, morphFC: 1 }).color;
    expect(at0.r, 'morph 0 → red-dominant').toBeGreaterThan(at0.b);
    expect(at1.b, 'morph 1 → blue-dominant').toBeGreaterThan(at1.r);
    expect(at1.b, 'ceiling(blue) grows with morph').toBeGreaterThan(at0.b);
    expect(at0.r, 'floor(red) shrinks with morph').toBeGreaterThan(at1.r);
  });

  it('CONNECT actually engages (moves the blend, not a degenerate no-op)', () => {
    const z = 0.4;
    const soft = voxelSample(RED, GRAY, BLUE, z, { ...smoothP, morphFC: 0.5, connect: 0 }).color;
    const hard = voxelSample(RED, GRAY, BLUE, z, { ...smoothP, morphFC: 0.5, connect: 1 }).color;
    const d = Math.abs(soft.r - hard.r) + Math.abs(soft.g - hard.g) + Math.abs(soft.b - hard.b);
    expect(d, 'CONNECT changes the blend').toBeGreaterThan(1e-3);
  });

  it('output channels stay in [0,1] across a param sweep and every depth', () => {
    for (let m = 0; m <= 1; m += 0.25) {
      for (const con of [0, 0.5, 1]) {
        for (const cs of [0, 1]) {
          for (const z of [0, 0.35, 0.7, 1]) {
            const out = voxelSample(RED, GRAY, BLUE, z, { morphFC: m, connect: con, connectStrength: cs, material: 'smooth', crush: 0 }).color;
            for (const v of [out.r, out.g, out.b]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
          }
        }
      }
    }
  });

  it('MATERIAL HARD returns exactly one source colour (one-surface-wins) + a binary density', () => {
    const s = voxelSample(RED, GRAY, BLUE, 0.4, { ...smoothP, morphFC: 0.5, material: 'hard' });
    const isOne = (c: RGB) => c.r === s.color.r && c.g === s.color.g && c.b === s.color.b;
    expect(isOne(RED) || isOne(GRAY) || isOne(BLUE)).toBe(true);
    expect(s.density === 0 || s.density === 1, 'HARD density is binary').toBe(true);
  });

  it('CRUSH posterizes the colour AND amplitude-crushes the density (cube-dsp levels)', () => {
    const s = voxelSample({ r: 0.4, g: 0.6, b: 0.2 }, GRAY, { r: 0.3, g: 0.1, b: 0.9 }, 0.4, { ...smoothP, morphFC: 0.5, crush: 1 });
    const levels = crushLevels(1); // 2 at k=1
    for (const v of [s.color.r, s.color.g, s.color.b]) {
      const q = Math.round(v * (levels - 1)) / (levels - 1);
      expect(v).toBeCloseTo(q, 6);
    }
    // density quantized to the same levels.
    const dq = Math.round(s.density * (levels - 1)) / (levels - 1);
    expect(s.density).toBeCloseTo(dq, 6);
  });
});

describe('posterize', () => {
  it('crush 0 = identity', () => {
    const c = { r: 0.37, g: 0.62, b: 0.11 };
    expect(posterize(c, 0)).toEqual(c);
  });
  it('crush 1 = 2 levels (0 or 1 per channel)', () => {
    const out = posterize({ r: 0.3, g: 0.7, b: 0.5 }, 1);
    for (const v of [out.r, out.g, out.b]) expect(v === 0 || v === 1).toBe(true);
  });
});

describe('warpCoord — SPACE CRUSH voxelize + CRUSH snap + WRAP fold (the field lookup)', () => {
  it('all off = identity', () => {
    expect(warpCoord(0.37, 0, 0, false)).toBeCloseTo(0.37, 6);
  });
  it('SPACE CRUSH snaps to the cube-dsp voxel grid', () => {
    expect(warpCoord(0.37, 1, 0, false)).toBeCloseTo(spaceCrushCoord(0.37, 1), 6);
  });
  it('CRUSH snaps the coord to the cube-dsp spatial grid', () => {
    expect(warpCoord(0.37, 0, 1, false)).toBeCloseTo(crushCoord(0.37, 1), 6);
  });
  it('WRAP mirror-folds an out-of-range coord', () => {
    expect(warpCoord(1.2, 0, 0, true)).toBeCloseTo(wrapFold(1.2), 6); // 0.8
  });
  it('WRAP off clamps an out-of-range coord to [0,1]', () => {
    expect(warpCoord(1.2, 0, 0, false)).toBeCloseTo(1, 6);
    expect(warpCoord(-0.2, 0, 0, false)).toBeCloseTo(0, 6);
  });
});

describe('wrapSurfaceCoord — WRAP on the PICTURE surface uv (B1: WRAP must change the render)', () => {
  it('WRAP off = clamp (identity for the in-cube [0,1] coords the march produces)', () => {
    // The marched surface coords are ALWAYS in [0,1]; OFF must be byte-identical
    // to a plain read → the pre-WRAP look is preserved.
    for (const c of [0, 0.1, 0.37, 0.5, 0.83, 1]) {
      expect(wrapSurfaceCoord(c, false)).toBeCloseTo(clamp01(c), 6);
      expect(wrapSurfaceCoord(c, false)).toBeCloseTo(c, 6);
    }
  });
  it('WRAP on MIRROR-TILES the [0,1] domain → DIFFERENT from clamp at interior coords', () => {
    // This is the whole B1 fix: for an in-range coord, ON ≠ OFF, so toggling WRAP
    // visibly changes which texel the surface samples (the picture changes).
    let anyDifferent = false;
    for (const c of [0.1, 0.25, 0.37, 0.6, 0.75, 0.9]) {
      const on = wrapSurfaceCoord(c, true);
      const off = wrapSurfaceCoord(c, false);
      expect(on).toBeCloseTo(wrapFold(c * VIDEOCUBE_WRAP_TILES), 6);
      expect(on).toBeGreaterThanOrEqual(0);
      expect(on).toBeLessThanOrEqual(1);
      if (Math.abs(on - off) > 1e-3) anyDifferent = true;
    }
    expect(anyDifferent, 'WRAP on differs from off for interior coords → the render changes').toBe(true);
  });
  it('WRAP on is a true MIRROR: symmetric about the mid-plane, folds the faces to 0', () => {
    expect(wrapSurfaceCoord(0, true)).toBeCloseTo(0, 6);   // near face
    expect(wrapSurfaceCoord(0.5, true)).toBeCloseTo(1, 6); // mid-plane = the fold crest
    expect(wrapSurfaceCoord(1, true)).toBeCloseTo(0, 6);   // far face folds back to 0
    // mirror symmetry across the 0.5 crest
    expect(wrapSurfaceCoord(0.3, true)).toBeCloseTo(wrapSurfaceCoord(0.7, true), 6);
  });
});

describe('readerLagFor — audio + video read the SAME temporal frame per mode (B3)', () => {
  it('MORPH reads the newest frame (lag 0) — matches the video march', () => {
    expect(readerLagFor(VIDEOCUBE_MODE_MORPH, false)).toBe(0);
    expect(readerLagFor(VIDEOCUBE_MODE_MORPH, true)).toBe(0);
  });
  it('SMOOTH reads the trailing VIDEOCUBE_READER_LAG frame (LIVE forces the newest)', () => {
    expect(readerLagFor(VIDEOCUBE_MODE_SMOOTH, false)).toBe(VIDEOCUBE_READER_LAG);
    expect(readerLagFor(VIDEOCUBE_MODE_SMOOTH, true)).toBe(0);
  });
  it('CHAOS reads the window-MEAN representative frame (per-pixel in the picture), ignoring LIVE', () => {
    // The shader dithers a per-pixel frame regardless of LIVE; the 1-D audio scan
    // reads the window mean, the documented representative — LIVE does not override.
    expect(readerLagFor(VIDEOCUBE_MODE_CHAOS, false)).toBe(VIDEOCUBE_CHAOS_REPRESENTATIVE_LAG);
    expect(readerLagFor(VIDEOCUBE_MODE_CHAOS, true)).toBe(VIDEOCUBE_CHAOS_REPRESENTATIVE_LAG);
    // the representative is the mean of a uniform pick over [0, N-1)
    expect(VIDEOCUBE_CHAOS_REPRESENTATIVE_LAG).toBe(Math.round((VIDEOCUBE_RING_FRAMES - 1) / 2));
  });
  it('the three modes select DISTINCT frames (so the picture and audio actually differ by mode)', () => {
    const smooth = readerLagFor(VIDEOCUBE_MODE_SMOOTH, false);
    const morph = readerLagFor(VIDEOCUBE_MODE_MORPH, false);
    const chaos = readerLagFor(VIDEOCUBE_MODE_CHAOS, false);
    expect(new Set([smooth, morph, chaos]).size).toBe(3);
  });
});

describe('diffuseTargetFor — SPACE DIFFUSE gravity face (unified with the audio)', () => {
  // Build a rows×256 constant heightfield (a flat surface at physical height h).
  function flatField(h: number, rows = 4): Float32Array[] {
    const v = h * 2 - 1; // physical [0,1] → sample [-1,1]
    const out: Float32Array[] = [];
    for (let r = 0; r < rows; r++) out.push(new Float32Array(256).fill(v));
    return out;
  }
  const fp = { morphFC: 0.5, connect: 0, connectStrength: 0, material: 'smooth' as Material };

  it('empty heightfields → the default face (top / z-high)', () => {
    expect(diffuseTargetFor([], [], [], fp)).toEqual(VIDEOCUBE_DIFFUSE_DEFAULT);
  });
  it('is exactly cube-dsp.lowestInfoFace over the same field (thin wrapper)', () => {
    const floorH = flatField(0.2), wallH = flatField(0.6), ceilH = flatField(0.3);
    const got = diffuseTargetFor(floorH, wallH, ceilH, fp);
    const want = lowestInfoFace(floorH, wallH, ceilH, fp);
    expect(got).toEqual(want);
  });
  it('returns a valid, deterministic cube face', () => {
    const floorH = flatField(0.1), wallH = flatField(0.9), ceilH = flatField(0.4);
    const a = diffuseTargetFor(floorH, wallH, ceilH, fp);
    const b = diffuseTargetFor(floorH, wallH, ceilH, fp);
    expect(a).toEqual(b);
    expect([0, 1, 2]).toContain(a.axis);
    expect([-1, 1]).toContain(a.dir);
  });
});

describe('stripToHeightfield — single-frame ring luma reduction for the audio scan', () => {
  it('white strip → +1, black strip → -1, shape [rows][cols]', () => {
    const cols = 8, rows = 4;
    const white = new Uint8Array(cols * rows * 4).fill(255);
    const black = new Uint8Array(cols * rows * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255; // opaque alpha
    const hw = stripToHeightfield(white, cols, rows);
    const hb = stripToHeightfield(black, cols, rows);
    expect(hw.length).toBe(rows);
    expect(hw[0]!.length).toBe(cols);
    expect(hw[0]![0]).toBeCloseTo(1, 5);
    expect(hb[0]![0]).toBeCloseTo(-1, 5);
  });
  it('maps luma [0,1] → [-1,1] per column', () => {
    const cols = 2, rows = 1;
    const strip = new Uint8Array(cols * rows * 4);
    strip.set([255, 255, 255, 255], 0);   // col0 = white (luma 1 → +1)
    strip.set([128, 128, 128, 255], 4);   // col1 = mid-gray 128 (luma ~0.502 → ~0.004)
    const h = stripToHeightfield(strip, cols, rows);
    expect(h[0]![0]).toBeCloseTo(1, 5);
    expect(h[0]![1]).toBeCloseTo((128 / 255) * 2 - 1, 4);
  });

  it('stripToHeightfieldInto REUSES the scratch buffer (B2 — no per-call allocation)', () => {
    const cols = 8, rows = 4;
    const out: Float32Array[] = Array.from({ length: rows }, () => new Float32Array(cols));
    const rowRefs = out.map((r) => r); // identity of each persistent row
    const white = new Uint8Array(cols * rows * 4).fill(255);
    const black = new Uint8Array(cols * rows * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;

    const r1 = stripToHeightfieldInto(white, cols, rows, out);
    expect(r1).toBe(out);                       // returns the SAME array
    for (let f = 0; f < rows; f++) expect(r1[f]).toBe(rowRefs[f]); // SAME row buffers (no alloc)
    expect(r1[0]![0]).toBeCloseTo(1, 5);        // white → +1

    const r2 = stripToHeightfieldInto(black, cols, rows, out);
    expect(r2).toBe(out);
    for (let f = 0; f < rows; f++) expect(r2[f]).toBe(rowRefs[f]); // still the SAME buffers
    expect(r2[0]![0]).toBeCloseTo(-1, 5);       // overwritten in place → black → -1
  });

  it('stripToHeightfieldInto == stripToHeightfield (same math, in-place)', () => {
    const cols = 6, rows = 3;
    const strip = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < strip.length; i++) strip[i] = (i * 37) % 256;
    const want = stripToHeightfield(strip, cols, rows);
    const got = stripToHeightfieldInto(strip, cols, rows, Array.from({ length: rows }, () => new Float32Array(cols)));
    for (let f = 0; f < rows; f++) for (let x = 0; x < cols; x++) expect(got[f]![x]).toBeCloseTo(want[f]![x]!, 6);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// SPREAD temporal window (FrameTable-style) — the CPU mirror of the shader's
// surfWindow / REDUCE window loop. Pins: SPREAD=0 is byte-identical (single
// centre frame), the half-width mapping, Hann weights sum to 1 + symmetric, and
// a wider SPREAD genuinely OOZES (blends more of the ring).
// ──────────────────────────────────────────────────────────────────────────
describe('SPREAD temporal window', () => {
  const N = VIDEOCUBE_RING_FRAMES;

  it('windowHalfWidth: 0 → 0, 1 → (N-1)/2 (FrameTable mapping)', () => {
    expect(windowHalfWidth(0)).toBe(0);
    expect(windowHalfWidth(1)).toBeCloseTo((N - 1) / 2, 9);
    expect(windowHalfWidth(0.5)).toBeCloseTo(0.25 * (N - 1), 9);
    // clamps out-of-range spread
    expect(windowHalfWidth(-1)).toBe(0);
    expect(windowHalfWidth(2)).toBeCloseTo((N - 1) / 2, 9);
  });

  it('SPREAD=0 collapses to the single centre tap {offset:0, weight:1}', () => {
    for (const taps of [VIDEOCUBE_SMOOTH_TAPS_SOFT, VIDEOCUBE_SMOOTH_TAPS_GPU]) {
      const win = temporalWindow(0, taps);
      expect(win).toHaveLength(1);
      expect(win[0]!.offset).toBe(0);
      expect(win[0]!.weight).toBe(1);
    }
    // a sub-EPS window also collapses
    const tiny = temporalWindow(VIDEOCUBE_WINDOW_EPS / (N - 1), VIDEOCUBE_SMOOTH_TAPS_GPU);
    expect(tiny).toHaveLength(1);
  });

  it('taps ≤ 1 collapses to the single centre tap regardless of SPREAD', () => {
    for (const t of [0, 1, -3]) {
      const win = temporalWindow(1, t);
      expect(win).toHaveLength(1);
      expect(win[0]!.weight).toBe(1);
    }
  });

  it('weights are normalized (Σw = 1), all > 0, and inside ±h', () => {
    for (const spread of [0.2, 0.5, 1]) {
      for (const taps of [VIDEOCUBE_SMOOTH_TAPS_SOFT, VIDEOCUBE_SMOOTH_TAPS_GPU]) {
        const win = temporalWindow(spread, taps);
        expect(win).toHaveLength(taps);
        const h = windowHalfWidth(spread);
        const sum = win.reduce((a, t) => a + t.weight, 0);
        expect(sum).toBeCloseTo(1, 9);
        for (const t of win) {
          expect(t.weight).toBeGreaterThan(0);
          expect(Math.abs(t.offset)).toBeLessThan(h); // bin-centre sampling ⇒ strictly inside
        }
      }
    }
  });

  it('window is symmetric (offsets mirror, matching weights)', () => {
    const win = temporalWindow(0.7, VIDEOCUBE_SMOOTH_TAPS_GPU);
    const T = win.length;
    for (let k = 0; k < T; k++) {
      const mirror = win[T - 1 - k]!;
      expect(win[k]!.offset).toBeCloseTo(-mirror.offset, 9);
      expect(win[k]!.weight).toBeCloseTo(mirror.weight, 9);
    }
  });

  it('Hann weights peak at the centre (inner taps outweigh outer taps)', () => {
    const win = temporalWindow(1, VIDEOCUBE_SMOOTH_TAPS_GPU);
    const T = win.length;
    // the two innermost taps must each weigh more than the two outermost
    expect(win[T / 2]!.weight).toBeGreaterThan(win[0]!.weight);
    expect(win[T / 2 - 1]!.weight).toBeGreaterThan(win[T - 1]!.weight);
  });

  it('SPREAD=0 sampled window == the exact centre sample (byte-identical read)', () => {
    // synthetic ring: value = layer (mod N), read via nearest-ish sampler
    const ring = (layer: number) => ((layer % N) + N) % N;
    const centre = 20;
    expect(sampleTemporalWindow(ring, centre, 0, VIDEOCUBE_SMOOTH_TAPS_GPU)).toBe(ring(centre));
  });

  it('a flat (constant) ring is unchanged by any SPREAD (window is a weighted mean)', () => {
    const flat = () => 0.42;
    for (const spread of [0, 0.3, 1]) {
      expect(sampleTemporalWindow(flat, 30, spread, VIDEOCUBE_SMOOTH_TAPS_GPU)).toBeCloseTo(0.42, 9);
    }
  });

  it('OOZE: on a smooth ramp ring the window stays centred but a wider SPREAD blends more (lower local variance)', () => {
    // A triangular "impulse" ring: peak at the centre frame, decaying away.
    // Averaging a wider temporal window pulls the read DOWN from the peak — the
    // signature of "oozing": neighbouring frames bleed in.
    const centre = 30;
    const ring = (layer: number) => {
      const d = Math.abs((((layer - centre) % N) + N + N / 2) % N - N / 2); // wrapped distance
      return Math.max(0, 1 - d / 10);
    };
    const atZero = sampleTemporalWindow(ring, centre, 0, VIDEOCUBE_SMOOTH_TAPS_GPU);
    const atNarrow = sampleTemporalWindow(ring, centre, 0.15, VIDEOCUBE_SMOOTH_TAPS_GPU);
    const atWide = sampleTemporalWindow(ring, centre, 0.45, VIDEOCUBE_SMOOTH_TAPS_GPU);
    expect(atZero).toBeCloseTo(1, 6);              // spread 0 reads the crisp peak
    expect(atNarrow).toBeLessThan(atZero);          // a window bleeds neighbours in
    expect(atWide).toBeLessThan(atNarrow);          // wider window bleeds MORE (oozes)
  });

  it('VIDEOCUBE_SMOOTH_TAPS_MAX bounds the shader loop (≥ both renderer tap counts)', () => {
    expect(VIDEOCUBE_SMOOTH_TAPS_MAX).toBeGreaterThanOrEqual(VIDEOCUBE_SMOOTH_TAPS_SOFT);
    expect(VIDEOCUBE_SMOOTH_TAPS_MAX).toBeGreaterThanOrEqual(VIDEOCUBE_SMOOTH_TAPS_GPU);
  });
});
