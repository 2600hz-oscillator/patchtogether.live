import { describe, it, expect } from 'vitest';
import {
  solveHomography,
  unitToQuad,
  applyHomography,
  invertHomography,
  multiply3,
  toColumnMajor,
  UNIT_QUAD,
  IDENTITY3,
  type Quad,
  type Vec2,
} from './mappy-homography';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const ptNear = (a: Vec2, b: Vec2, eps = 1e-9) => near(a[0], b[0], eps) && near(a[1], b[1], eps);

describe('mappy-homography', () => {
  it('maps every source corner exactly onto its destination corner', () => {
    // an arbitrary non-affine (true perspective) quad
    const dst: Quad = [
      [40, 10],
      [300, 60],
      [260, 220],
      [20, 180],
    ];
    const H = unitToQuad(dst);
    for (let i = 0; i < 4; i++) {
      expect(ptNear(applyHomography(H, UNIT_QUAD[i]), dst[i], 1e-6)).toBe(true);
    }
  });

  it('unit square → unit square is the identity (up to scale)', () => {
    const H = unitToQuad(UNIT_QUAD);
    // center + corners map to themselves
    expect(ptNear(applyHomography(H, [0.5, 0.5]), [0.5, 0.5], 1e-9)).toBe(true);
    expect(ptNear(applyHomography(H, [0, 0]), [0, 0], 1e-9)).toBe(true);
  });

  it('round-trips: invert(H) undoes H on the corners', () => {
    const dst: Quad = [
      [1, 2],
      [9, 1],
      [10, 7],
      [0, 8],
    ];
    const H = unitToQuad(dst);
    const Hinv = invertHomography(H);
    for (let i = 0; i < 4; i++) {
      expect(ptNear(applyHomography(Hinv, dst[i]), UNIT_QUAD[i], 1e-6)).toBe(true);
    }
  });

  it('H · H⁻¹ ≈ identity', () => {
    const dst: Quad = [
      [3, 1],
      [12, 2],
      [11, 9],
      [2, 10],
    ];
    const H = unitToQuad(dst);
    const prod = multiply3(H, invertHomography(H));
    // normalize by prod[8] then compare to identity
    const k = prod[8];
    for (let i = 0; i < 9; i++) {
      expect(near(prod[i]! / k, IDENTITY3[i]!, 1e-6)).toBe(true);
    }
  });

  it('a pure affine map (translate+scale) matches the closed form', () => {
    // unit square scaled by (10,20) and translated by (5,7) → an affine quad
    const dst: Quad = [
      [5, 7],
      [15, 7],
      [15, 27],
      [5, 27],
    ];
    const H = unitToQuad(dst);
    // an interior point maps affinely
    expect(ptNear(applyHomography(H, [0.5, 0.25]), [10, 12], 1e-6)).toBe(true);
    // no perspective term for an affine quad
    expect(near(H[6], 0, 1e-9)).toBe(true);
    expect(near(H[7], 0, 1e-9)).toBe(true);
  });

  it('solveHomography is general (arbitrary src → arbitrary dst)', () => {
    const src: Quad = [
      [2, 3],
      [8, 2],
      [9, 9],
      [1, 8],
    ];
    const dst: Quad = [
      [100, 50],
      [400, 80],
      [380, 300],
      [60, 260],
    ];
    const H = solveHomography(src, dst);
    for (let i = 0; i < 4; i++) {
      expect(ptNear(applyHomography(H, src[i]), dst[i], 1e-5)).toBe(true);
    }
  });

  it('toColumnMajor transposes row-major → column-major for a GLSL mat3', () => {
    const H = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
    expect(toColumnMajor(H)).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
  });

  it('throws on a degenerate (collinear) quad rather than returning NaNs', () => {
    const collinear: Quad = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    expect(() => unitToQuad(collinear)).toThrow();
  });
});
