// packages/web/src/lib/video/sourcery-core.test.ts
//
// SOURCERY pure-core correctness gate (unit lane, deterministic, no WebGL, no
// randomness). Pins the CCL, moments/PCA, Hu descriptors, z-score match,
// rel→uvB transform, HSV hue-skew, texture packing, and the amortization
// counter — the algorithm the GLSL fill mirrors. Follows the house pattern of
// colourofmagic-colorspace.test.ts / edges.test.ts.

import { describe, it, expect } from 'vitest';
import {
  labelRegions,
  accumulateRegions,
  selectRegions,
  absorbLabels,
  describeRegion,
  segmentAndDescribe,
  shapeDistance,
  matchRegions,
  buildAffine,
  identityAffine,
  relToUvB,
  hueSkew,
  packLabelTexture,
  packRegionLUT,
  Amortizer,
  computeTransfer,
  type RegionAccum,
  SOURCERY_PROC_W,
  SOURCERY_PROC_H,
  SOURCERY_MAX_REGIONS,
  SOURCERY_LUT_ROWS,
} from './sourcery-core';
import { rgb2hsv } from './colourofmagic-colorspace';

// ── grid builders ─────────────────────────────────────────────────────────

/** Build an edge grid (1 = wall) from a predicate. */
function edgeGrid(w: number, h: number, isWall: (x: number, y: number) => boolean): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = isWall(x, y) ? 1 : 0;
  return g;
}

/** Build a labels array with a single filled rectangle labeled 0 (rest −1). */
function rectLabels(w: number, h: number, x0: number, y0: number, x1: number, y1: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h).fill(-1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) labels[y * w + x] = 0;
  return { labels, count: 1 };
}

// ─────────────────────────── 1. CCL ───────────────────────────

describe('labelRegions — union-find CCL over non-edge pixels', () => {
  it('two boxes split by a vertical edge wall → exactly 2 regions', () => {
    const W = 9, H = 5;
    // column 4 is a wall; left + right halves are separate regions.
    const edge = edgeGrid(W, H, (x) => x === 4);
    const { labels, count } = labelRegions(edge, W, H);
    expect(count).toBe(2);
    // left half is one label, right half another, wall is −1.
    expect(labels[0]).toBe(labels[3]); // (0,0)==(3,0) same region
    expect(labels[5]).toBe(labels[8]); // (5,0)==(8,0) same region
    expect(labels[0]).not.toBe(labels[5]); // different halves
    expect(labels[4]).toBe(-1); // the wall
  });

  it('a fully-walled frame → zero regions', () => {
    const W = 4, H = 4;
    const edge = edgeGrid(W, H, () => true);
    const { count } = labelRegions(edge, W, H);
    expect(count).toBe(0);
  });

  it('an open field → exactly one region', () => {
    const W = 6, H = 6;
    const edge = edgeGrid(W, H, () => false);
    const { count } = labelRegions(edge, W, H);
    expect(count).toBe(1);
  });

  it('a checkerboard of 1px cells separated by walls is bounded (many tiny regions)', () => {
    const W = 8, H = 8;
    // walls on every odd row+col → isolated single-pixel cells at even/even.
    const edge = edgeGrid(W, H, (x, y) => x % 2 === 1 || y % 2 === 1);
    const { count } = labelRegions(edge, W, H);
    // 4×4 = 16 isolated cells.
    expect(count).toBe(16);
    // The min-area cull then removes them all (each is 1px < MIN_AREA).
    const accums = accumulateRegions(labelRegions(edge, W, H).labels, W, H, count);
    const sel = selectRegions(accums, { minArea: 10, maxRegions: 128 });
    expect(sel.finalCount).toBe(0);
  });

  it('L-shaped region stays connected as ONE region (8-way would too, 4-way here)', () => {
    const W = 5, H = 5;
    // walls everywhere except an L (bottom row + left column) → one region.
    const edge = edgeGrid(W, H, (x, y) => !(y === 0 || x === 0));
    const { count } = labelRegions(edge, W, H);
    expect(count).toBe(1);
  });
});

// ─────────────────────────── 2. moments / PCA ───────────────────────────

