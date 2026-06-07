// packages/web/src/lib/video/video-res.test.ts
//
// Unit coverage for the pure aspect → resolution math (no GL). Covers the
// LOCKED spec: 4:3 = 1024×768, 16:9 = 1366×768 (even-rounded), the fitRect
// letterbox-vs-pillarbox math, the per-source fill/letterbox scale, and the
// Native-aspect predicate.

import { describe, it, expect } from 'vitest';
import {
  aspectRes,
  aspectRatio,
  aspectFitScale,
  isNativeAspect,
  coerceAspect,
  fitRect,
  VIDEO_RES,
  BASE_HEIGHT,
  DEFAULT_ASPECT,
} from './video-res';

describe('aspectRes — height-anchored at 768', () => {
  it('4:3 → 1024×768 (the unchanged #662 default)', () => {
    expect(aspectRes('4:3')).toEqual({ width: 1024, height: 768 });
    // Byte-identical to VIDEO_RES (existing patches/baselines stay identical).
    expect(aspectRes('4:3')).toEqual({ width: VIDEO_RES.width, height: VIDEO_RES.height });
  });

  it('16:9 → 1366×768 (1365.33 even-rounded UP to 1366, same height)', () => {
    expect(aspectRes('16:9')).toEqual({ width: 1366, height: 768 });
  });

  it('both aspects share BASE_HEIGHT (height-anchored)', () => {
    expect(aspectRes('4:3').height).toBe(BASE_HEIGHT);
    expect(aspectRes('16:9').height).toBe(BASE_HEIGHT);
    expect(BASE_HEIGHT).toBe(768);
  });

  it('16:9 width is EVEN (chroma-friendly, no odd-pixel artifacts)', () => {
    expect(aspectRes('16:9').width % 2).toBe(0);
    expect(aspectRes('4:3').width % 2).toBe(0);
  });

  it('16:9 is wider than 4:3 (only the width grows)', () => {
    expect(aspectRes('16:9').width).toBeGreaterThan(aspectRes('4:3').width);
    expect(aspectRes('16:9').height).toBe(aspectRes('4:3').height);
  });

  it('the default aspect is 4:3', () => {
    expect(DEFAULT_ASPECT).toBe('4:3');
    expect(aspectRes(DEFAULT_ASPECT)).toEqual({ width: 1024, height: 768 });
  });
});

describe('aspectRatio + coerceAspect', () => {
  it('numeric ratios', () => {
    expect(aspectRatio('4:3')).toBeCloseTo(4 / 3, 6);
    expect(aspectRatio('16:9')).toBeCloseTo(16 / 9, 6);
  });
  it('coerce defaults non-16:9 input to 4:3', () => {
    expect(coerceAspect('16:9')).toBe('16:9');
    expect(coerceAspect('4:3')).toBe('4:3');
    expect(coerceAspect('garbage')).toBe('4:3');
    expect(coerceAspect(undefined)).toBe('4:3');
    expect(coerceAspect(null)).toBe('4:3');
  });
});

