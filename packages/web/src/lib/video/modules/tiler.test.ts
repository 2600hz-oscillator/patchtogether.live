// packages/web/src/lib/video/modules/tiler.test.ts
//
// Unit tests for TILER's pure helpers + def shape. The GL-side draw is
// covered by the e2e + VRT suites; here we pin:
//   * the knob INDEX → grid { total, cols, rows } mapping (0..5 → TILER_STEPS),
//   * the CV "sum-then-snap to the nearest valid step" resolve logic
//     (interpolate the TOTAL, snap to nearest, ties → SMALLER total),
//   * the param/port def shape (discrete tile knob + tile_cv discrete CV).

import { describe, it, expect } from 'vitest';
import {
  TILER_STEPS,
  TILER_GRID_STEPS,
  TILER_DEFAULT_TILE_INDEX,
  tilerDef,
  tilerTileIndex,
  tilerStepGrid,
  tilerSnapNearestStep,
  tilerResolveGrid,
} from './tiler';

describe('TILER_STEPS — the 6 discrete grids (total / cols / rows)', () => {
  it('is exactly the 6 landscape grids in total order', () => {
    expect([...TILER_STEPS]).toEqual([
      { total: 1,  cols: 1, rows: 1 },
      { total: 4,  cols: 2, rows: 2 },
      { total: 6,  cols: 3, rows: 2 },
      { total: 12, cols: 4, rows: 3 },
      { total: 16, cols: 4, rows: 4 },
      { total: 64, cols: 8, rows: 8 },
    ]);
  });

  it('every grid is LANDSCAPE (cols >= rows) and cols*rows == total', () => {
    for (const s of TILER_STEPS) {
      expect(s.cols).toBeGreaterThanOrEqual(s.rows);
      expect(s.cols * s.rows).toBe(s.total);
    }
  });
});

describe('TILER_GRID_STEPS — the step TOTALS (back-compat, tick labels)', () => {
  it('is exactly [1, 4, 6, 12, 16, 64] (the totals in step order)', () => {
    expect([...TILER_GRID_STEPS]).toEqual([1, 4, 6, 12, 16, 64]);
  });

  it('default index is 0 (total 1, 1:1 passthrough — a fresh TILER is transparent)', () => {
    expect(TILER_DEFAULT_TILE_INDEX).toBe(0);
    expect(TILER_GRID_STEPS[TILER_DEFAULT_TILE_INDEX]).toBe(1);
    expect(TILER_STEPS[TILER_DEFAULT_TILE_INDEX]).toEqual({ total: 1, cols: 1, rows: 1 });
  });
});

describe('tilerTileIndex — clamp/round a raw tile param to a valid step index', () => {
  it('rounds a fractional index to the nearest whole step', () => {
    expect(tilerTileIndex(0)).toBe(0);
    expect(tilerTileIndex(2)).toBe(2);
    expect(tilerTileIndex(2.4)).toBe(2);
    expect(tilerTileIndex(2.5)).toBe(3); // Math.round rounds .5 up
    expect(tilerTileIndex(2.6)).toBe(3);
  });

  it('clamps below 0 and above the last index', () => {
    expect(tilerTileIndex(-3)).toBe(0);
    expect(tilerTileIndex(99)).toBe(TILER_STEPS.length - 1); // 5
  });

  it('non-finite → the default index', () => {
    expect(tilerTileIndex(NaN)).toBe(TILER_DEFAULT_TILE_INDEX);
    expect(tilerTileIndex(Infinity)).toBe(TILER_DEFAULT_TILE_INDEX);
  });
});

