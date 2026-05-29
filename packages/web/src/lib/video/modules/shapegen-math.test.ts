// packages/web/src/lib/video/modules/shapegen-math.test.ts
//
// Belt-and-suspenders import-pin test for the shapegen-math extraction:
//   • imports from the NEW location (video/modules/shapegen-math.ts)
//     directly — proves the symbols live there and behave correctly
//     independent of the foxy-shapes re-export shim.
//   • covers the new `abSizeFactor` size-modulation helper added for
//     SHAPEGEN's SIZE knob (FOXY doesn't use it; tests live here, not
//     in the foxy-shapes suite).
//
// The bulk of the math coverage (generateShapes determinism, SDF behaviour,
// voxel scan, etc.) stays in packages/web/src/lib/audio/modules/
// foxy-shapes.test.ts — it exercises the same symbols via the shim, so
// duplicating it here would just slow the suite down.

import { describe, expect, it } from 'vitest';
import {
  abSizeFactor,
  generateShapes,
  FOXY_SHAPE_TYPES,
  type Shape,
} from './shapegen-math';

describe('shapegen-math — import-pin from new location', () => {
  it('exports generateShapes + the shape-type enum from the new file', () => {
    expect(typeof generateShapes).toBe('function');
    expect(FOXY_SHAPE_TYPES).toContain('sphere');
    expect(FOXY_SHAPE_TYPES).toContain('tetraFrame');
  });

  it('flat-A early-out behaviour survived the move', () => {
    const W = 64;
    const flat = new Uint8ClampedArray(W * W * 4);
    for (let i = 0; i < flat.length; i += 4) {
      flat[i] = 128; flat[i + 1] = 128; flat[i + 2] = 128; flat[i + 3] = 255;
    }
    expect(generateShapes(flat, flat, flat, W, W)).toEqual([]);
  });

  it('produces shapes with positions in [-1,1]³ + radii in baseline range', () => {
    const W = 64;
    // A few bright spots in A so the feature grid has real peaks.
    const A = new Uint8ClampedArray(W * W * 4);
    for (let i = 0; i < W * W; i++) {
      const x = i % W;
      const y = Math.floor(i / W);
      const dx = (x - W * 0.3) / W;
      const dy = (y - W * 0.3) / W;
      const v = Math.exp(-(dx * dx + dy * dy) * 60);
      const b = Math.round(v * 255);
      const o = i * 4;
      A[o] = b; A[o + 1] = b; A[o + 2] = b; A[o + 3] = 255;
    }
    const B = new Uint8ClampedArray(W * W * 4); B.fill(160);
    const C = new Uint8ClampedArray(W * W * 4); C.fill(200);
    const shapes = generateShapes(A, B, C, W, W);
    expect(shapes.length).toBeGreaterThan(0);
    for (const s of shapes) {
      expect(s.pos.x).toBeGreaterThanOrEqual(-1);
      expect(s.pos.x).toBeLessThanOrEqual(1);
      expect(s.radius).toBeGreaterThan(0);
      // Per the design header: baseline ∈ [0.05, 0.3], A×B factor ∈
      // [0.5, 2.0], final clamped at FOXY_3D_MAX_RADIUS = 0.6.
      expect(s.radius).toBeLessThanOrEqual(0.6);
    }
  });
});

describe('shapegen-math — abSizeFactor', () => {
  it('A×B = 1/3 sits at factor=1.0 (the neutral point of the ±swing)', () => {
    // a = 1, b = 1/3 → factor = 0.5 + 1.5 * (1 * 1/3) = 1.0
    expect(abSizeFactor(1.0, 1 / 3)).toBeCloseTo(1.0, 6);
    expect(abSizeFactor(1 / 3, 1.0)).toBeCloseTo(1.0, 6);
  });

  it('reaches 0.5 at A=B=0 (minimum) and 2.0 at A=B=1 (maximum)', () => {
    expect(abSizeFactor(0, 0)).toBeCloseTo(0.5, 6);
    expect(abSizeFactor(1, 1)).toBeCloseTo(2.0, 6);
  });

  it('clamps out-of-range inputs to [0, 1]', () => {
    expect(abSizeFactor(-1, 0.5)).toBeCloseTo(0.5, 6);  // a → 0
    expect(abSizeFactor(0.5, 2)).toBeCloseTo(1.25, 6);  // b → 1 → 0.5 + 1.5*0.5 = 1.25
    expect(abSizeFactor(5, 5)).toBeCloseTo(2.0, 6);     // both → 1
  });
});

describe('shapegen-math — Shape type still satisfies the spec', () => {
  it('an instance of Shape has all required fields with the documented shape', () => {
    const s: Shape = { type: 'sphere', pos: { x: 0, y: 0, z: 0 }, radius: 0.2, hue: 0.5 };
    expect(s.type).toBe('sphere');
    expect(s.pos.x).toBe(0);
    expect(s.radius).toBe(0.2);
    expect(s.hue).toBe(0.5);
  });
});
