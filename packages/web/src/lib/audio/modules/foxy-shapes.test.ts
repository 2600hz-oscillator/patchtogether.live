// packages/web/src/lib/audio/modules/foxy-shapes.test.ts
//
// Unit tests for the 3dShapeGen pure path: feature-grid + peak extraction,
// per-type SDFs, voxel scan, wavetable scan. No canvas, no GL, no
// AudioContext.

import { describe, expect, it } from 'vitest';
import {
  FOXY_3D_VOXEL_GRID,
  FOXY_3D_FEATURE_GRID,
  FOXY_3D_TARGET_SHAPES,
  FOXY_SHAPE_TYPES,
  generateShapes,
  featureGrid,
  variance,
  extractPeaks,
  sdfSphere,
  sdfCube,
  sdfCone,
  sdfCylinder,
  sdfRing,
  sdfTetraFrame,
  sdf,
  smin,
  scanShapesToVoxels,
  voxelsToWavetable,
  sampleVoxelSlice,
  shapesPipeline,
  type Shape,
} from './foxy-shapes';
import { FOXY_FIELD_SIZE, FOXY_WT_FRAMES, FOXY_WT_SAMPLES } from './foxy-map';

// ── Small fixtures ────────────────────────────────────────────────────────

/** Build an RGBA buffer of size w*h*4. `fill(x,y)` returns luma ∈ [0,1]. */
function buildRgba(w: number, h: number, fill: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = Math.max(0, Math.min(1, fill(x, y)));
      const v = Math.round(l * 255);
      const o = (y * w + x) * 4;
      out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
    }
  }
  return out;
}

/** Flat-gray buffer (luma = `l` everywhere). */
function flat(w: number, h: number, l = 0.5): Uint8ClampedArray {
  return buildRgba(w, h, () => l);
}

/** A few discrete bright spots — easy to predict the top-K peak positions. */
function bright3Spots(w: number, h: number): Uint8ClampedArray {
  // Three Gaussian-ish bumps at (0.25, 0.25), (0.75, 0.25), (0.5, 0.75).
  const centers: [number, number][] = [[0.25, 0.25], [0.75, 0.25], [0.5, 0.75]];
  return buildRgba(w, h, (x, y) => {
    const nx = x / (w - 1);
    const ny = y / (h - 1);
    let m = 0;
    for (const c of centers) {
      const dx = nx - c[0];
      const dy = ny - c[1];
      const d2 = dx * dx + dy * dy;
      m = Math.max(m, Math.exp(-d2 * 80));
    }
    return m;
  });
}

// ── featureGrid / variance ────────────────────────────────────────────────

describe('foxy-shapes — feature extraction primitives', () => {
  it('featureGrid: flat source → all cells share the same mean', () => {
    const W = 64;
    const g = featureGrid(flat(W, W, 0.5), W, W, 8);
    expect(g.length).toBe(64);
    // 8-bit luma round-trip adds 1/255 ≈ 0.004 residual; precision 2 is fine.
    for (const v of g) expect(v).toBeCloseTo(0.5, 2);
  });

  it('variance: flat array is 0; non-flat is > 0', () => {
    expect(variance(new Float32Array([1, 1, 1, 1]))).toBeCloseTo(0, 6);
    expect(variance(new Float32Array([0, 1, 0, 1]))).toBeGreaterThan(0.1);
  });

  it('extractPeaks: top-3 picks the 3 bright spots, NMS prevents adjacent doubles', () => {
    // Grid: 8x8, three bright cells far apart from each other.
    const grid = new Float32Array(64);
    grid[1 * 8 + 1] = 1.0;
    grid[2 * 8 + 6] = 0.8;
    grid[6 * 8 + 3] = 0.6;
    // Plant a "decoy" right next to the top cell — NMS should reject it.
    grid[1 * 8 + 2] = 0.99;
    const peaks = extractPeaks(grid, 8, 3, 1);
    expect(peaks).toHaveLength(3);
    expect(peaks[0]).toMatchObject({ row: 1, col: 1 });
    expect(peaks[1]).toMatchObject({ row: 2, col: 6 });
    expect(peaks[2]).toMatchObject({ row: 6, col: 3 });
  });

  it('extractPeaks: all-zero grid → empty result', () => {
    const grid = new Float32Array(64);
    expect(extractPeaks(grid, 8, 4)).toHaveLength(0);
  });
});

// ── generateShapes (determinism + flat-A early-out + Shape ranges) ────────

