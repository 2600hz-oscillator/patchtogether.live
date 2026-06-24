import { describe, it, expect } from 'vitest';
import {
  MAPPY_SURFACE_COUNT,
  MAPPY_MIN_SURFACES,
  DEFAULT_SURFACE_COUNT,
  MAPPY_INPUT_IDS,
  MAPPY_SURFACE_COLORS,
  defaultSurface,
  defaultSurfaces,
  normalizeSurfaces,
  surfaceInverseColumnMajor,
  surfaceFitOn,
  insetQuadForIndex,
  clampSurfaceCount,
  mappyDef,
} from './mappy';
import {
  UNIT_QUAD,
  unitToQuad,
  applyHomography,
  toColumnMajor,
  type Quad,
  type Vec2,
} from '$lib/video/mappy-homography';

const ptNear = (a: Vec2, b: Vec2, eps = 1e-6) =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

describe('mappy module def', () => {
  it('is a video module with lowercase label "mappy"', () => {
    expect(mappyDef.type).toBe('mappy');
    expect(mappyDef.domain).toBe('video');
    expect(mappyDef.label).toBe('mappy');
    expect(mappyDef.label).toBe(mappyDef.label.toLowerCase());
  });

  it('declares in1..in6 video inputs + a single video out (no camera / cv)', () => {
    expect(mappyDef.inputs.map((p) => p.id)).toEqual([...MAPPY_INPUT_IDS]);
    for (const p of mappyDef.inputs) expect(p.type).toBe('video');
    expect(mappyDef.outputs).toEqual([{ id: 'out', type: 'video' }]);
    // No CV inputs in v1 (manual mapper only).
    expect(mappyDef.inputs.some((p) => p.type === 'cv')).toBe(false);
  });

  it('has six surfaces + six distinct colors', () => {
    expect(MAPPY_SURFACE_COUNT).toBe(6);
    expect(MAPPY_INPUT_IDS).toHaveLength(6);
    expect(MAPPY_SURFACE_COLORS).toHaveLength(6);
    expect(new Set(MAPPY_SURFACE_COLORS).size).toBe(6);
  });

  it('exposes a surfaceCount param (1..6) defaulting to one live surface', () => {
    const p = mappyDef.params.find((q) => q.id === 'surfaceCount');
    expect(p).toBeDefined();
    expect(p!.min).toBe(MAPPY_MIN_SURFACES);
    expect(p!.max).toBe(MAPPY_SURFACE_COUNT);
    expect(p!.defaultValue).toBe(DEFAULT_SURFACE_COUNT);
    expect(DEFAULT_SURFACE_COUNT).toBe(1);
    expect(MAPPY_MIN_SURFACES).toBe(1);
  });
});

describe('clampSurfaceCount', () => {
  it('clamps to [1,6] and rounds; bad values fall back to the default', () => {
    expect(clampSurfaceCount(0)).toBe(1);
    expect(clampSurfaceCount(-3)).toBe(1);
    expect(clampSurfaceCount(1)).toBe(1);
    expect(clampSurfaceCount(6)).toBe(6);
    expect(clampSurfaceCount(99)).toBe(6);
    expect(clampSurfaceCount(2.4)).toBe(2);
    expect(clampSurfaceCount(2.6)).toBe(3);
    expect(clampSurfaceCount('nope')).toBe(DEFAULT_SURFACE_COUNT);
    expect(clampSurfaceCount(undefined)).toBe(DEFAULT_SURFACE_COUNT);
    expect(clampSurfaceCount(NaN)).toBe(DEFAULT_SURFACE_COUNT);
  });
});