describe('accumulateRegions + describeRegion — moments / PCA / centroid', () => {
  it('centroid of a centered square is its center', () => {
    const W = 11, H = 11;
    const { labels, count } = rectLabels(W, H, 3, 3, 7, 7); // center (5,5)
    const [acc] = accumulateRegions(labels, W, H, count);
    const d = describeRegion(acc!);
    expect(d.cx).toBeCloseTo(5, 6);
    expect(d.cy).toBeCloseTo(5, 6);
    expect(d.area).toBe(25);
  });

  it('a wide horizontal rectangle has principal angle ≈ 0 (mod π) and high eccentricity', () => {
    const W = 21, H = 11;
    const { labels, count } = rectLabels(W, H, 2, 4, 18, 6); // 17 wide × 3 tall
    const [acc] = accumulateRegions(labels, W, H, count);
    const d = describeRegion(acc!);
    // principal axis is horizontal → θ ≈ 0 (mod π)
    const thetaMod = ((d.theta % Math.PI) + Math.PI) % Math.PI;
    expect(Math.min(thetaMod, Math.PI - thetaMod)).toBeLessThan(0.05);
    expect(d.ecc).toBeGreaterThan(0.8);
    expect(d.lambda1).toBeGreaterThan(d.lambda2);
  });

  it('a tall vertical rectangle has principal angle ≈ π/2 (mod π)', () => {
    const W = 11, H = 21;
    const { labels, count } = rectLabels(W, H, 4, 2, 6, 18); // 3 wide × 17 tall
    const [acc] = accumulateRegions(labels, W, H, count);
    const d = describeRegion(acc!);
    const thetaMod = ((d.theta % Math.PI) + Math.PI) % Math.PI;
    // distance to π/2
    expect(Math.abs(thetaMod - Math.PI / 2)).toBeLessThan(0.05);
    expect(d.ecc).toBeGreaterThan(0.8);
  });

  it('a square is near-isotropic: eccentricity ≈ 0', () => {
    const W = 11, H = 11;
    const { labels, count } = rectLabels(W, H, 3, 3, 7, 7);
    const [acc] = accumulateRegions(labels, W, H, count);
    const d = describeRegion(acc!);
    expect(d.ecc).toBeLessThan(0.05);
  });

  it('circularity: a disk scores higher than a thin sliver', () => {
    const W = 21, H = 21;
    const disk = edgeGrid(W, H, (x, y) => Math.hypot(x - 10, y - 10) > 7); // filled disk r≈7
    const dDisk = segmentAndDescribe(disk, W, H, { minArea: 10 }).descriptors[0]!;
    const sliverLabels = rectLabels(W, H, 2, 10, 18, 10); // 1px tall sliver
    const dSliver = describeRegion(accumulateRegions(sliverLabels.labels, W, H, 1)[0]!);
    expect(dDisk.circularity).toBeGreaterThan(dSliver.circularity);
  });
});

// ─────────────────────────── 3. Hu descriptors + z-score match ───────────────────────────

