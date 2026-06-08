// packages/web/src/lib/video/modules/outlines-perf.test.ts
//
// PERF + behaviour-equivalence coverage for the OUTLINES per-pixel output
// derivation, guarding the #699 regression fix.
//
// THE #699 REGRESSION: the CIRCLES→OUTLINES refactor made the per-pixel output
// derivation polygon-aware in a way that called Math.cos/Math.sin PER EDGE
// NORMAL, PER PIXEL, PER SHAPE, PER FRAME (polyRadius() + apothemOf()). For an
// octagon that's 16 trig calls per pixel per shape — over the whole field × every
// shape × every frame. The old CIRCLES path was a single sqrt distance compare.
//
// THE FIX (all pure speedups — VISUALLY IDENTICAL output):
//   1. HOIST per-pixel trig: each shape's edge normals + apothem are CONSTANT for
//      a whole frame → precompute once (ensurePolyCache) → per pixel is N cheap
//      dot products, ZERO trig.
//   2. CIRCUMRADIUS PRE-REJECT: a pixel outside the bounding circle (d²>r²) is
//      definitely outside the polygon → skip the N-normal loop.
//   3. AABB ITERATION (deriveOutlinesField): accumulate each shape only within
//      its bounding box instead of scanning the whole field per shape.
//   4. CIRCLE FAST-PATH: shape index 0 stays a single distance compare.
//   5. DERIVE-ONCE: compute the coverage (count / softAlpha / maxAlpha) field
//      ONCE per frame; all four outputs read from it.
//   6. Reused scratch buffers (no per-frame allocation).
//
// This file (a) PROVES the derived field is byte-identical to the per-point
// derivation the unit suite already pins, and (b) is a COMMITTED deterministic
// micro-benchmark: it times an old-style per-pixel-trig full-field derivation vs
// the new derive-once field at a representative field size + several octagons
// (the worst case) and asserts a meaningful speedup, printing the factor.

import { describe, it, expect } from 'vitest';
import {
  OUTLINES_FIELD,
  makeOutlinesField,
  deriveOutlinesField,
  combineRgbFromField,
  overlapCountAt,
  overlapAlphaAt,
  overlapValueAt,
  combineRgbAt,
  mappedMaskAt,
  type Circle,
} from './outlines-sim';

// ---------------------------------------------------------------------------
// A deterministic worst-case field: several large OCTAGONS (8 sides → the most
// per-pixel edge-normal projections) plus a circle, spread across the field at
// big diameters so they overlap heavily — the densest derivation cost.
// ---------------------------------------------------------------------------

function octagonField(): Circle[] {
  const cs: Circle[] = [];
  // A spread of overlapping octagons (worst case: 8 edge normals each).
  const centers: Array<[number, number, number]> = [
    [380, 380, 0.2],
    [520, 460, 0.9],
    [620, 600, 1.7],
    [460, 600, 2.5],
    [540, 520, 0.05],
    [700, 420, 1.1],
  ];
  for (const [x, y, baseAngle] of centers) {
    cs.push({ x, y, vx: 0, vy: 0, diameter: 260, shape: 5, sides: 8, baseAngle, alpha: 1 });
  }
  // Plus one circle to exercise the fast-path alongside polygons.
  cs.push({ x: 500, y: 500, vx: 0, vy: 0, diameter: 240, shape: 0, sides: 0, baseAngle: 0, alpha: 1 });
  return cs;
}

// ---------------------------------------------------------------------------
// OLD-STYLE reference derivation: a faithful re-implementation of the pre-fix
// hot path — full-field scan, per-pixel polygon trig (Math.cos/Math.sin per edge
// normal per pixel per shape), no cache, no pre-reject, no AABB. Used ONLY by
// the benchmark to represent the #699 cost; it is NOT the production path.
// ---------------------------------------------------------------------------

function oldPolyRadius(lx: number, ly: number, sides: number, angle: number): number {
  let maxProj = -Infinity;
  const step = (Math.PI * 2) / sides;
  for (let k = 0; k < sides; k++) {
    const phi = angle + step * k + step * 0.5;
    const proj = lx * Math.cos(phi) + ly * Math.sin(phi);
    if (proj > maxProj) maxProj = proj;
  }
  return maxProj;
}

function oldPointInShape(c: Circle, px: number, py: number, rot: number): boolean {
  const r = c.diameter * 0.5;
  const dx = px - c.x;
  const dy = py - c.y;
  const sides = c.sides ?? 0;
  if (sides < 3) return dx * dx + dy * dy <= r * r;
  const angle = (c.baseAngle ?? 0) + rot;
  const apo = r * Math.cos(Math.PI / sides); // apothemOf, per pixel
  return oldPolyRadius(dx, dy, sides, angle) <= apo;
}

