// packages/web/src/lib/video/videocube-core.test.ts
//
// VIDEOCUBE pure-CORE certification (jsdom, no WebGL). Pins the NEW math the GLSL
// COMBINE shader transliterates 1:1 — the occupancy colour blend, the SLICE
// field, the SPACE CRUSH/DIFFUSE/WRAP coord warp, CRUSH posterize, and the
// ring→luma-heightfield reduction that feeds the audio scan. The REUSED field
// math (occ / crushLevels / spaceCrushCoord / diffusePull / wrapFold) is pinned
// by cube-dsp.test.ts; the ring READ machinery by frametable-core.test.ts.

import { describe, it, expect } from 'vitest';
import {
  luma,
  combinePixel,
  posterize,
  warpCoord,
  videoField,
  stripToHeightfield,
  VIDEOCUBE_RING_FRAMES,
  VIDEOCUBE_RENDER_SCALE,
  VIDEOCUBE_TAPS_GPU,
  VIDEOCUBE_TAPS_SOFT,
  type RGB,
} from './videocube-core';
import { crushLevels, spaceCrushCoord, wrapFold } from '../../../../dsp/src/lib/cube-dsp';

const RED: RGB = { r: 1, g: 0, b: 0 };
const BLUE: RGB = { r: 0, g: 0, b: 1 };
const GRAY: RGB = { r: 0.5, g: 0.5, b: 0.5 };
const smoothP = { morphFC: 0, connect: 0, connectStrength: 0, material: 'smooth' as const, crush: 0 };