describe('Hu descriptors + shapeDistance', () => {
  // Build a filled disk (single region) at a given center/radius on a grid.
  function diskDesc(W: number, H: number, cx: number, cy: number, r: number) {
    const g = edgeGrid(W, H, (x, y) => Math.hypot(x - cx, y - cy) > r);
    return segmentAndDescribe(g, W, H, { minArea: 5 }).descriptors[0]!;
  }
  function rectDesc(W: number, H: number, x0: number, y0: number, x1: number, y1: number) {
    const { labels } = rectLabels(W, H, x0, y0, x1, y1);
    return describeRegion(accumulateRegions(labels, W, H, 1)[0]!);
  }

  it('a square vs the SAME square rotated 90° (a tall vs wide rect) has near-zero shape distance', () => {
    // Hu invariants are rotation-invariant: a 5×15 wide rect vs a 15×5 tall rect.
    const wide = rectDesc(31, 31, 5, 13, 19, 17); // 15 wide × 5 tall
    const tall = rectDesc(31, 31, 13, 5, 17, 19); // 5 wide × 15 tall
    expect(shapeDistance(wide, tall)).toBeLessThan(0.2);
  });

  it('a square and a disk have a LARGER shape distance than two squares', () => {
    const squareA = rectDesc(31, 31, 8, 8, 16, 16); // 9×9
    const squareB = rectDesc(31, 31, 12, 12, 18, 18); // 7×7 (different size, same shape)
    const disk = diskDesc(31, 31, 15, 15, 6);
    const dSquares = shapeDistance(squareA, squareB);
    const dSquareDisk = shapeDistance(squareA, disk);
    expect(dSquareDisk).toBeGreaterThan(dSquares);
  });

  it('matchRegions: a big A-square matches the same-SHAPE B-square over a B-disk (shape beats size)', () => {
    // A: one big square. B: [ small square, big disk ]. Shape must win: A→square.
    const aSquare = rectDesc(41, 41, 6, 6, 34, 34); // big 29×29 square
    const bSmallSquare = rectDesc(41, 41, 16, 16, 24, 24); // small 9×9 square
    const bBigDisk = diskDesc(41, 41, 20, 20, 14); // big disk (size-close to A)
    const { match } = matchRegions([aSquare], [bSmallSquare, bBigDisk]);
    // index 0 = the small square (same shape), NOT the size-closer disk.
    expect(match[0]).toBe(0);
  });

  it('size is the tie-break between two same-shape B regions', () => {
    // A big square; B = [ tiny square, big square ] (both squares). Size picks big.
    const aSquare = rectDesc(41, 41, 6, 6, 34, 34);
    const bTiny = rectDesc(41, 41, 19, 19, 21, 21); // 3×3
    const bBig = rectDesc(41, 41, 8, 8, 32, 32); // 25×25
    const { match } = matchRegions([aSquare], [bTiny, bBig]);
    expect(match[0]).toBe(1); // the big square
  });

  it('every A region takes SOME B region (reuse allowed; no −1 when B is non-empty)', () => {
    const a1 = rectDesc(31, 31, 4, 4, 12, 12);
    const a2 = diskDesc(31, 31, 20, 20, 6);
    const b1 = rectDesc(31, 31, 4, 4, 12, 12);
    const { match } = matchRegions([a1, a2], [b1]);
    expect(match[0]).toBe(0);
    expect(match[1]).toBe(0); // reuse of the only B region
  });

  it('hysteresis: a marginally-better challenger does NOT steal the incumbent B', () => {
    const a = rectDesc(31, 31, 8, 8, 16, 16);
    const bIncumbent = rectDesc(31, 31, 8, 8, 16, 16); // identical → distance ~0
    const bChallenger = rectDesc(31, 31, 9, 9, 16, 16); // very slightly different
    const prev = new Int32Array([0]); // last frame chose B[0]
    const { match } = matchRegions([a], [bIncumbent, bChallenger], { prevMatch: prev, hysteresisMargin: 0.5 });
    expect(match[0]).toBe(0); // kept the incumbent under the margin
  });

  it('no B regions → match is all −1 (module falls back to passthrough)', () => {
    const a = rectDesc(31, 31, 8, 8, 16, 16);
    const { match } = matchRegions([a], []);
    expect(match[0]).toBe(-1);
  });
});

// ─────────────────────────── 4. rel→uvB fill transform ───────────────────────────