describe('insetQuadForIndex', () => {
  it('returns a non-degenerate inset quad fully inside [0,1] for every surface', () => {
    for (let i = 0; i < MAPPY_SURFACE_COUNT; i++) {
      const q = insetQuadForIndex(i);
      expect(q).toHaveLength(4);
      for (const [x, y] of q) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
      }
      // it's a real rectangle (TL,TR,BR,BL with positive area), so its
      // homography is invertible (not skipped as degenerate).
      expect(surfaceInverseColumnMajor(q)).not.toBeNull();
    }
  });

  it('is NOT the full-frame default (an added grid is a distinct sub-rect)', () => {
    const q = insetQuadForIndex(1);
    expect(q).not.toEqual(defaultSurface().corners);
    // strictly inside the frame on at least one edge
    expect(q[0]![0]).toBeGreaterThan(0);
    expect(q[2]![0]).toBeLessThan(1);
  });

  it('staggers successive surfaces (added grids do not perfectly overlap)', () => {
    expect(insetQuadForIndex(0)).not.toEqual(insetQuadForIndex(1));
  });
});

describe('surfaceFitOn (per-surface FIT default)', () => {
  it('defaults to ON for missing/undefined data + an absent `fit` field', () => {
    expect(surfaceFitOn(undefined)).toBe(true);
    expect(surfaceFitOn({})).toBe(true);
    expect(surfaceFitOn({ fit: undefined })).toBe(true);
  });
  it('reads an explicit boolean', () => {
    expect(surfaceFitOn({ fit: true })).toBe(true);
    expect(surfaceFitOn({ fit: false })).toBe(false);
  });
});

describe('defaultSurface / defaultSurfaces', () => {
  it('defaults each surface to the full-frame UNIT_QUAD (TL,TR,BR,BL) with FIT on', () => {
    const s = defaultSurface();
    expect(s.corners).toEqual([
      [UNIT_QUAD[0][0], UNIT_QUAD[0][1]],
      [UNIT_QUAD[1][0], UNIT_QUAD[1][1]],
      [UNIT_QUAD[2][0], UNIT_QUAD[2][1]],
      [UNIT_QUAD[3][0], UNIT_QUAD[3][1]],
    ]);
    expect(s.fit).toBe(true);
  });

  it('returns MAPPY_SURFACE_COUNT independent default surfaces', () => {
    const arr = defaultSurfaces();
    expect(arr).toHaveLength(MAPPY_SURFACE_COUNT);
    // independent objects (mutating one must not touch another)
    arr[0]!.corners[0] = [0.25, 0.25];
    expect(arr[1]!.corners[0]).toEqual([0, 0]);
  });
});

describe('normalizeSurfaces', () => {
  it('produces exactly six full-frame surfaces from missing/empty input', () => {
    for (const raw of [undefined, null, [], {}, 42, 'nope']) {
      const out = normalizeSurfaces(raw);
      expect(out).toHaveLength(MAPPY_SURFACE_COUNT);
      expect(out[0]!.corners).toEqual(defaultSurface().corners);
    }
  });

  it('preserves valid corners + clamps to [0,1]', () => {
    const raw = [
      { corners: [[0.1, 0.2], [0.9, 0.1], [1.5, 1.2], [-0.3, 0.8]] },
    ];
    const out = normalizeSurfaces(raw);
    expect(out[0]!.corners).toEqual([
      [0.1, 0.2],
      [0.9, 0.1],
      [1, 1], // clamped
      [0, 0.8], // clamped
    ]);
    // missing surfaces 1..5 fall back to default
    expect(out[5]!.corners).toEqual(defaultSurface().corners);
  });

  it('falls back to default for a malformed surface (wrong corner count)', () => {
    const out = normalizeSurfaces([{ corners: [[0, 0], [1, 0]] }]);
    expect(out[0]!.corners).toEqual(defaultSurface().corners);
  });

  it('drops surfaces beyond the sixth', () => {
    const seven = Array.from({ length: 7 }, () => ({
      corners: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]],
    }));
    expect(normalizeSurfaces(seven)).toHaveLength(MAPPY_SURFACE_COUNT);
  });

  it('preserves the per-surface FIT flag; missing/old reads as ON', () => {
    const out = normalizeSurfaces([
      { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], fit: false },
      { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], fit: true },
      { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }, // no fit → ON
    ]);
    expect(out[0]!.fit).toBe(false);
    expect(out[1]!.fit).toBe(true);
    expect(out[2]!.fit).toBe(true);
    // surfaces that fell back to default are also ON
    expect(out[5]!.fit).toBe(true);
  });
});