describe('foxy-shapes — generateShapes()', () => {
  it('is deterministic — same rasters → same shape list', () => {
    const W = FOXY_FIELD_SIZE;
    const A = bright3Spots(W, W);
    // Independent B/C with predictable patterns.
    const B = buildRgba(W, W, (x) => x / (W - 1));
    const C = buildRgba(W, W, (x, y) => (x + y) / (2 * (W - 1)));
    const s1 = generateShapes(A, B, C, W, W);
    const s2 = generateShapes(A, B, C, W, W);
    expect(s1).toEqual(s2);
    expect(s1.length).toBeGreaterThan(0);
  });

  it('flat raster A → empty shape list (no NaN, no crash)', () => {
    const W = 64;
    const A = flat(W, W, 0.5);
    const B = flat(W, W, 0.3);
    const C = flat(W, W, 0.7);
    const shapes = generateShapes(A, B, C, W, W);
    expect(shapes).toEqual([]);
  });

  it('produces ≤ TARGET_SHAPES, every shape with valid type + ranges', () => {
    const W = FOXY_FIELD_SIZE;
    const A = bright3Spots(W, W);
    const B = buildRgba(W, W, () => 0.6);
    const C = buildRgba(W, W, (x) => x / (W - 1));
    const shapes = generateShapes(A, B, C, W, W);
    expect(shapes.length).toBeLessThanOrEqual(FOXY_3D_TARGET_SHAPES);
    for (const sh of shapes) {
      // Type ∈ enum
      expect(FOXY_SHAPE_TYPES).toContain(sh.type);
      // Position ∈ [-1, 1]
      expect(sh.pos.x).toBeGreaterThanOrEqual(-1);
      expect(sh.pos.x).toBeLessThanOrEqual(1);
      expect(sh.pos.y).toBeGreaterThanOrEqual(-1);
      expect(sh.pos.y).toBeLessThanOrEqual(1);
      expect(sh.pos.z).toBeGreaterThanOrEqual(-1);
      expect(sh.pos.z).toBeLessThanOrEqual(1);
      // Radius ∈ [0.05, 0.3]
      expect(sh.radius).toBeGreaterThanOrEqual(0.05);
      expect(sh.radius).toBeLessThanOrEqual(0.31);
      // Hue ∈ [0, 1]
      expect(sh.hue).toBeGreaterThanOrEqual(0);
      expect(sh.hue).toBeLessThanOrEqual(1);
    }
  });

  it('uses NMS — the three bright spots resolve to three distinct shape positions', () => {
    const W = FOXY_FIELD_SIZE;
    const A = bright3Spots(W, W);
    const B = flat(W, W, 0.5);
    const C = flat(W, W, 0.5);
    const shapes = generateShapes(A, B, C, W, W);
    // The three centers should be the first three peaks; check they're all
    // at distinct grid positions (NMS prevents duplicates).
    const xys = shapes.slice(0, 3).map((s) => `${Math.round(s.pos.x * 10)},${Math.round(s.pos.y * 10)}`);
    const unique = new Set(xys);
    expect(unique.size).toBe(3);
  });
});

// ── SDF math per shape type ───────────────────────────────────────────────