describe('tilerStepGrid — knob INDEX 0..5 → grid { total, cols, rows }', () => {
  it('maps each index 0..5 to its TILER_STEPS grid', () => {
    expect(tilerStepGrid(0)).toEqual({ total: 1,  cols: 1, rows: 1 });
    expect(tilerStepGrid(1)).toEqual({ total: 4,  cols: 2, rows: 2 });
    expect(tilerStepGrid(2)).toEqual({ total: 6,  cols: 3, rows: 2 });
    expect(tilerStepGrid(3)).toEqual({ total: 12, cols: 4, rows: 3 });
    expect(tilerStepGrid(4)).toEqual({ total: 16, cols: 4, rows: 4 });
    expect(tilerStepGrid(5)).toEqual({ total: 64, cols: 8, rows: 8 });
  });

  it('index 0 is the 1:1 passthrough (cols 1, rows 1)', () => {
    expect(tilerStepGrid(0)).toEqual({ total: 1, cols: 1, rows: 1 });
  });

  it('rounds a fractional index to a clean step before reading the grid', () => {
    expect(tilerStepGrid(0.4)).toEqual({ total: 1,  cols: 1, rows: 1 }); // → idx 0
    expect(tilerStepGrid(0.6)).toEqual({ total: 4,  cols: 2, rows: 2 }); // → idx 1
    expect(tilerStepGrid(4.6)).toEqual({ total: 64, cols: 8, rows: 8 }); // → idx 5
  });

  it('clamps out-of-range indices to the end steps', () => {
    expect(tilerStepGrid(-1)).toEqual({ total: 1,  cols: 1, rows: 1 }); // clamp → idx 0
    expect(tilerStepGrid(10)).toEqual({ total: 64, cols: 8, rows: 8 }); // clamp → idx 5
  });
});

describe('tilerSnapNearestStep — snap an arbitrary total to the nearest valid step', () => {
  it('returns the exact step for each valid total', () => {
    for (const s of TILER_STEPS) expect(tilerSnapNearestStep(s.total)).toEqual(s);
  });

  it('snaps an in-between total to the nearest valid step', () => {
    expect(tilerSnapNearestStep(2).total).toBe(1);    // closer to 1 than 4
    expect(tilerSnapNearestStep(3).total).toBe(4);    // closer to 4 than 1
    expect(tilerSnapNearestStep(5).total).toBe(4);    // equidist 4/6 → smaller (4)
    expect(tilerSnapNearestStep(8).total).toBe(6);    // |8-6|=2 < |8-12|=4 → 6
    expect(tilerSnapNearestStep(10).total).toBe(12);  // |10-12|=2 < |10-6|=4 → 12
    expect(tilerSnapNearestStep(13).total).toBe(12);  // closer to 12 than 16
    expect(tilerSnapNearestStep(15).total).toBe(16);  // closer to 16
    expect(tilerSnapNearestStep(40).total).toBe(16);  // |40-16|=24 < |40-64|=24? tie → smaller (16)
    expect(tilerSnapNearestStep(50).total).toBe(64);  // |50-64|=14 < |50-16|=34 → 64
  });

  it('ties resolve to the SMALLER total (the lower grid)', () => {
    // exact midpoints between adjacent step totals:
    expect(tilerSnapNearestStep(2.5).total).toBe(1);  // mid 1..4 → 1
    expect(tilerSnapNearestStep(5).total).toBe(4);    // mid 4..6 → 4
    expect(tilerSnapNearestStep(9).total).toBe(6);    // mid 6..12 → 6
    expect(tilerSnapNearestStep(14).total).toBe(12);  // mid 12..16 → 12
    expect(tilerSnapNearestStep(40).total).toBe(16);  // mid 16..64 → 16
  });

  it('clamps beyond the ends to the extreme valid steps', () => {
    expect(tilerSnapNearestStep(-5).total).toBe(1);
    expect(tilerSnapNearestStep(9999).total).toBe(64);
  });

  it('non-finite → the default step', () => {
    expect(tilerSnapNearestStep(NaN)).toEqual(TILER_STEPS[TILER_DEFAULT_TILE_INDEX]);
  });
});