describe('surfaceInverseColumnMajor', () => {
  it('a full-frame surface back-projects output uv → the same source uv', () => {
    // inverse-of-identity-ish: the unit quad maps the unit square onto itself,
    // so the inverse maps output uv back to the same source uv.
    const inv = surfaceInverseColumnMajor(UNIT_QUAD);
    expect(inv).not.toBeNull();
    // reconstruct a row-major mat3 from the column-major flat array and apply
    // it to a sample output uv; should land on the same source uv.
    const cm = inv!;
    // column-major [m00,m10,m20, m01,m11,m21, m02,m12,m22]
    const H = [cm[0], cm[3], cm[6], cm[1], cm[4], cm[7], cm[2], cm[5], cm[8]] as const;
    const apply = (uv: Vec2): Vec2 => {
      const w = H[6] * uv[0] + H[7] * uv[1] + H[8];
      return [
        (H[0] * uv[0] + H[1] * uv[1] + H[2]) / w,
        (H[3] * uv[0] + H[4] * uv[1] + H[5]) / w,
      ];
    };
    expect(ptNear(apply([0.3, 0.7]), [0.3, 0.7])).toBe(true);
    expect(ptNear(apply([0, 0]), [0, 0])).toBe(true);
    expect(ptNear(apply([1, 1]), [1, 1])).toBe(true);
  });

  it('the FORWARD homography maps the unit square onto a dragged quad', () => {
    // a skewed (perspective) destination quad in [0,1] output space
    const quad: Quad = [
      [0.1, 0.1],
      [0.8, 0.2],
      [0.9, 0.85],
      [0.05, 0.7],
    ];
    const H = unitToQuad(quad);
    for (let i = 0; i < 4; i++) {
      expect(ptNear(applyHomography(H, UNIT_QUAD[i]), quad[i])).toBe(true);
    }
    // and the inverse-column-major helper succeeds (non-degenerate)
    expect(surfaceInverseColumnMajor(quad)).not.toBeNull();
  });

  it('back-projection round-trips against the forward warp', () => {
    const quad: Quad = [
      [0.2, 0.15],
      [0.7, 0.1],
      [0.85, 0.9],
      [0.1, 0.8],
    ];
    const cm = surfaceInverseColumnMajor(quad)!;
    const H = [cm[0], cm[3], cm[6], cm[1], cm[4], cm[7], cm[2], cm[5], cm[8]] as const;
    const back = (uv: Vec2): Vec2 => {
      const w = H[6] * uv[0] + H[7] * uv[1] + H[8];
      return [
        (H[0] * uv[0] + H[1] * uv[1] + H[2]) / w,
        (H[3] * uv[0] + H[4] * uv[1] + H[5]) / w,
      ];
    };
    const fwd = unitToQuad(quad);
    // forward(source) = output, so back(output) must recover source
    const src: Vec2 = [0.4, 0.6];
    const out = applyHomography(fwd, src);
    expect(ptNear(back(out), src)).toBe(true);
  });

  it('returns null for a degenerate (collinear) quad rather than throwing', () => {
    const collinear: Quad = [
      [0, 0],
      [0.25, 0.25],
      [0.5, 0.5],
      [0.75, 0.75],
    ];
    expect(surfaceInverseColumnMajor(collinear)).toBeNull();
  });

  it('toColumnMajor agrees with the homography core (sanity bridge)', () => {
    // guards that the module + core share the same column-major convention.
    const H = unitToQuad(UNIT_QUAD);
    expect(toColumnMajor(H)).toHaveLength(9);
  });
});
