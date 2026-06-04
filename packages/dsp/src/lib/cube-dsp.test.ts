// packages/dsp/src/lib/cube-dsp.test.ts
//
// Pure-DSP unit tests for CUBE (slice 1) — the 3D wavetable-navigator field +
// surface-height slice readout. Every novel piece of math in cube-dsp.ts is
// pinned here so a refactor surfaces as a specific quantitative regression:
//   • occ      — circle vs V differ; both anchor at the endpoints; the connect
//                morph is continuous + monotonic.
//   • fieldAt  — morphFC=0 ignores the ceiling table, =1 ignores the floor;
//                SMOOTH yields a range of densities, HARD yields only {0,1}.
//   • crush    — k=0 identity; k=1 collapses to ≤ a few amplitude levels /
//                a coarse spatial grid.
//   • wrapFold — triangle-wave mirror fold (-0.1→0.1, 1.2→0.8, …).
//   • sampleSlice — length 256, in [-1,1]; an axis-aligned slice through a known
//                synthetic table tracks the cube shape; out-of-cube is 0 without
//                wrap and nonzero with wrap.
//
// See .myrobots/CUBE/PLAN.md §5 for the math + §2 for the locked decisions.

import { describe, it, expect } from 'vitest';
import {
  WAVETABLE_FRAME_SIZE,
  CUBE_SLICE_SIZE,
  HARD_THRESHOLD,
  occ,
  fieldAt,
  crush,
  crushCoord,
  crushGridSteps,
  crushLevels,
  spaceCrushCoord,
  spaceCrushGridSteps,
  diffusePull,
  lowestInfoFace,
  wrapFold,
  heightAt,
  sampleSlice,
  wavefold,
  applyFold,
  FOLD_MAX_DRIVE,
  type SliceParams,
  type Material,
} from './cube-dsp';

// ───────────────────────────────────────────────────────────────────────────
// Synthetic wavetable helpers. A wavetable is Float32Array[] (64 × 256), values
// in [-1,1]. We build constant + ramped tables so the field is hand-predictable.
// ───────────────────────────────────────────────────────────────────────────

const FRAMES = 64;
const COLS = WAVETABLE_FRAME_SIZE; // 256

/** A wavetable whose every sample = `value` (a flat heightfield). */
function constTable(value: number): Float32Array[] {
  const t: Float32Array[] = [];
  for (let f = 0; f < FRAMES; f++) t.push(new Float32Array(COLS).fill(value));
  return t;
}

/** A wavetable whose height ramps with the column index (x = sample-phase):
 *  H(u, v) = lo + (hi - lo) * (col / (COLS - 1)). Independent of frame. */
function rampInXTable(lo: number, hi: number): Float32Array[] {
  const t: Float32Array[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const row = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) row[c] = lo + (hi - lo) * (c / (COLS - 1));
    t.push(row);
  }
  return t;
}

// ───────────────────────────────────────────────────────────────────────────
// occ — connection curve / occupancy.
// ───────────────────────────────────────────────────────────────────────────