describe('videocube-core constants', () => {
  it('reuse FrameTable ring geometry (60 frames, half-res)', () => {
    expect(VIDEOCUBE_RING_FRAMES).toBe(60);
    expect(VIDEOCUBE_RENDER_SCALE).toBe(0.5);
  });
  it('the combine tap count is renderer-gated (soft < gpu)', () => {
    expect(VIDEOCUBE_TAPS_SOFT).toBeLessThan(VIDEOCUBE_TAPS_GPU);
    expect(VIDEOCUBE_TAPS_SOFT).toBe(4);
    expect(VIDEOCUBE_TAPS_GPU).toBe(8);
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

describe('combinePixel — the occupancy colour blend', () => {
  it('THREE IDENTICAL rings return that colour exactly (identity)', () => {
    for (const c of [RED, BLUE, GRAY, { r: 0.2, g: 0.7, b: 0.4 }]) {
      const out = combinePixel(c, c, c, smoothP);
      expect(out.r).toBeCloseTo(c.r, 6);
      expect(out.g).toBeCloseTo(c.g, 6);
      expect(out.b).toBeCloseTo(c.b, 6);
    }
  });

  it('MORPH cross-fades ring A (floor) → ring C (ceiling)', () => {
    // A=red, B=gray (wall), C=blue: morph 0 favours A (red), morph 1 favours C (blue).
    const at0 = combinePixel(RED, GRAY, BLUE, { ...smoothP, morphFC: 0 });
    const at1 = combinePixel(RED, GRAY, BLUE, { ...smoothP, morphFC: 1 });
    expect(at0.r, 'morph 0 → red-dominant').toBeGreaterThan(at0.b);
    expect(at1.b, 'morph 1 → blue-dominant').toBeGreaterThan(at1.r);
    expect(at1.b, 'ceiling(blue) grows with morph').toBeGreaterThan(at0.b);
    expect(at0.r, 'floor(red) shrinks with morph').toBeGreaterThan(at1.r);
  });

  it('CONNECT actually engages (z sits in the connector interior, not on an endpoint)', () => {
    // If z were pinned to the wall luma, occ would be binary and CONNECT a no-op.
    // A mid-morph blend of three distinct lumas must MOVE as CONNECT sweeps.
    const soft = combinePixel(RED, GRAY, BLUE, { ...smoothP, morphFC: 0.5, connect: 0 });
    const hard = combinePixel(RED, GRAY, BLUE, { ...smoothP, morphFC: 0.5, connect: 1 });
    const d = Math.abs(soft.r - hard.r) + Math.abs(soft.g - hard.g) + Math.abs(soft.b - hard.b);
    expect(d, 'CONNECT changes the blend (not a degenerate no-op)').toBeGreaterThan(1e-3);
  });

  it('output channels stay in [0,1] across a param sweep', () => {
    for (let m = 0; m <= 1; m += 0.25) {
      for (const con of [0, 0.5, 1]) {
        for (const cs of [0, 1]) {
          const out = combinePixel(RED, GRAY, BLUE, { morphFC: m, connect: con, connectStrength: cs, material: 'smooth', crush: 0 });
          for (const v of [out.r, out.g, out.b]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
        }
      }
    }
  });

  it('MATERIAL HARD returns exactly one of the three ring colours (one-table-wins)', () => {
    const out = combinePixel(RED, GRAY, BLUE, { ...smoothP, morphFC: 0.5, material: 'hard' });
    const isOne = (c: RGB) => c.r === out.r && c.g === out.g && c.b === out.b;
    expect(isOne(RED) || isOne(GRAY) || isOne(BLUE)).toBe(true);
  });

  it('CRUSH posterizes the blended output (matches cube-dsp crushLevels)', () => {
    const out = combinePixel({ r: 0.4, g: 0.6, b: 0.2 }, GRAY, { r: 0.3, g: 0.1, b: 0.9 }, { ...smoothP, crush: 1 });
    const levels = crushLevels(1); // 2 at k=1
    for (const v of [out.r, out.g, out.b]) {
      const q = Math.round(v * (levels - 1)) / (levels - 1);
      expect(v).toBeCloseTo(q, 6);
    }
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

describe('warpCoord — SPACE CRUSH voxelize + SPACE DIFFUSE pull + WRAP fold', () => {
  it('all off = identity', () => {
    expect(warpCoord(0.37, 0, 0, false)).toBeCloseTo(0.37, 6);
  });
  it('SPACE CRUSH snaps to the cube-dsp voxel grid', () => {
    expect(warpCoord(0.37, 1, 0, false)).toBeCloseTo(spaceCrushCoord(0.37, 1), 6);
  });
  it('SPACE DIFFUSE at 1 pulls fully to the low corner (0)', () => {
    expect(warpCoord(0.8, 0, 1, false)).toBeCloseTo(0, 6);
  });
  it('WRAP mirror-folds an out-of-range coord', () => {
    // diffuse pushes below 0 only downward; feed an explicit >1 via a pull that overshoots? use wrap directly.
    expect(warpCoord(1.2, 0, 0, true)).toBeCloseTo(wrapFold(1.2), 6); // 0.8
  });
});

describe('videoField — per-pixel temporal offset from SLICE Y / ROT', () => {
  it('is exactly 0 at the neutral slice (Y=0.5, no rotation)', () => {
    for (const [x, y] of [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.9]] as const) {
      expect(videoField(x, y, 0.5, 0, 0, 0, 15)).toBeCloseTo(0, 9);
    }
  });
  it('is non-zero off-centre when Y is raised', () => {
    expect(Math.abs(videoField(0.5, 0.9, 1, 0, 0, 0, 15))).toBeGreaterThan(0.1);
  });
  it('scales with the amplitude', () => {
    const a = videoField(0.2, 0.8, 0.8, 0.3, 0, 0, 10);
    const b = videoField(0.2, 0.8, 0.8, 0.3, 0, 0, 20);
    expect(b).toBeCloseTo(a * 2, 6);
  });
});

describe('stripToHeightfield — ring luma reduction for the audio scan', () => {
  it('white strip → +1, black strip → -1, shape [frames][cols]', () => {
    const cols = 8, frames = 4;
    const white = new Uint8Array(cols * frames * 4).fill(255);
    const black = new Uint8Array(cols * frames * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255; // opaque alpha
    const hw = stripToHeightfield(white, cols, frames);
    const hb = stripToHeightfield(black, cols, frames);
    expect(hw.length).toBe(frames);
    expect(hw[0]!.length).toBe(cols);
    expect(hw[0]![0]).toBeCloseTo(1, 5);
    expect(hb[0]![0]).toBeCloseTo(-1, 5);
  });
  it('maps luma [0,1] → [-1,1] per column', () => {
    const cols = 2, frames = 1;
    const strip = new Uint8Array(cols * frames * 4);
    // col0 = white (luma 1 → +1), col1 = mid-gray 128 (luma ~0.502 → ~0.004)
    strip.set([255, 255, 255, 255], 0);
    strip.set([128, 128, 128, 255], 4);
    const h = stripToHeightfield(strip, cols, frames);
    expect(h[0]![0]).toBeCloseTo(1, 5);
    expect(h[0]![1]).toBeCloseTo((128 / 255) * 2 - 1, 4);
  });
});
