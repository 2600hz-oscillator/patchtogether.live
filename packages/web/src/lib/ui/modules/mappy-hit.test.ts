// mappy-hit.test.ts — pure unit tests for the MAPPY pointer hit-testing used by
// BOTH the card overlay and the full-window MAP editor: corner-grab beats
// interior-move, and interior-move picks the top-most surface under the pointer.

import { describe, it, expect } from 'vitest';
import {
  nearestCornerWithin,
  pointInQuad,
  hitTestSurfaces,
  type Corners,
} from './mappy-hit';

// a centred inset rectangle (TL,TR,BR,BL)
const RECT: Corners = [
  [0.2, 0.2],
  [0.6, 0.2],
  [0.6, 0.6],
  [0.2, 0.6],
];

describe('nearestCornerWithin', () => {
  it('returns the closest corner within the threshold, else -1', () => {
    expect(nearestCornerWithin(RECT, [0.2, 0.2], 0.05)).toBe(0); // exactly TL
    expect(nearestCornerWithin(RECT, [0.61, 0.21], 0.05)).toBe(1); // near TR
    expect(nearestCornerWithin(RECT, [0.4, 0.4], 0.05)).toBe(-1); // centre, none
  });

  it('respects the threshold radius', () => {
    expect(nearestCornerWithin(RECT, [0.24, 0.2], 0.05)).toBe(0); // 0.04 < 0.05
    expect(nearestCornerWithin(RECT, [0.27, 0.2], 0.05)).toBe(-1); // 0.07 > 0.05
  });
});

describe('pointInQuad', () => {
  it('is true inside, false outside a convex rect', () => {
    expect(pointInQuad(RECT, [0.4, 0.4])).toBe(true);
    expect(pointInQuad(RECT, [0.1, 0.4])).toBe(false);
    expect(pointInQuad(RECT, [0.7, 0.7])).toBe(false);
  });

  it('handles a skewed (perspective) quad', () => {
    const skew: Corners = [
      [0.1, 0.1],
      [0.8, 0.2],
      [0.9, 0.85],
      [0.05, 0.7],
    ];
    expect(pointInQuad(skew, [0.4, 0.4])).toBe(true);
    expect(pointInQuad(skew, [0.95, 0.1])).toBe(false);
  });
});

describe('hitTestSurfaces — corner beats interior; top-most surface for move', () => {
  const live = [true, true];

  it('a pointer near a corner returns a corner hit (corner-pin priority)', () => {
    const hit = hitTestSurfaces([{ corners: RECT }], [true], [0.2, 0.2], 0.05);
    expect(hit).toEqual({ kind: 'corner', surface: 0, corner: 0 });
  });

  it('a pointer in the interior (away from corners) returns a move hit', () => {
    const hit = hitTestSurfaces([{ corners: RECT }], [true], [0.4, 0.4], 0.05);
    expect(hit).toEqual({ kind: 'move', surface: 0 });
  });

  it('a pointer in empty space returns null', () => {
    const hit = hitTestSurfaces([{ corners: RECT }], [true], [0.9, 0.9], 0.05);
    expect(hit).toBeNull();
  });

  it('corner of ANY surface beats an interior of another (priority is global)', () => {
    // surface 0 is a big rect; surface 1 has a corner sitting in surface 0's
    // interior. A pointer on that corner must corner-pin surface 1, not move s0.
    const big: Corners = [
      [0.05, 0.05],
      [0.95, 0.05],
      [0.95, 0.95],
      [0.05, 0.95],
    ];
    const small: Corners = [
      [0.4, 0.4], // a corner deep inside `big`
      [0.6, 0.4],
      [0.6, 0.6],
      [0.4, 0.6],
    ];
    const hit = hitTestSurfaces([{ corners: big }, { corners: small }], live, [0.4, 0.4], 0.05);
    expect(hit).toEqual({ kind: 'corner', surface: 1, corner: 0 });
  });

  it('interior-move picks the TOP-MOST (last painter-order) overlapping surface', () => {
    const a: Corners = [
      [0.1, 0.1],
      [0.7, 0.1],
      [0.7, 0.7],
      [0.1, 0.7],
    ];
    const b: Corners = [
      [0.3, 0.3],
      [0.9, 0.3],
      [0.9, 0.9],
      [0.3, 0.9],
    ];
    // (0.5,0.5) is inside both; surface 1 (b) is drawn later → it wins. Use a
    // small threshold so neither surface's corner is within grab range.
    const hit = hitTestSurfaces([{ corners: a }, { corners: b }], live, [0.5, 0.5], 0.02);
    expect(hit).toEqual({ kind: 'move', surface: 1 });
  });

  it('skips non-live surfaces entirely', () => {
    const hit = hitTestSurfaces([{ corners: RECT }], [false], [0.2, 0.2], 0.05);
    expect(hit).toBeNull();
  });

  it('on an exact corner-distance tie, prefers the selected surface', () => {
    // two surfaces with a coincident corner at (0.5,0.5)
    const q1: Corners = [[0.5, 0.5], [0.7, 0.5], [0.7, 0.7], [0.5, 0.7]];
    const q2: Corners = [[0.5, 0.5], [0.3, 0.5], [0.3, 0.3], [0.5, 0.3]];
    const hitSel0 = hitTestSurfaces([{ corners: q1 }, { corners: q2 }], live, [0.5, 0.5], 0.05, 0);
    expect(hitSel0).toEqual({ kind: 'corner', surface: 0, corner: 0 });
    const hitSel1 = hitTestSurfaces([{ corners: q1 }, { corners: q2 }], live, [0.5, 0.5], 0.05, 1);
    expect(hitSel1).toEqual({ kind: 'corner', surface: 1, corner: 0 });
  });
});