describe('tilerResolveGrid — CV sum-then-snap (the effective grid)', () => {
  it('with NO CV (an integer index) == the plain knob → grid mapping', () => {
    for (let i = 0; i < TILER_STEPS.length; i++) {
      expect(tilerResolveGrid(i)).toEqual(tilerStepGrid(i));
    }
  });

  it('a fractional summed index interpolates the TOTAL then snaps to the nearest step', () => {
    // index 1.5 = halfway between total 4 (idx1) and total 6 (idx2) →
    // interpTotal=5 → equidistant 4/6 → snaps to the SMALLER (total 4 = 2×2).
    expect(tilerResolveGrid(1.5)).toEqual({ total: 4, cols: 2, rows: 2 });
    // index 1.7 = 4 + 0.7*(6-4)=5.4 → nearest total is 6 (3×2).
    expect(tilerResolveGrid(1.7)).toEqual({ total: 6, cols: 3, rows: 2 });
  });

  it('a CV nudge near total 6 lands on the 6-step grid (3×2), not an invalid grid', () => {
    // knob at idx2 (total 6); a small CV jitter around it interpolates a total
    // near 6 and snaps right back to the 6-step grid (3×2).
    expect(tilerResolveGrid(2.0)).toEqual({ total: 6, cols: 3, rows: 2 });
    expect(tilerResolveGrid(2.1)).toEqual({ total: 6, cols: 3, rows: 2 }); // interp 6+0.1*6=6.6 → 6
    // knob at idx2; CV adds +0.6 → summed 2.6 → interpTotal = 6+0.6*(12-6)=9.6
    // → nearest valid total is 12 (4×3), never an invalid in-between.
    expect(tilerResolveGrid(2.6)).toEqual({ total: 12, cols: 4, rows: 3 });
  });

  it('CV can sweep all the way up to total 64 and down to the passthrough', () => {
    expect(tilerResolveGrid(0)).toEqual({ total: 1,  cols: 1, rows: 1 });  // bottom → passthrough
    expect(tilerResolveGrid(TILER_STEPS.length - 1)).toEqual({ total: 64, cols: 8, rows: 8 }); // top → 8×8
  });

  it('clamps a summed index beyond the knob range to the end grids', () => {
    expect(tilerResolveGrid(-2)).toEqual({ total: 1,  cols: 1, rows: 1 });  // CV below 0 → passthrough
    expect(tilerResolveGrid(8)).toEqual({ total: 64, cols: 8, rows: 8 });   // CV past the top → 8×8
  });

  it('non-finite summed index → the default grid', () => {
    expect(tilerResolveGrid(NaN)).toEqual(TILER_STEPS[TILER_DEFAULT_TILE_INDEX]);
  });
});

describe('tiler module def — params + ports', () => {
  it('is a lowercase-labelled video processor', () => {
    expect(tilerDef.type).toBe('tiler');
    expect(tilerDef.domain).toBe('video');
    expect(tilerDef.label).toBe('tiler'); // lowercase — CI guard fails on uppercase
    expect(tilerDef.label).toBe(tilerDef.label.toLowerCase());
  });

  it('exposes a single video IN and video OUT', () => {
    const videoIns = tilerDef.inputs.filter((p) => p.type === 'video').map((p) => p.id);
    expect(videoIns).toEqual(['in']);
    expect(tilerDef.outputs.map((p) => p.id)).toEqual(['out']);
    expect(tilerDef.outputs[0]!.type).toBe('video');
  });

  it('declares the TILE knob as a discrete 0..5 step index', () => {
    const byId = Object.fromEntries(tilerDef.params.map((p) => [p.id, p]));
    expect(byId.tile).toMatchObject({
      min: 0,
      max: TILER_STEPS.length - 1, // 5
      defaultValue: TILER_DEFAULT_TILE_INDEX, // 0
      curve: 'discrete',
    });
  });

  it('exposes a TILE CV input (discrete cvScale, targets the tile param)', () => {
    const cv = tilerDef.inputs.find((p) => p.id === 'tile_cv');
    expect(cv, 'tile_cv port').toBeDefined();
    expect(cv?.type).toBe('cv');
    expect(cv?.paramTarget).toBe('tile');
    // DISCRETE so the CV snaps onto the index steps before summing; the module
    // then snaps the summed value to the nearest valid step.
    expect(cv?.cvScale).toEqual({ mode: 'discrete' });
  });
});