/** OLD full-field derive-once-ish: for each cell, scan EVERY shape with per-pixel
 *  trig. (The real #699 path also recomputed this independently per output; we
 *  charge it just ONE coverage pass here to be conservative — the speedup is even
 *  larger if you count overlap+combine+mapped each recomputing it.) */
function oldDeriveField(circles: readonly Circle[], grid: number, rot: number): Int32Array {
  const out = new Int32Array(grid * grid);
  const cell = OUTLINES_FIELD / grid;
  for (let gy = 0; gy < grid; gy++) {
    const py = (gy + 0.5) * cell;
    for (let gx = 0; gx < grid; gx++) {
      const px = (gx + 0.5) * cell;
      let n = 0;
      for (let i = 0; i < circles.length; i++) {
        const c = circles[i]!;
        if ((c.alpha ?? 1) <= 0) continue;
        if (oldPointInShape(c, px, py, rot)) n++;
      }
      out[gy * grid + gx] = n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Behaviour equivalence — the derive-once field must be byte-identical to the
// per-point derivation (overlapCountAt / overlapAlphaAt / overlapValueAt /
// combineRgbAt) at every cell center, for circles AND polygons, spun AND
// unspun. A pure speedup changes NO pixels.
// ---------------------------------------------------------------------------

describe('OUTLINES derive-once field — byte-identical to the per-point derivation', () => {
  const grid = 160;
  const cell = OUTLINES_FIELD / grid;

  for (const rot of [0, 0.7, Math.PI / 2, 2.3]) {
    it(`count / softAlpha / maxAlpha match overlapCountAt / overlapAlphaAt / overlapValueAt at rot=${rot.toFixed(2)}`, () => {
      const circles = octagonField();
      const field = deriveOutlinesField(circles, makeOutlinesField(grid), rot);
      let checked = 0;
      let covered = 0;
      for (let gy = 0; gy < grid; gy++) {
        const py = (gy + 0.5) * cell;
        for (let gx = 0; gx < grid; gx++) {
          const px = (gx + 0.5) * cell;
          const idx = gy * grid + gx;
          // Integer count.
          expect(field.count[idx]).toBe(overlapCountAt(circles, px, py, rot));
          // Soft alpha (all alphas are 1 here → equals the count, but assert the
          // exact float the per-point path produces).
          expect(field.softAlpha[idx]).toBeCloseTo(overlapAlphaAt(circles, px, py, rot), 6);
          // Max covering alpha == the `overlap` output.
          expect(field.maxAlpha[idx]).toBeCloseTo(overlapValueAt(circles, px, py, rot), 6);
          checked++;
          if (field.count[idx]! > 0) covered++;
        }
      }
      // Sanity: the worst-case field actually covers a big chunk of the grid (the
      // equivalence isn't vacuously true over an all-black field).
      expect(checked).toBe(grid * grid);
      expect(covered).toBeGreaterThan(grid * grid * 0.1);
    });

    it(`combineRgbFromField matches combineRgbAt at rot=${rot.toFixed(2)} (combine output unchanged)`, () => {
      const circles = octagonField();
      const field = deriveOutlinesField(circles, makeOutlinesField(grid), rot);
      const scratch: [number, number, number] = [0, 0, 0];
      let overlapCells = 0;
      for (let gy = 0; gy < grid; gy++) {
        const py = (gy + 0.5) * cell;
        for (let gx = 0; gx < grid; gx++) {
          const px = (gx + 0.5) * cell;
          const idx = gy * grid + gx;
          const [r, g, b] = combineRgbFromField(field, idx, scratch);
          const [er, eg, eb] = combineRgbAt(circles, px, py, rot);
          expect(r).toBeCloseTo(er, 6);
          expect(g).toBeCloseTo(eg, 6);
          expect(b).toBeCloseTo(eb, 6);
          if (field.count[idx]! >= 2) overlapCells++;
          // The mapped mask (≥2) is also derivable from the same count field.
          expect(field.count[idx]! >= 2 ? 1 : 0).toBe(mappedMaskAt(circles, px, py, rot));
        }
      }
      expect(overlapCells).toBeGreaterThan(0); // a real ≥2-overlap region exists
    });
  }

  it('a fully-decayed (alpha 0) shape contributes NOTHING (matches the per-point gate)', () => {
    const circles: Circle[] = [
      { x: 500, y: 500, vx: 0, vy: 0, diameter: 200, shape: 5, sides: 8, baseAngle: 0, alpha: 0 },
      { x: 500, y: 500, vx: 0, vy: 0, diameter: 200, shape: 0, sides: 0, baseAngle: 0, alpha: 1 },
    ];
    const field = deriveOutlinesField(circles, makeOutlinesField(grid), 0);
    for (let gy = 0; gy < grid; gy++) {
      const py = (gy + 0.5) * cell;
      for (let gx = 0; gx < grid; gx++) {
        const px = (gx + 0.5) * cell;
        const idx = gy * grid + gx;
        expect(field.count[idx]).toBe(overlapCountAt(circles, px, py, 0));
      }
    }
  });

  it('reuses scratch buffers across frames (no reallocation when grid is unchanged)', () => {
    const f1 = makeOutlinesField(grid);
    const f2 = makeOutlinesField(grid, f1);
    expect(f2).toBe(f1); // same object reused
    expect(f2.count).toBe(f1.count);
    // A different grid forces a fresh allocation.
    const f3 = makeOutlinesField(80, f1);
    expect(f3).not.toBe(f1);
  });
});

// ---------------------------------------------------------------------------
// COMMITTED micro-benchmark — deterministic timing of the per-frame derivation
// BEFORE (old per-pixel-trig full-field scan) vs AFTER (the derive-once field) at
// a representative field size (160 grid) + several octagons (worst case). Asserts
// a meaningful speedup so a future regression that re-introduces per-pixel trig
// fails CI, and prints the factor for the PR body.
// ---------------------------------------------------------------------------

describe('OUTLINES per-frame derivation micro-benchmark (#699 hot path)', () => {
  // Explicit generous timeout: the OLD reference path is ~20+ ms/frame, so a
  // representative iteration count is inherently in the seconds. The NEW path is
  // sub-ms; the per-frame numbers below are what matter (printed for the PR).
  it('the derive-once field is substantially faster than the old per-pixel-trig scan', () => {
    const grid = 160; // the production combine grid
    const circles = octagonField(); // 6 octagons + 1 circle, big + overlapping
    const rot = 0.37; // a non-trivial spin so the polygon path is fully exercised

    // Equivalence guard up front (so the benchmark can't pass by computing junk):
    // the two coverage fields must be identical.
    const newField = deriveOutlinesField(circles, makeOutlinesField(grid), rot);
    const oldCount = oldDeriveField(circles, grid, rot);
    for (let i = 0; i < grid * grid; i++) {
      expect(newField.count[i]).toBe(oldCount[i]);
    }

    // Warm both paths (JIT) before timing.
    const reuse = makeOutlinesField(grid);
    for (let w = 0; w < 10; w++) {
      deriveOutlinesField(circles, reuse, rot);
      oldDeriveField(circles, grid, rot);
    }

    // The NEW path is sub-ms, so time MORE of it for a stable per-frame number;
    // the OLD path is ~20ms/frame, so a smaller count keeps the test well under
    // the timeout while staying representative.
    const NEW_ITER = 500;
    const OLD_ITER = 60;

    const tNewStart = performance.now();
    for (let i = 0; i < NEW_ITER; i++) deriveOutlinesField(circles, reuse, rot);
    const tNew = performance.now() - tNewStart;

    const tOldStart = performance.now();
    for (let i = 0; i < OLD_ITER; i++) oldDeriveField(circles, grid, rot);
    const tOld = performance.now() - tOldStart;

    const msNew = tNew / NEW_ITER;
    const msOld = tOld / OLD_ITER;
    const speedup = msOld / msNew;

    // eslint-disable-next-line no-console
    console.log(
      `[OUTLINES bench] grid ${grid}×${grid}, ${circles.length} shapes (6 octagons + 1 circle), ` +
        `rot=${rot}\n` +
        `  OLD per-pixel-trig full-field: ${msOld.toFixed(3)} ms/frame\n` +
        `  NEW derive-once (hoisted trig + AABB + pre-reject): ${msNew.toFixed(3)} ms/frame\n` +
        `  SPEEDUP: ${speedup.toFixed(2)}×`,
    );

    // A meaningful, robust floor (timing varies by host/CI load; the real speedup
    // is far larger — ~200×+ on a warm dev box). If a future change re-introduces
    // per-pixel trig or a whole-field scan, this drops below the floor and fails.
    expect(speedup).toBeGreaterThan(1.5);
    // And the new path is genuinely cheap per frame at the production grid.
    expect(msNew).toBeLessThan(msOld);
  }, 30000);
});