describe('relToUvB — relative-position color transfer', () => {
  it('identity affine is a passthrough: a pixel maps to its own normalized UV', () => {
    // A square region centered at (64,48), half-extent along axes.
    const d = describeRegion(accumulateRegions(rectLabels(SOURCERY_PROC_W, SOURCERY_PROC_H, 54, 38, 74, 58).labels, SOURCERY_PROC_W, SOURCERY_PROC_H, 1)[0]!);
    const aff = buildAffine(d, d); // A === B
    // the centroid maps to the centroid's normalized UV
    const [u, v] = relToUvB(d.cx, d.cy, aff, 0);
    expect(u).toBeCloseTo(d.cx / SOURCERY_PROC_W, 5);
    expect(v).toBeCloseTo(d.cy / SOURCERY_PROC_H, 5);
    // an off-center pixel also maps to its own normalized UV (identity A→B)
    const px = d.cx + 6, py = d.cy - 4;
    const [u2, v2] = relToUvB(px, py, aff, 0);
    expect(u2).toBeCloseTo(px / SOURCERY_PROC_W, 5);
    expect(v2).toBeCloseTo(py / SOURCERY_PROC_H, 5);
  });

  it('corner colors of a matched (rotated-90°) B square land in the corners of B', () => {
    // A: axis-aligned square. B: same square but θ rotated 90°. Use isotropic
    // procW==procH so the corner geometry is exact.
    const P = 64;
    const sq = describeRegion(accumulateRegions(rectLabels(P, P, 22, 22, 42, 42).labels, P, P, 1)[0]!);
    // Force B's frame to a 90° rotation of A's (same centroid + extents).
    const affRot = {
      ...buildAffine(sq, sq),
      cosB: Math.cos(Math.PI / 2),
      sinB: Math.sin(Math.PI / 2),
    };
    const cx = sq.cx, cy = sq.cy;
    const half = 10; // inside the square's corner
    const corners: Array<[number, number]> = [
      [cx + half, cy + half],
      [cx - half, cy + half],
      [cx - half, cy - half],
      [cx + half, cy - half],
    ];
    const mapped = corners.map(([x, y]) => relToUvB(x, y, affRot, 0, P, P));
    // All four map to DISTINCT UV corners around the centroid (a rotation, not
    // a collapse): each is offset from the centroid on both axes.
    const cu = cx / P, cv = cy / P;
    const seen = new Set<string>();
    for (const [u, v] of mapped) {
      expect(Math.abs(u - cu)).toBeGreaterThan(0.05);
      expect(Math.abs(v - cv)).toBeGreaterThan(0.05);
      seen.add(`${(u > cu ? 'R' : 'L')}${(v > cv ? 'T' : 'B')}`);
    }
    // 4 distinct quadrants covered → a genuine corner permutation.
    expect(seen.size).toBe(4);
  });

  it('rel is clamped to the region extents so sampling stays inside B (uv in [0,1])', () => {
    const P = 64;
    const sq = describeRegion(accumulateRegions(rectLabels(P, P, 22, 22, 42, 42).labels, P, P, 1)[0]!);
    const aff = buildAffine(sq, sq);
    // a pixel far outside the region still yields an in-range, clamped UV
    const [u, v] = relToUvB(sq.cx + 1000, sq.cy + 1000, aff, 0, P, P);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('intra-region ROTATE moves the sampled position (not identity at θ≠0)', () => {
    const P = 64;
    const sq = describeRegion(accumulateRegions(rectLabels(P, P, 22, 22, 42, 42).labels, P, P, 1)[0]!);
    const aff = buildAffine(sq, sq);
    const px = sq.cx + 6, py = sq.cy;
    const [u0] = relToUvB(px, py, aff, 0, P, P);
    const [u1, v1] = relToUvB(px, py, aff, Math.PI / 2, P, P);
    // a 90° intra-region rotation moves the x-offset onto the y axis
    expect(Math.abs(u1 - u0)).toBeGreaterThan(0.02);
    expect(v1).not.toBeCloseTo(sq.cy / P, 2);
  });

  it('identityAffine carries valid=0 (module passthrough flag)', () => {
    const P = 64;
    const sq = describeRegion(accumulateRegions(rectLabels(P, P, 22, 22, 42, 42).labels, P, P, 1)[0]!);
    expect(identityAffine(sq).valid).toBe(0);
    expect(buildAffine(sq, sq).valid).toBe(1);
  });
});

// ─────────────────────────── 5. HSV color-skew ───────────────────────────

describe('hueSkew — HSV hue rotation (colourofmagic mirror)', () => {
  it('skew 0.5 is identity (no hue shift)', () => {
    const rgb: [number, number, number] = [0.8, 0.2, 0.1];
    const out = hueSkew(rgb, 0.5);
    expect(out[0]).toBeCloseTo(rgb[0], 5);
    expect(out[1]).toBeCloseTo(rgb[1], 5);
    expect(out[2]).toBeCloseTo(rgb[2], 5);
  });

  it('skew rotates hue by (skew−0.5)·360°: pure red +120° → green-dominant', () => {
    // red hue = 0; +120° (skew = 0.5 + 120/360) → hue 1/3 = green.
    const out = hueSkew([1, 0, 0], 0.5 + 120 / 360);
    // dominant channel becomes green
    expect(out[1]).toBeGreaterThan(out[0]);
    expect(out[1]).toBeGreaterThan(out[2]);
    // hue of the result ≈ 1/3
    const hsv = rgb2hsv(out);
    expect(hsv[0]).toBeCloseTo(1 / 3, 2);
  });

  it('skew preserves saturation + value (only hue moves)', () => {
    const rgb: [number, number, number] = [0.6, 0.3, 0.2];
    const before = rgb2hsv(rgb);
    const after = rgb2hsv(hueSkew(rgb, 0.7));
    expect(after[1]).toBeCloseTo(before[1], 4);
    expect(after[2]).toBeCloseTo(before[2], 4);
  });

  it('grey stays grey under any skew (saturation 0)', () => {
    const out = hueSkew([0.5, 0.5, 0.5], 0.9);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(0.5, 5);
  });
});

// ─────────────────────────── 6. absorb (all-pixels-labeled) ───────────────────────────

describe('absorbLabels — every pixel carries a surviving region (no holes)', () => {
  it('walls + culled speckle are absorbed into the nearest kept region', () => {
    const W = 16, H = 8;
    // one big region (left 2/3) + a 1px speck at the right, split by a wall col.
    const edge = edgeGrid(W, H, (x) => x === 10);
    const { labels, count } = labelRegions(edge, W, H);
    const accums = accumulateRegions(labels, W, H, count);
    const sel = selectRegions(accums, { minArea: 10, maxRegions: 128 });
    const finalLabels = absorbLabels(labels, W, H, sel.rawToFinal, sel.finalCount);
    // no pixel is unlabeled
    for (let i = 0; i < finalLabels.length; i++) {
      expect(finalLabels[i]).toBeGreaterThanOrEqual(0);
      expect(finalLabels[i]).toBeLessThan(Math.max(1, sel.finalCount));
    }
  });

  it('a wall pixel takes the label of its adjacent region', () => {
    const W = 9, H = 3;
    const edge = edgeGrid(W, H, (x) => x === 4); // wall column 4
    const { labels, count } = labelRegions(edge, W, H);
    const accums = accumulateRegions(labels, W, H, count);
    const sel = selectRegions(accums, { minArea: 3, maxRegions: 128 });
    const finalLabels = absorbLabels(labels, W, H, sel.rawToFinal, sel.finalCount);
    // the wall at (4,1) is absorbed into one of the two neighbours (0 or 1)
    const wall = finalLabels[1 * W + 4]!;
    expect([0, 1]).toContain(wall);
  });
});

// ─────────────────────────── 7. texture packing ───────────────────────────

describe('packLabelTexture + packRegionLUT', () => {
  it('packs region id = R + G·256, opaque alpha', () => {
    const labels = new Int32Array([0, 1, 300, 5]);
    const out = packLabelTexture(labels, 2, 2);
    expect(out[0]).toBe(0); expect(out[1]).toBe(0); // id 0
    expect(out[4]).toBe(1); expect(out[5]).toBe(0); // id 1
    expect(out[8]).toBe(300 & 0xff); expect(out[9]).toBe(300 >> 8); // id 300 → R+G·256
    expect(out[3]).toBe(255); // alpha
  });

  it('reuses a preallocated buffer (zero per-frame alloc)', () => {
    const labels = new Int32Array([2, 3]);
    const buf = new Uint8Array(2 * 4);
    const out = packLabelTexture(labels, 2, 1, buf);
    expect(out).toBe(buf); // same identity
    expect(out[0]).toBe(2);
  });

  it('LUT lays affine fields into the documented texel rows', () => {
    const aff = {
      valid: 1,
      aCx: 10, aCy: 20, cosA: 0.6, sinA: 0.8,
      invSAx: 0.25, invSAy: 0.5,
      bCx: 30, bCy: 40, cosB: 0, sinB: 1,
      sBx: 3, sBy: 4,
    };
    const lut = packRegionLUT([aff], SOURCERY_MAX_REGIONS);
    const width = SOURCERY_MAX_REGIONS;
    const texel = (row: number): number[] => {
      const o = (row * width + 0) * 4;
      return [lut[o]!, lut[o + 1]!, lut[o + 2]!, lut[o + 3]!];
    };
    // Float32Array storage rounds (0.6 → 0.60000002…), so compare per-element
    // with tolerance rather than exact deep-equality.
    const expectTexel = (row: number, want: number[]): void => {
      const got = texel(row);
      for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(want[i]!, 5);
    };
    expectTexel(0, [10, 20, 0.6, 0.8]);
    expectTexel(1, [0.25, 0.5, 1, 0]); // valid flag in .z
    expectTexel(2, [30, 40, 0, 1]);
    expectTexel(3, [3, 4, 0, 0]);
    expect(lut.length).toBe(SOURCERY_MAX_REGIONS * SOURCERY_LUT_ROWS * 4);
  });
});

// ─────────────────────────── 8. amortization / sample-and-hold ───────────────────────────

describe('Amortizer — the mandatory K-frame recompute cadence', () => {
  it('recomputes on frame 0 then every K frames; regenCount is monotonic', () => {
    const am = new Amortizer(3);
    const runs: boolean[] = [];
    for (let i = 0; i < 9; i++) runs.push(am.step());
    // frames 0,3,6 recompute
    expect(runs).toEqual([true, false, false, true, false, false, true, false, false]);
    expect(am.regenCount).toBe(3);
  });

  it('two regens across a K boundary → regenCount +1; reads within a hold window → unchanged', () => {
    const am = new Amortizer(3);
    am.step(); // frame 0 → regen (count 1)
    const c1 = am.regenCount;
    am.step(); // frame 1 → hold
    expect(am.regenCount).toBe(c1); // unchanged within the hold window
    am.step(); // frame 2 → hold
    expect(am.regenCount).toBe(c1);
    am.step(); // frame 3 → regen (count 2)
    expect(am.regenCount).toBe(c1 + 1); // +1 across the boundary
  });

  it('a forced recompute gate regenerates off-cadence', () => {
    const am = new Amortizer(4);
    am.step(); // frame 0 → regen
    const c1 = am.regenCount;
    expect(am.step(true)).toBe(true); // forced despite frame 1
    expect(am.regenCount).toBe(c1 + 1);
  });
});

// ─────────────────────────── 9. end-to-end offline transfer ───────────────────────────

describe('computeTransfer — full offline pipeline is deterministic + hole-free', () => {
  it('two-region A vs two-region B → one affine per A region, all pixels labeled', () => {
    const W = SOURCERY_PROC_W, H = SOURCERY_PROC_H;
    // A: split by a vertical wall (two big halves). B: same.
    const edgeA = edgeGrid(W, H, (x) => x === 63);
    const edgeB = edgeGrid(W, H, (x) => x === 63);
    const r = computeTransfer(edgeA, edgeB, W, H);
    expect(r.affines.length).toBe(2); // one per kept A region
    expect(r.match.length).toBe(2);
    // every A pixel is labeled to a kept region
    for (let i = 0; i < r.finalLabelsA.length; i++) {
      expect(r.finalLabelsA[i]).toBeGreaterThanOrEqual(0);
      expect(r.finalLabelsA[i]).toBeLessThan(2);
    }
    // matched B indices are valid
    for (const m of r.match) { expect(m).toBeGreaterThanOrEqual(0); expect(m).toBeLessThan(2); }
  });

  it('B empty (no regions after cull) → every A affine is a passthrough (valid=0)', () => {
    const W = SOURCERY_PROC_W, H = SOURCERY_PROC_H;
    const edgeA = edgeGrid(W, H, (x) => x === 63);
    const edgeB = edgeGrid(W, H, () => true); // all walls → 0 B regions
    const r = computeTransfer(edgeA, edgeB, W, H);
    for (const aff of r.affines) expect(aff.valid).toBe(0);
  });

  it('is deterministic: identical inputs → identical labels + match', () => {
    const W = SOURCERY_PROC_W, H = SOURCERY_PROC_H;
    const edgeA = edgeGrid(W, H, (x, y) => x === 40 || y === 50);
    const edgeB = edgeGrid(W, H, (x) => x === 63);
    const r1 = computeTransfer(edgeA, edgeB, W, H);
    const r2 = computeTransfer(edgeA, edgeB, W, H);
    expect(Array.from(r1.match)).toEqual(Array.from(r2.match));
    expect(Array.from(r1.finalLabelsA)).toEqual(Array.from(r2.finalLabelsA));
  });
});