describe('foxy-shapes — SDFs', () => {
  it('sdfSphere: at origin r=0.5, (0.5,0,0) → 0; (0.6,0,0) → +0.1 (outside)', () => {
    expect(sdfSphere(0.5, 0, 0, 0.5)).toBeCloseTo(0, 6);
    expect(sdfSphere(0.6, 0, 0, 0.5)).toBeCloseTo(0.1, 6);
    // Inside: distance is negative.
    expect(sdfSphere(0.3, 0, 0, 0.5)).toBeCloseTo(-0.2, 6);
  });

  it('sdfCube: half-extent 0.5, face center → 0; outside corner → positive', () => {
    expect(sdfCube(0.5, 0, 0, 0.5)).toBeCloseTo(0, 6);
    expect(sdfCube(0.6, 0, 0, 0.5)).toBeCloseTo(0.1, 6);
    // Inside center → negative (–r).
    expect(sdfCube(0, 0, 0, 0.5)).toBeCloseTo(-0.5, 6);
  });

  it('sdfCone: at apex (0,−r,0) value > 0 (outside cone base); inside core negative', () => {
    // Apex of our cone is at origin opening down; (0, −r/2, 0) is OUTSIDE
    // the cone (above the apex). The point INSIDE is somewhere along
    // +y from the apex down to y=+r at the base.
    const r = 0.5;
    // Definitely-inside point: (0, +0.3, 0) — well below the 0-radius apex
    // and well above the y = r base cap.
    const inside = sdfCone(0, 0.3, 0, r);
    expect(inside).toBeLessThan(0);
    // Definitely-outside: far above the apex.
    const above = sdfCone(0, -2, 0, r);
    expect(above).toBeGreaterThan(0);
  });

  it('sdfCylinder: radial 0 + axial 0 → −r (deep inside)', () => {
    expect(sdfCylinder(0, 0, 0, 0.5)).toBeCloseTo(-0.5, 6);
    // At surface (radius r, axial 0): 0.
    expect(sdfCylinder(0.5, 0, 0, 0.5)).toBeCloseTo(0, 6);
    // Outside radially.
    expect(sdfCylinder(0.7, 0, 0, 0.5)).toBeCloseTo(0.2, 6);
  });

  it('sdfRing: torus inner ring point (r, 0, 0) → minor radius', () => {
    const r = 0.5;
    const minor = r * 0.3;
    // (r, 0, 0): inside the donut hole at z=0 on the +x ring axis is on the
    // CIRCLE of the major radius → minor surface → SDF = 0 - minor + minor = ?
    // Actually point lies ON the major-radius circle so the (length(p.xz) - r)
    // term is 0, then SDF = length(0, py) - minor = 0 - minor = -minor.
    expect(sdfRing(r, 0, 0, r)).toBeCloseTo(-minor, 6);
    // Far from the donut.
    expect(sdfRing(5, 5, 5, r)).toBeGreaterThan(0);
  });

  it('sdfTetraFrame: origin should be OUTSIDE the thin shell (inside the hollow)', () => {
    // The tet center is hollow (the SDF returns the SHELL distance), so the
    // center should be OUTSIDE the shell → positive SDF.
    expect(sdfTetraFrame(0, 0, 0, 0.5)).toBeGreaterThan(0);
  });

  it('sdf dispatcher: respects shape.pos translation', () => {
    const sh: Shape = { type: 'sphere', pos: { x: 0.5, y: 0, z: 0 }, radius: 0.2, hue: 0 };
    // (0.5, 0, 0) is the CENTER of this shape → sdf returns -0.2 (deep inside).
    expect(sdf(sh, 0.5, 0, 0)).toBeCloseTo(-0.2, 6);
    // (0.7, 0, 0) is exactly on the surface.
    expect(sdf(sh, 0.7, 0, 0)).toBeCloseTo(0, 6);
  });

  it('smin: equal inputs → blend below the min by ln(2)/k; large diff → ≈ min', () => {
    const k = 8;
    expect(smin(0.5, 0.5, k)).toBeCloseTo(0.5 - Math.log(2) / k, 6);
    // a much smaller than b → smin ≈ a.
    expect(smin(0.01, 10, k)).toBeCloseTo(0.01, 4);
  });
});

// ── Voxel scan ────────────────────────────────────────────────────────────

