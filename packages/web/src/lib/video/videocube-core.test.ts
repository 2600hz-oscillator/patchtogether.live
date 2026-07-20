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
  voxelSample,
  diffuseTargetFor,
  stripToHeightfield,
  VIDEOCUBE_RING_FRAMES,
  VIDEOCUBE_RENDER_SCALE,
  VIDEOCUBE_MARCH_SCALE,
  VIDEOCUBE_MARCH_SOFT,
  VIDEOCUBE_MARCH_GPU,
  VIDEOCUBE_MARCH_MAX,
  VIDEOCUBE_FIELD_ROWS,
  VIDEOCUBE_MODE_SMOOTH,
  VIDEOCUBE_MODE_MORPH,
  VIDEOCUBE_MODE_CHAOS,
  VIDEOCUBE_DIFFUSE_DEFAULT,
  type RGB,
  type VoxelParams,
} from './videocube-core';
import {
  crushLevels,
  spaceCrushCoord,
  crushCoord,
  wrapFold,
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
});