describe('fitRect — letterbox vs pillarbox', () => {
  it('16:9 source in a 4:3 dst → top/bottom LETTERBOX (full width)', () => {
    const r = fitRect(16 / 9, 1024, 768);
    expect(r.w).toBe(1024); // full width
    expect(r.x).toBe(0);
    expect(r.h).toBeLessThan(768); // shrunk height
    expect(r.y).toBeGreaterThan(0); // centered bars
  });

  it('4:3 source in a 16:9 dst → left/right PILLARBOX (full height)', () => {
    const r = fitRect(4 / 3, 1366, 768);
    expect(r.h).toBe(768); // full height
    expect(r.y).toBe(0);
    expect(r.w).toBeLessThan(1366); // shrunk width
    expect(r.x).toBeGreaterThan(0); // centered bars
  });

  it('matching aspect → full-bleed (no bars)', () => {
    const r = fitRect(4 / 3, 1024, 768);
    expect(r).toEqual({ x: 0, y: 0, w: 1024, h: 768 });
  });

  it('degenerate dst → zero rect', () => {
    expect(fitRect(4 / 3, 0, 768)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(fitRect(4 / 3, 1024, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('aspectFitScale — per-source fill (cover) vs letterbox (contain)', () => {
  it('FILL: 16:9 source into 4:3 canvas → crop width (sx>1), full height', () => {
    const { sx, sy } = aspectFitScale(16 / 9, 4 / 3, 'fill');
    expect(sx).toBeGreaterThan(1);
    expect(sy).toBe(1);
  });

  it('FILL: 4:3 source into 16:9 canvas → crop height (sy>1), full width', () => {
    const { sx, sy } = aspectFitScale(4 / 3, 16 / 9, 'fill');
    expect(sx).toBe(1);
    expect(sy).toBeGreaterThan(1);
  });

  it('LETTERBOX: 16:9 source into 4:3 canvas → shrink height (sy<1), full width', () => {
    const { sx, sy } = aspectFitScale(16 / 9, 4 / 3, 'letterbox');
    expect(sx).toBe(1);
    expect(sy).toBeLessThan(1);
  });

  it('LETTERBOX: 4:3 source into 16:9 canvas → shrink width (sx<1), full height', () => {
    const { sx, sy } = aspectFitScale(4 / 3, 16 / 9, 'letterbox');
    expect(sx).toBeLessThan(1);
    expect(sy).toBe(1);
  });

  it('matching aspect → (1,1) in BOTH modes (nothing to fit)', () => {
    expect(aspectFitScale(4 / 3, 4 / 3, 'fill')).toEqual({ sx: 1, sy: 1 });
    expect(aspectFitScale(4 / 3, 4 / 3, 'letterbox')).toEqual({ sx: 1, sy: 1 });
  });

  it('camera cover-fill: 16:9 webcam into 16:9 canvas = exact fit (no crop)', () => {
    // After a 16:9 switch a 16:9 webcam fills edge-to-edge with no crop.
    expect(aspectFitScale(16 / 9, 16 / 9, 'fill')).toEqual({ sx: 1, sy: 1 });
  });

  it('degenerate inputs → (1,1)', () => {
    expect(aspectFitScale(0, 4 / 3, 'fill')).toEqual({ sx: 1, sy: 1 });
    expect(aspectFitScale(4 / 3, 0, 'letterbox')).toEqual({ sx: 1, sy: 1 });
    expect(aspectFitScale(NaN, NaN, 'fill')).toEqual({ sx: 1, sy: 1 });
  });
});

describe('isNativeAspect — the Native-badge predicate', () => {
  it('4:3 source is Native in 4:3 output', () => {
    expect(isNativeAspect(4 / 3, aspectRatio('4:3'))).toBe(true);
  });
  it('4:3 source is NOT Native in 16:9 output', () => {
    expect(isNativeAspect(4 / 3, aspectRatio('16:9'))).toBe(false);
  });
  it('16:9 source is Native in 16:9 output', () => {
    expect(isNativeAspect(16 / 9, aspectRatio('16:9'))).toBe(true);
  });
  it('within tolerance counts as Native (8:7 SNES vs 4:3 ~ not native)', () => {
    // SNES 256:224 = 8:7 ≈ 1.143; 4:3 ≈ 1.333 → far enough apart → NOT native.
    expect(isNativeAspect(8 / 7, 4 / 3)).toBe(false);
    // A whisker off 4:3 is still native (the 0.02 tolerance).
    expect(isNativeAspect(1.334, 4 / 3)).toBe(true);
  });
  it('degenerate inputs → false', () => {
    expect(isNativeAspect(0, 4 / 3)).toBe(false);
    expect(isNativeAspect(4 / 3, 0)).toBe(false);
  });
});