describe('foxy-shapes — scanShapesToVoxels()', () => {
  it('returns a GRID^3 Float32Array, all values in [-1, 1], no NaN', () => {
    const shapes: Shape[] = [
      { type: 'sphere', pos: { x: 0, y: 0, z: 0 }, radius: 0.3, hue: 0.2 },
      { type: 'cube',   pos: { x: 0.5, y: 0.3, z: -0.2 }, radius: 0.2, hue: 0.5 },
    ];
    const voxels = scanShapesToVoxels(shapes);
    expect(voxels.length).toBe(FOXY_3D_VOXEL_GRID ** 3);
    for (let i = 0; i < voxels.length; i++) {
      const v = voxels[i]!;
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('empty shape list → every voxel = -1 (outside everywhere)', () => {
    const voxels = scanShapesToVoxels([]);
    expect(voxels.every((v) => v === -1)).toBe(true);
  });

  it('center of a sphere at origin = +1 (inside)', () => {
    const shapes: Shape[] = [
      { type: 'sphere', pos: { x: 0, y: 0, z: 0 }, radius: 0.5, hue: 0 },
    ];
    const voxels = scanShapesToVoxels(shapes);
    // The center voxel index when GRID is even is between the two middle
    // cells — both should clamp to +1 (deep inside r=0.5).
    const c = Math.floor(FOXY_3D_VOXEL_GRID / 2);
    const idx = (c * FOXY_3D_VOXEL_GRID + c) * FOXY_3D_VOXEL_GRID + c;
    expect(voxels[idx]).toBeCloseTo(1, 4);
  });
});

// ── Wavetable scan ───────────────────────────────────────────────────────

describe('foxy-shapes — voxelsToWavetable()', () => {
  it('returns FRAMES × SAMPLES, all in [-1, 1], no NaN', () => {
    const shapes: Shape[] = [
      { type: 'sphere', pos: { x: 0, y: 0, z: 0 }, radius: 0.4, hue: 0.5 },
    ];
    const voxels = scanShapesToVoxels(shapes);
    const wt = voxelsToWavetable(voxels);
    expect(wt.length).toBe(FOXY_WT_FRAMES);
    for (const frame of wt) {
      expect(frame.length).toBe(FOXY_WT_SAMPLES);
      for (const v of frame) {
        expect(Number.isNaN(v)).toBe(false);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('frame 0 and frame 63 differ when a non-degenerate shape exists ' +
     '(proves the Z-slice sweep is moving)', () => {
    // A sphere placed at z = +0.5 means frame 0 (z = -1, far back) sees
    // mostly empty space, frame 63 (z = +1, front) traverses near the
    // sphere's center → very different signatures.
    const shapes: Shape[] = [
      { type: 'sphere', pos: { x: 0, y: 0, z: 0.5 }, radius: 0.4, hue: 0 },
    ];
    const voxels = scanShapesToVoxels(shapes);
    const wt = voxelsToWavetable(voxels);
    // Sum-abs energy per frame.
    function energy(frame: number[]): number {
      let acc = 0;
      for (const v of frame) acc += Math.abs(v);
      return acc;
    }
    const e0 = energy(wt[0]!);
    const eN = energy(wt[wt.length - 1]!);
    expect(Math.abs(e0 - eN)).toBeGreaterThan(0.5);
  });

  it('returns plain number[][] (wire format) — not Float32Array per-frame', () => {
    const shapes: Shape[] = [
      { type: 'sphere', pos: { x: 0, y: 0, z: 0 }, radius: 0.3, hue: 0 },
    ];
    const voxels = scanShapesToVoxels(shapes);
    const wt = voxelsToWavetable(voxels);
    expect(Array.isArray(wt)).toBe(true);
    expect(Array.isArray(wt[0])).toBe(true);
    // Verify no Float32Array sneaks in.
    expect(wt[0] instanceof Float32Array).toBe(false);
  });
});

// ── Sanity: wavetable carries shape structure (not silent) ────────────────

describe('foxy-shapes — audible-character sanity', () => {
  it('a sphere/cube/ring scene produces non-trivial intra-frame variance', () => {
    // The whole pipeline; a few shapes scattered through the box. Walks
    // through them at non-trivial intra-frame variance.
    const shapes: Shape[] = [
      { type: 'sphere',   pos: { x: -0.3, y: -0.3, z: -0.3 }, radius: 0.25, hue: 0.1 },
      { type: 'cube',     pos: { x:  0.4, y:  0.0, z:  0.0 }, radius: 0.2,  hue: 0.4 },
      { type: 'ring',     pos: { x:  0.0, y:  0.4, z:  0.4 }, radius: 0.25, hue: 0.7 },
    ];
    const voxels = scanShapesToVoxels(shapes);
    const wt = voxelsToWavetable(voxels);
    // Frame variance across all frames — must be non-trivial.
    let totalVar = 0;
    for (const frame of wt) {
      let mean = 0;
      for (const v of frame) mean += v;
      mean /= frame.length;
      let v2 = 0;
      for (const v of frame) {
        const d = v - mean;
        v2 += d * d;
      }
      totalVar += v2 / frame.length;
    }
    expect(totalVar).toBeGreaterThan(0.01);
  });

  it('shapesPipeline: deterministic end-to-end + non-empty for non-flat A', () => {
    const W = FOXY_FIELD_SIZE;
    const A = bright3Spots(W, W);
    const B = buildRgba(W, W, (x) => x / (W - 1));
    const C = buildRgba(W, W, (_, y) => y / (W - 1));
    const r1 = shapesPipeline(A, B, C, W, W);
    const r2 = shapesPipeline(A, B, C, W, W);
    expect(r1.shapes.length).toBeGreaterThan(0);
    expect(r1.wavetable.length).toBe(FOXY_WT_FRAMES);
    expect(r1.wavetable).toEqual(r2.wavetable);
  });
});

// ── sampleVoxelSlice (bilinear edge cases) ────────────────────────────────

describe('foxy-shapes — sampleVoxelSlice()', () => {
  it('returns exact cell value at integer (x, y, z)', () => {
    const G = 4;
    const voxels = new Float32Array(G * G * G);
    voxels[2 * G * G + 1 * G + 3] = 0.75; // z=2, y=1, x=3
    expect(sampleVoxelSlice(voxels, G, 3, 1, 2)).toBeCloseTo(0.75, 6);
  });

  it('clamps out-of-bounds coords to the edge', () => {
    const G = 4;
    const voxels = new Float32Array(G * G * G);
    voxels[0] = 0.5; // (0,0,0)
    expect(sampleVoxelSlice(voxels, G, -1, -1, -1)).toBeCloseTo(0.5, 6);
  });
});
