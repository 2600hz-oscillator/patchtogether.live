// packages/web/src/lib/video/loopback-crop.test.ts
//
// Pure-unit checks for LOOPBACK's crop-rectangle math (loopback-crop.ts). No
// GL, no DOM — deterministic on node. Pins the vertical FLIP (top-origin CSS →
// bottom-origin GL sample space) so a future refactor can't silently invert the
// captured region (which would record the WRONG part of the viewport).

import { describe, expect, it } from 'vitest';
import {
  computeCropUv,
  cropRegionAspect,
  FULL_FRAME_CROP,
  type CropUv,
} from './loopback-crop';

const VW = 1600;
const VH = 900; // a 16:9 layout viewport

describe('LOOPBACK — computeCropUv', () => {
  it('a rect covering the whole viewport → the full frame', () => {
    const c = computeCropUv({ x: 0, y: 0, width: VW, height: VH }, VW, VH);
    expect(c).toEqual(FULL_FRAME_CROP);
  });

  it('top-left quadrant → left half u, TOP half maps to the HIGH v band (flip)', () => {
    const c = computeCropUv({ x: 0, y: 0, width: VW / 2, height: VH / 2 }, VW, VH);
    expect(c.u0).toBeCloseTo(0, 6);
    expect(c.u1).toBeCloseTo(0.5, 6);
    // Element occupies the TOP half on screen → after the flip it samples the
    // UPPER (v 0.5..1) band of the texture.
    expect(c.v0).toBeCloseTo(0.5, 6);
    expect(c.v1).toBeCloseTo(1, 6);
  });

  it('bottom-right quadrant → right half u, BOTTOM half maps to the LOW v band', () => {
    const c = computeCropUv(
      { x: VW / 2, y: VH / 2, width: VW / 2, height: VH / 2 },
      VW,
      VH,
    );
    expect(c.u0).toBeCloseTo(0.5, 6);
    expect(c.u1).toBeCloseTo(1, 6);
    expect(c.v0).toBeCloseTo(0, 6);
    expect(c.v1).toBeCloseTo(0.5, 6);
  });

  it('vertical flip is pinned: a thin strip at the TOP samples near v=1', () => {
    const top = computeCropUv({ x: 0, y: 0, width: VW, height: 90 }, VW, VH);
    // Top 10% of the screen → sample band v in [0.9, 1.0].
    expect(top.v0).toBeCloseTo(0.9, 6);
    expect(top.v1).toBeCloseTo(1, 6);
    const bottom = computeCropUv({ x: 0, y: VH - 90, width: VW, height: 90 }, VW, VH);
    // Bottom 10% of the screen → sample band v in [0.0, 0.1].
    expect(bottom.v0).toBeCloseTo(0, 6);
    expect(bottom.v1).toBeCloseTo(0.1, 6);
  });

  it('a rect partially scrolled off the top clamps to the visible slice', () => {
    // Element top is 100px ABOVE the viewport (negative y); only the lower 200px
    // are visible.
    const c = computeCropUv({ x: 0, y: -100, width: VW, height: 300 }, VW, VH);
    expect(c.u0).toBeCloseTo(0, 6);
    expect(c.u1).toBeCloseTo(1, 6);
    // Visible band is screen-y 0..200 → top-origin 0..(200/900) → flipped
    // v in [1 - 200/900, 1] = [0.7777.., 1].
    expect(c.v0).toBeCloseTo(1 - 200 / 900, 6);
    expect(c.v1).toBeCloseTo(1, 6);
  });

  it('degenerate inputs fall back to the full frame', () => {
    expect(computeCropUv({ x: 0, y: 0, width: 0, height: 100 }, VW, VH)).toEqual(FULL_FRAME_CROP);
    expect(computeCropUv({ x: 0, y: 0, width: 100, height: 0 }, VW, VH)).toEqual(FULL_FRAME_CROP);
    expect(computeCropUv({ x: 0, y: 0, width: 100, height: 100 }, 0, VH)).toEqual(FULL_FRAME_CROP);
    expect(computeCropUv({ x: 0, y: 0, width: 100, height: 100 }, VW, 0)).toEqual(FULL_FRAME_CROP);
    // Rect fully below the viewport → collapses after clamp → full frame.
    expect(computeCropUv({ x: 0, y: VH + 50, width: 100, height: 100 }, VW, VH)).toEqual(FULL_FRAME_CROP);
  });
});

describe('LOOPBACK — cropRegionAspect', () => {
  const SW = 1600;
  const SH = 900; // 16:9 capture surface

  it('the full frame reports the surface aspect', () => {
    expect(cropRegionAspect(FULL_FRAME_CROP, SW, SH)).toBeCloseTo(16 / 9, 6);
  });

  it('a centred square-UV crop of a 16:9 surface is still 16:9 (UV is normalized)', () => {
    // Equal UV span on both axes samples equal FRACTIONS, so the pixel aspect
    // equals the surface aspect.
    const c: CropUv = { u0: 0.25, u1: 0.75, v0: 0.25, v1: 0.75 };
    expect(cropRegionAspect(c, SW, SH)).toBeCloseTo(16 / 9, 6);
  });

  it('a wide-UV / short-UV crop is wider than the surface', () => {
    const c: CropUv = { u0: 0, u1: 1, v0: 0.4, v1: 0.6 }; // full width, 20% height
    // aspect = (1*1600) / (0.2*900) = 1600/180 = 8.888..
    expect(cropRegionAspect(c, SW, SH)).toBeCloseTo(1600 / 180, 6);
  });

  it('degenerate surface dims fall back to the default aspect', () => {
    expect(cropRegionAspect(FULL_FRAME_CROP, 0, SH)).toBeCloseTo(4 / 3, 6);
    expect(cropRegionAspect(FULL_FRAME_CROP, SW, 0)).toBeCloseTo(4 / 3, 6);
    expect(cropRegionAspect({ u0: 0.5, u1: 0.5, v0: 0, v1: 1 }, SW, SH)).toBeCloseTo(4 / 3, 6);
  });
});