describe('occ — connector occupancy (circle ↔ V)', () => {
  const bottom = 0.0;
  const top = 1.0;

  it('anchors at the right endpoints for both circle and V', () => {
    for (const c of [0, 0.5, 1]) {
      // At/below the bottom height → fully solid.
      expect(occ(0, bottom, top, c)).toBe(1);
      // At/above the top height → empty.
      expect(occ(1, bottom, top, c)).toBe(0);
    }
  });

  it('circle bulges above the V in the interior (they differ)', () => {
    const z = 0.5;
    const circle = occ(z, bottom, top, 0); // sqrt(1 - 0.25) ≈ 0.866
    const vee = occ(z, bottom, top, 1); // 1 - 0.5 = 0.5
    expect(circle).toBeCloseTo(Math.sqrt(0.75), 5);
    expect(vee).toBeCloseTo(0.5, 5);
    expect(circle).toBeGreaterThan(vee);
  });

  it('morph is continuous + monotonic in connect at a fixed z', () => {
    const z = 0.4;
    const a = occ(z, bottom, top, 0);
    const b = occ(z, bottom, top, 0.5);
    const d = occ(z, bottom, top, 1);
    // Circle ≥ blend ≥ V (monotone decreasing in c here since circle > V).
    expect(a).toBeGreaterThanOrEqual(b);
    expect(b).toBeGreaterThanOrEqual(d);
    // The 50% blend is exactly the average of the endpoints (linear blend).
    expect(b).toBeCloseTo((a + d) / 2, 6);
  });

  it('handles top < bottom by filling the lower→upper span symmetrically', () => {
    // Swapping bottom/top must give the same span shape (lo..hi resolved).
    const z = 0.5;
    expect(occ(z, 0.2, 0.8, 0)).toBeCloseTo(occ(z, 0.8, 0.2, 0), 6);
  });

  it('returns values strictly in [0,1]', () => {
    for (let i = 0; i <= 20; i++) {
      const z = i / 20;
      for (const c of [0, 0.25, 0.75, 1]) {
        const v = occ(z, 0.1, 0.9, c);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// fieldAt — the cube scalar field + morphFC weighting + material.
// ───────────────────────────────────────────────────────────────────────────

describe('fieldAt — morph floor/ceiling + material', () => {
  // floor flat-low, ceiling flat-high, wall mid. Distinct so we can tell which
  // table the morph weight is actually using.
  const floorT = constTable(-1.0); // floorH = 0.0
  const wallT = constTable(0.0); //  wallH  = 0.5
  const ceilT = constTable(1.0); //  ceilH  = 1.0

  const base = (m: number, material: Material) => ({
    morphFC: m,
    connect: 0,
    material,
  });

  it('morphFC=0 uses only the floor-fill (ceiling table ignored)', () => {
    // With m=0 the ceiling table value must not matter: swap it for anything.
    const z = 0.25;
    const withCeilHigh = fieldAt(floorT, wallT, ceilT, 0.5, 0.5, z, base(0, 'smooth'));
    const withCeilLow = fieldAt(floorT, wallT, constTable(-1), 0.5, 0.5, z, base(0, 'smooth'));
    expect(withCeilHigh).toBeCloseTo(withCeilLow, 9);
    // And it equals occ(z; floorH=0, wallH=0.5).
    expect(withCeilHigh).toBeCloseTo(occ(z, 0.0, 0.5, 0), 9);
  });

  it('morphFC=1 uses only the ceiling-fill (floor table ignored)', () => {
    const z = 0.75;
    const withFloorLow = fieldAt(floorT, wallT, ceilT, 0.5, 0.5, z, base(1, 'smooth'));
    const withFloorHigh = fieldAt(constTable(1), wallT, ceilT, 0.5, 0.5, z, base(1, 'smooth'));
    expect(withFloorLow).toBeCloseTo(withFloorHigh, 9);
    // And it equals occ(z; ceilH=1.0, wallH=0.5).
    expect(withFloorLow).toBeCloseTo(occ(z, 1.0, 0.5, 0), 9);
  });

  it('morphFC=0.5 is the average of the floor-fill and ceiling-fill', () => {
    const z = 0.5;
    const dF = occ(z, 0.0, 0.5, 0); // floor-fill
    const dC = occ(z, 1.0, 0.5, 0); // ceiling-fill
    const f = fieldAt(floorT, wallT, ceilT, 0.5, 0.5, z, base(0.5, 'smooth'));
    expect(f).toBeCloseTo((dF + dC) / 2, 6);
  });

  it('SMOOTH yields a range of densities; HARD yields only {0,1}', () => {
    // Sweep z; collect the distinct field values for SMOOTH vs HARD.
    const smooth = new Set<number>();
    const hard = new Set<number>();
    for (let i = 0; i <= 40; i++) {
      const z = i / 40;
      smooth.add(fieldAt(floorT, wallT, ceilT, 0.5, 0.5, z, base(0.5, 'smooth')));
      hard.add(fieldAt(floorT, wallT, ceilT, 0.5, 0.5, z, base(0.5, 'hard')));
    }
    // SMOOTH should produce many intermediate densities.
    expect(smooth.size).toBeGreaterThan(5);
    // HARD is binary: only 0 and/or 1 ever appear.
    for (const v of hard) expect(v === 0 || v === 1).toBe(true);
    expect(hard.size).toBeLessThanOrEqual(2);
  });

  it('HARD threshold flips at HARD_THRESHOLD', () => {
    // Construct a column where the smooth density crosses 0.5 across z and check
    // the HARD output is 1 below and 0 above the crossing.
    const z = 0; // fully solid base → smooth=1 → hard=1
    expect(fieldAt(floorT, wallT, ceilT, 0.5, 0.5, z, base(0, 'hard'))).toBe(1);
    const zHigh = 0.99; // near top of floor-fill span → smooth<threshold → 0
    const sm = fieldAt(floorT, wallT, ceilT, 0.5, 0.5, zHigh, base(0, 'smooth'));
    const hd = fieldAt(floorT, wallT, ceilT, 0.5, 0.5, zHigh, base(0, 'hard'));
    expect(hd).toBe(sm >= HARD_THRESHOLD ? 1 : 0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CRUSH — amplitude + spatial-grid quantization.
// ───────────────────────────────────────────────────────────────────────────

describe('crush — amplitude bitcrush', () => {
  it('k=0 is the identity', () => {
    for (const v of [0, 0.123, 0.5, 0.777, 1]) {
      expect(crush(v, 0)).toBe(v);
    }
  });

  it('k=1 collapses to ≤ 2 amplitude levels', () => {
    const out = new Set<number>();
    for (let i = 0; i <= 100; i++) out.add(crush(i / 100, 1));
    expect(out.size).toBeLessThanOrEqual(2); // {0, 1}
    expect(crushLevels(1)).toBe(2);
  });

  it('is monotonic non-decreasing in the input value', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const v = crush(i / 100, 0.7);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('amplitude levels interpolate 256 → 2 as k goes 0 → 1', () => {
    expect(crushLevels(0)).toBe(256);
    expect(crushLevels(1)).toBe(2);
    expect(crushLevels(0.5)).toBeLessThan(256);
    expect(crushLevels(0.5)).toBeGreaterThan(2);
  });
});

describe('crushCoord — spatial-grid quantization', () => {
  it('k=0 leaves coordinates untouched', () => {
    for (const c of [0, 0.31, 0.5, 0.999]) expect(crushCoord(c, 0)).toBe(c);
  });

  it('k=1 collapses an axis to a coarse grid (≤ a few steps)', () => {
    expect(crushGridSteps(1)).toBeLessThanOrEqual(4);
    const cells = new Set<number>();
    for (let i = 0; i <= 200; i++) cells.add(crushCoord(i / 200, 1));
    // ≤ crushGridSteps(1) distinct snapped positions.
    expect(cells.size).toBeLessThanOrEqual(crushGridSteps(1));
  });

  it('grid steps interpolate 256 → 4 as k goes 0 → 1', () => {
    expect(crushGridSteps(0)).toBe(256);
    expect(crushGridSteps(1)).toBe(4);
  });

  it('snapped coords stay inside [0,1]', () => {
    for (let i = 0; i <= 50; i++) {
      const v = crushCoord(i / 50, 0.8);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// wrapFold — triangle-wave mirror fold.
// ───────────────────────────────────────────────────────────────────────────

describe('wrapFold — triangle mirror fold into [0,1]', () => {
  it('matches the canonical examples', () => {
    expect(wrapFold(-0.1)).toBeCloseTo(0.1, 9);
    expect(wrapFold(1.2)).toBeCloseTo(0.8, 9);
    expect(wrapFold(2.3)).toBeCloseTo(0.3, 9);
    expect(wrapFold(-1.4)).toBeCloseTo(0.6, 9);
  });

  it('passes in-range coords through unchanged', () => {
    for (const c of [0, 0.25, 0.5, 0.75, 1]) expect(wrapFold(c)).toBeCloseTo(c, 9);
  });

  it('always returns a value in [0,1]', () => {
    for (let i = -50; i <= 50; i++) {
      const v = wrapFold(i * 0.137);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is symmetric about integers (mirror)', () => {
    // 0.5 + d and 0.5 - d on opposite sides of an integer mirror equally.
    expect(wrapFold(1.3)).toBeCloseTo(wrapFold(0.7), 9); // both fold to 0.7
  });
});

// ───────────────────────────────────────────────────────────────────────────
// heightAt — sanity for the heightfield read (used by sampleSlice).
// ───────────────────────────────────────────────────────────────────────────

describe('heightAt — wavetable as a 2D heightfield in [0,1]', () => {
  it('maps a flat table to a flat height', () => {
    expect(heightAt(constTable(-1), 0.3, 0.7)).toBeCloseTo(0, 6); // (-1+1)/2
    expect(heightAt(constTable(1), 0.3, 0.7)).toBeCloseTo(1, 6); // (1+1)/2
    expect(heightAt(constTable(0), 0.3, 0.7)).toBeCloseTo(0.5, 6);
  });

  it('tracks the column ramp along x (sample-phase)', () => {
    const t = rampInXTable(-1, 1); // H goes -1 → 1 over x ⇒ height 0 → 1
    expect(heightAt(t, 0, 0.5)).toBeCloseTo(0, 3);
    expect(heightAt(t, 0.5, 0.5)).toBeCloseTo(0.5, 2);
    expect(heightAt(t, 1, 0.5)).toBeCloseTo(0, 2); // wraps: u=1 ≡ u=0
  });
});

// ───────────────────────────────────────────────────────────────────────────
// sampleSlice — the SURFACE-HEIGHT SCAN readout.
// ───────────────────────────────────────────────────────────────────────────

describe('sampleSlice — surface-height scan readout', () => {
  const floorT = constTable(-1.0); // floorH = 0
  const wallT = constTable(0.0); //  wallH  = 0.5
  const ceilT = constTable(1.0); //  ceilH  = 1

  const axisAligned = (over: Partial<SliceParams> = {}): SliceParams => ({
    sliceY: 0.5,
    rx: 0,
    ry: 0,
    rz: 0,
    morphFC: 0,
    connect: 0,
    material: 'smooth',
    crush: 0,
    wrap: false,
    ...over,
  });

  it('returns a Float32Array of length 256 with values in [-1,1]', () => {
    const wave = sampleSlice(floorT, wallT, ceilT, axisAligned());
    expect(wave).toBeInstanceOf(Float32Array);
    expect(wave.length).toBe(CUBE_SLICE_SIZE);
    expect(CUBE_SLICE_SIZE).toBe(256);
    for (const v of wave) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('a flat cube produces a (near-)constant wave', () => {
    // Everything flat ⇒ the field is the same at every (x,y) column ⇒ every
    // scan position reads the same depth ⇒ a flat output waveform.
    const wave = sampleSlice(floorT, wallT, ceilT, axisAligned());
    const first = wave[0]!;
    for (const v of wave) expect(v).toBeCloseTo(first, 4);
  });

  it('an x-ramped wall makes the wave track the cube shape', () => {
    // wallH ramps low→high across x ⇒ taller solid where the wall is higher ⇒
    // the readout depth must rise monotonically across the scan.
    const rampWall = rampInXTable(-1, 1); // wallH 0 → 1 across x
    const wave = sampleSlice(floorT, rampWall, ceilT, axisAligned({ morphFC: 0 }));
    // Compare the low-x end vs the high-x end (avoid the very edges / wrap col).
    const lowEnd = wave[20]!;
    const highEnd = wave[235]!;
    expect(highEnd).toBeGreaterThan(lowEnd);
    // And it should be a generally increasing trend, not noise: a coarse check.
    const q1 = wave[64]!;
    const q3 = wave[192]!;
    expect(q3).toBeGreaterThan(q1);
  });

  it('out-of-cube slice reads 0 without wrap, and nonzero with wrap', () => {
    // Push the slice plane far outside the cube (sliceY way above 1) with a
    // tilt so most of the ray is outside [0,1]³.
    const outside = axisAligned({ sliceY: 5, morphFC: 0 });
    const silent = sampleSlice(floorT, wallT, ceilT, outside);
    let maxSilent = 0;
    for (const v of silent) maxSilent = Math.max(maxSilent, Math.abs(v));
    // Without wrap the field never gets sampled → 0 depth → wave maps to -1
    // (depth 0 → 0*2-1). "Silent" here = a constant DC floor, no shape.
    const firstSilent = silent[0]!;
    for (const v of silent) expect(v).toBeCloseTo(firstSilent, 6);
    expect(firstSilent).toBeCloseTo(-1, 6); // depth 0 everywhere

    // With wrap the out-of-cube coords fold back in → the field IS sampled →
    // the depth is nonzero → the wave rises above the -1 floor somewhere.
    const wrapped = sampleSlice(floorT, wallT, ceilT, { ...outside, wrap: true });
    let maxWrapped = -Infinity;
    for (const v of wrapped) maxWrapped = Math.max(maxWrapped, v);
    expect(maxWrapped).toBeGreaterThan(firstSilent + 0.01);
  });

  it('HARD material gives a wave whose values came from a binary field', () => {
    // The output is still continuous (depth = mean of binary samples), but it
    // must stay in range and differ from SMOOTH in general.
    const smooth = sampleSlice(floorT, rampInXTable(-1, 1), ceilT, axisAligned());
    const hard = sampleSlice(
      floorT,
      rampInXTable(-1, 1),
      ceilT,
      axisAligned({ material: 'hard' }),
    );
    let differs = false;
    for (let i = 0; i < smooth.length; i++) {
      expect(hard[i]!).toBeGreaterThanOrEqual(-1);
      expect(hard[i]!).toBeLessThanOrEqual(1);
      if (Math.abs(smooth[i]! - hard[i]!) > 1e-6) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('CRUSH at k=1 quantizes the readout to a coarse, steppy wave', () => {
    const rampWall = rampInXTable(-1, 1);
    const clean = sampleSlice(floorT, rampWall, ceilT, axisAligned());
    const crushed = sampleSlice(floorT, rampWall, ceilT, axisAligned({ crush: 1 }));
    // The clean wave has many distinct levels; the crushed one has very few.
    const cleanLevels = new Set(Array.from(clean).map((v) => Math.round(v * 1e4)));
    const crushedLevels = new Set(Array.from(crushed).map((v) => Math.round(v * 1e4)));
    expect(crushedLevels.size).toBeLessThan(cleanLevels.size);
    expect(crushedLevels.size).toBeLessThanOrEqual(4);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FOLD — West-coast wavefolder (wavefold / applyFold).
// ───────────────────────────────────────────────────────────────────────────

describe('wavefold — West-coast wavefolder math', () => {
  it('fold=0 is an exact identity for any sample (byte-stable unfolded path)', () => {
    for (const x of [-1, -0.73, -0.1, 0, 0.1, 0.5, 0.999, 1]) {
      expect(wavefold(x, 0)).toBe(x);
    }
    // Negative / out-of-[0,1] fold clamps to 0 → still identity.
    expect(wavefold(0.42, -0.5)).toBe(0.42);
  });

  it('output is bounded in [-1,1] and finite for every fold amount + sample', () => {
    for (let k = 0; k <= 1; k += 0.05) {
      for (let x = -1; x <= 1; x += 0.01) {
        const y = wavefold(x, k);
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(-1.000001);
        expect(y).toBeLessThanOrEqual(1.000001);
      }
    }
  });

  it('passes the ±1 endpoints straight through at low fold (π/2 scale)', () => {
    // At k→0 the drive →1 so sin(π/2 · x) maps ±1 → ±1 exactly.
    expect(wavefold(1, 1e-9)).toBeCloseTo(1, 6);
    expect(wavefold(-1, 1e-9)).toBeCloseTo(-1, 6);
  });

  it('increasing fold injects fold-overs (more sign changes ⇒ more harmonics)', () => {
    // A linear ramp -1→1 (one rising edge). Count sign changes in the folded
    // output: the unfolded ramp has ~1, but folding it adds reflections, so the
    // folded waveform crosses zero more times as fold rises = added harmonics.
    const ramp = new Float32Array(512);
    for (let i = 0; i < ramp.length; i++) ramp[i] = (i / (ramp.length - 1)) * 2 - 1;
    const signChanges = (k: number): number => {
      let prev = wavefold(ramp[0]!, k);
      let n = 0;
      for (let i = 1; i < ramp.length; i++) {
        const y = wavefold(ramp[i]!, k);
        if ((y >= 0) !== (prev >= 0)) n++;
        prev = y;
      }
      return n;
    };
    const c0 = signChanges(0);
    const cHalf = signChanges(0.5);
    const cFull = signChanges(1);
    expect(cHalf).toBeGreaterThan(c0);
    expect(cFull).toBeGreaterThan(cHalf);
  });

  it('FOLD_MAX_DRIVE yields several fold-overs at full peak', () => {
    // At x=1, k=1 the argument is π/2 · (1+FOLD_MAX_DRIVE) > 2π ⇒ the sine has
    // wrapped past full cycles (multiple folds). Sanity-bound the constant.
    expect(FOLD_MAX_DRIVE).toBeGreaterThanOrEqual(2);
    const arg = (Math.PI / 2) * (1 + FOLD_MAX_DRIVE) * 1;
    expect(arg).toBeGreaterThan(2 * Math.PI); // at least one full fold cycle
  });
});

describe('applyFold — in-place fold across a slice waveform', () => {
  it('fold=0 leaves the buffer untouched (same reference, identical values)', () => {
    const w = new Float32Array([-1, -0.3, 0, 0.4, 1]);
    const before = Float32Array.from(w);
    const out = applyFold(w, 0);
    expect(out).toBe(w); // returns the same array
    for (let i = 0; i < w.length; i++) expect(w[i]).toBe(before[i]);
  });

  it('fold>0 changes the buffer in place and never produces NaN/Inf or out-of-range', () => {
    const w = new Float32Array(256);
    for (let i = 0; i < w.length; i++) w[i] = Math.sin((i / w.length) * Math.PI * 2);
    const before = Float32Array.from(w);
    applyFold(w, 0.8);
    let changed = false;
    for (let i = 0; i < w.length; i++) {
      if (Math.abs(w[i]! - before[i]!) > 1e-9) changed = true;
      expect(Number.isFinite(w[i]!)).toBe(true);
      expect(w[i]!).toBeGreaterThanOrEqual(-1.000001);
      expect(w[i]!).toBeLessThanOrEqual(1.000001);
    }
    expect(changed).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SLICE-ACROSS-TABLES — the slice reads ALL THREE tables (not just the wall).
// (Regression for the user's "the slice only shows the WALL" suspicion — the
// DSP is correct; floor + ceiling DO influence the readout per the morph rule.)
// ───────────────────────────────────────────────────────────────────────────

describe('sampleSlice — reads across floor / wall / ceiling', () => {
  const sineInXTable = (): Float32Array[] => {
    const t: Float32Array[] = [];
    for (let f = 0; f < FRAMES; f++) {
      const row = new Float32Array(COLS);
      for (let c = 0; c < COLS; c++) row[c] = Math.sin((2 * Math.PI * c) / COLS);
      t.push(row);
    }
    return t;
  };
  const base = (over: Partial<SliceParams> = {}): SliceParams => ({
    sliceY: 0.5, rx: 0, ry: 0, rz: 0,
    morphFC: 0, connect: 0, material: 'smooth', crush: 0, wrap: false, ...over,
  });
  const maxDiff = (a: Float32Array, b: Float32Array): number => {
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
    return m;
  };

  const FLOOR_A = constTable(-1), FLOOR_B = rampInXTable(-1, 1);
  const WALL_A = sineInXTable(), WALL_B = constTable(0.5);
  const CEIL_A = rampInXTable(-1, 1), CEIL_B = constTable(0.8);

  it('FLOOR table influences the readout at morphFC=0', () => {
    const a = sampleSlice(FLOOR_A, WALL_A, CEIL_A, base({ morphFC: 0 }));
    const b = sampleSlice(FLOOR_B, WALL_A, CEIL_A, base({ morphFC: 0 }));
    expect(maxDiff(a, b)).toBeGreaterThan(0.05);
  });

  it('WALL table influences the readout', () => {
    const a = sampleSlice(FLOOR_A, WALL_A, CEIL_A, base({ morphFC: 0 }));
    const b = sampleSlice(FLOOR_A, WALL_B, CEIL_A, base({ morphFC: 0 }));
    expect(maxDiff(a, b)).toBeGreaterThan(0.05);
  });

  it('CEILING table influences the readout at morphFC=1', () => {
    const a = sampleSlice(FLOOR_A, WALL_A, CEIL_A, base({ morphFC: 1 }));
    const b = sampleSlice(FLOOR_A, WALL_A, CEIL_B, base({ morphFC: 1 }));
    expect(maxDiff(a, b)).toBeGreaterThan(0.05);
  });

  it('CEILING is correctly IGNORED at morphFC=0, FLOOR ignored at morphFC=1 (morph crossfade)', () => {
    // By spec the morph crossfades floor↔ceiling: at 0 the ceiling is silent,
    // at 1 the floor is silent. This is WHY a default patch (morphFC=0) "looks
    // like only the wall+floor" — not a bug.
    const cz = sampleSlice(FLOOR_A, WALL_A, CEIL_A, base({ morphFC: 0 }));
    const cz2 = sampleSlice(FLOOR_A, WALL_A, CEIL_B, base({ morphFC: 0 }));
    expect(maxDiff(cz, cz2)).toBeLessThan(1e-9); // ceiling has zero effect at m=0
    const fz = sampleSlice(FLOOR_A, WALL_A, CEIL_A, base({ morphFC: 1 }));
    const fz2 = sampleSlice(FLOOR_B, WALL_A, CEIL_A, base({ morphFC: 1 }));
    expect(maxDiff(fz, fz2)).toBeLessThan(1e-9); // floor has zero effect at m=1
  });

  it('at mid-morph (0.5) ALL THREE tables influence the readout', () => {
    const ref = sampleSlice(FLOOR_A, WALL_A, CEIL_A, base({ morphFC: 0.5 }));
    const dFloor = maxDiff(ref, sampleSlice(FLOOR_B, WALL_A, CEIL_A, base({ morphFC: 0.5 })));
    const dWall = maxDiff(ref, sampleSlice(FLOOR_A, WALL_B, CEIL_A, base({ morphFC: 0.5 })));
    const dCeil = maxDiff(ref, sampleSlice(FLOOR_A, WALL_A, CEIL_B, base({ morphFC: 0.5 })));
    expect(dFloor).toBeGreaterThan(0.02);
    expect(dWall).toBeGreaterThan(0.02);
    expect(dCeil).toBeGreaterThan(0.02);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// OFF = EXACT IDENTITY — SPACE CRUSH / SPACE DIFFUSE / CONNECT STRENGTH.
//
// The cube ART harness compares at tier B (rms < 1e-4), which canNOT prove
// byte-identity. These tests are the real proof that all three new controls at
// their OFF (0) value are bit-identical to the prior behavior — exact `===`,
// not toBeCloseTo. (See the CUBE design adversarial review, finding G1.)
// ───────────────────────────────────────────────────────────────────────────
describe('off = exact identity (new CUBE controls)', () => {
  function legacyOcc(z: number, bottom: number, top: number, connect: number): number {
    const lo = Math.min(bottom, top);
    const hi = Math.max(bottom, top);
    const zz = Math.max(0, Math.min(1, z));
    if (zz <= lo) return 1;
    if (zz >= hi) return 0;
    const span = hi - lo;
    if (span <= 1e-9) return zz < hi ? 1 : 0;
    const t = (zz - lo) / span;
    const c = Math.max(0, Math.min(1, connect));
    const circle = Math.sqrt(Math.max(0, 1 - t * t));
    const vee = 1 - t;
    return Math.max(0, Math.min(1, circle * (1 - c) + vee * c));
  }

  it('occ(...,connectStrength=0) === the legacy occ formula, exactly, over a grid', () => {
    for (let bi = 0; bi <= 4; bi++) {
      for (let ti = 0; ti <= 4; ti++) {
        for (let zi = 0; zi <= 8; zi++) {
          for (let ci = 0; ci <= 4; ci++) {
            const b = bi / 4, t = ti / 4, z = zi / 8, c = ci / 4;
            expect(occ(z, b, t, c, 0)).toBe(legacyOcc(z, b, t, c));
            // the default 4-arg call must also be identical (no 5th arg path)
            expect(occ(z, b, t, c)).toBe(legacyOcc(z, b, t, c));
          }
        }
      }
    }
  });

  it('spaceCrushCoord(c,0) === c and diffusePull(c,0,dir) === c (no arithmetic at off)', () => {
    for (let i = 0; i <= 20; i++) {
      const c = i / 20;
      expect(spaceCrushCoord(c, 0)).toBe(c);
      expect(diffusePull(c, 0, 1)).toBe(c);
      expect(diffusePull(c, 0, -1)).toBe(c);
    }
    // spaceCrushGridSteps stays transparent until the grid actually drops below 256
    expect(spaceCrushGridSteps(0)).toBe(256);
  });

  it('sampleSlice with all three controls at OFF === the legacy params, byte-for-byte', () => {
    const floorT = rampInXTable(-1, 1);
    const wallT = constTable(0.0);
    const ceilT = rampInXTable(-1, 1);
    const legacy: SliceParams = {
      sliceY: 0.5, rx: 0.6, ry: 0.3, rz: 0.2,
      morphFC: 0.4, connect: 0.3, material: 'smooth', crush: 0.2, wrap: true,
    };
    const withOff: SliceParams = { ...legacy, spaceCrush: 0, spaceDiffuse: 0, connectStrength: 0 };
    const a = sampleSlice(floorT, wallT, ceilT, legacy);
    const b = sampleSlice(floorT, wallT, ceilT, withOff);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]); // exact ===
  });

  it('each control at NON-zero actually changes the wave (sanity, not just off-safe)', () => {
    const floorT = rampInXTable(-1, 1);
    const wallT = constTable(0.0);
    const ceilT = rampInXTable(-1, 1);
    const base: SliceParams = {
      sliceY: 0.5, rx: 0.3, ry: 0.2, rz: 0, morphFC: 0.5, connect: 0.2,
      material: 'smooth', crush: 0, wrap: false,
    };
    const rms = (x: Float32Array, y: Float32Array) => {
      let s = 0; for (let i = 0; i < x.length; i++) { const d = x[i]! - y[i]!; s += d * d; }
      return Math.sqrt(s / x.length);
    };
    const clean = sampleSlice(floorT, wallT, ceilT, base);
    expect(rms(clean, sampleSlice(floorT, wallT, ceilT, { ...base, spaceCrush: 1 }))).toBeGreaterThan(1e-3);
    expect(rms(clean, sampleSlice(floorT, wallT, ceilT, { ...base, spaceDiffuse: 1 }))).toBeGreaterThan(1e-3);
    expect(rms(clean, sampleSlice(floorT, wallT, ceilT, { ...base, connectStrength: 1 }))).toBeGreaterThan(1e-3);
  });

  it('lowestInfoFace is deterministic + stable across calls (latch invariant)', () => {
    const floorT = constTable(-1);
    const wallT = rampInXTable(-1, 1);
    const ceilT = rampInXTable(-1, 1);
    const fp = { morphFC: 0.5, connect: 0.3, connectStrength: 0, material: 'smooth' as const };
    const a = lowestInfoFace(floorT, wallT, ceilT, fp);
    const b = lowestInfoFace(floorT, wallT, ceilT, fp);
    expect(a).toEqual(b); // same field → same target (no chatter)
    expect(a.axis).toBeGreaterThanOrEqual(0);
    expect([-1, 1]).toContain(a.dir);
  });
});
