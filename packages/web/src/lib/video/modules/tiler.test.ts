// packages/web/src/lib/video/modules/tiler.test.ts
//
// Unit tests for TILER's pure helpers + def shape. The GL-side draw is
// covered by the e2e + VRT suites; here we pin:
//   * the knob INDEX → grid dimension N mapping (0..5 → [1,4,6,8,12,16]),
//   * the CV "sum-then-snap to the nearest valid N" resolve logic,
//   * the param/port def shape (discrete tile knob + tile_cv discrete CV).

import { describe, it, expect } from 'vitest';
import {
  TILER_GRID_STEPS,
  TILER_DEFAULT_TILE_INDEX,
  tilerDef,
  tilerTileIndex,
  tilerStepN,
  tilerSnapNearestN,
  tilerResolveN,
} from './tiler';

describe('TILER_GRID_STEPS — the 6 discrete grid sizes', () => {
  it('is exactly [1, 4, 6, 8, 12, 16] (N=1 = passthrough first)', () => {
    expect([...TILER_GRID_STEPS]).toEqual([1, 4, 6, 8, 12, 16]);
  });

  it('default index is 0 (N=1, 1:1 passthrough — a fresh TILER is transparent)', () => {
    expect(TILER_DEFAULT_TILE_INDEX).toBe(0);
    expect(TILER_GRID_STEPS[TILER_DEFAULT_TILE_INDEX]).toBe(1);
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
    expect(tilerTileIndex(99)).toBe(TILER_GRID_STEPS.length - 1); // 5
  });

  it('non-finite → the default index', () => {
    expect(tilerTileIndex(NaN)).toBe(TILER_DEFAULT_TILE_INDEX);
    expect(tilerTileIndex(Infinity)).toBe(TILER_DEFAULT_TILE_INDEX);
  });
});

describe('tilerStepN — knob INDEX 0..5 → grid dimension N (the bare mapping)', () => {
  it('maps each index 0..5 to [1, 4, 6, 8, 12, 16]', () => {
    expect(tilerStepN(0)).toBe(1);
    expect(tilerStepN(1)).toBe(4);
    expect(tilerStepN(2)).toBe(6);
    expect(tilerStepN(3)).toBe(8);
    expect(tilerStepN(4)).toBe(12);
    expect(tilerStepN(5)).toBe(16);
  });

  it('index 0 is the 1:1 passthrough (N=1)', () => {
    expect(tilerStepN(0)).toBe(1);
  });

  it('rounds a fractional index to a clean step before reading N', () => {
    expect(tilerStepN(0.4)).toBe(1);  // → idx 0 → N=1
    expect(tilerStepN(0.6)).toBe(4);  // → idx 1 → N=4
    expect(tilerStepN(4.6)).toBe(16); // → idx 5 → N=16
  });

  it('clamps out-of-range indices to the end steps', () => {
    expect(tilerStepN(-1)).toBe(1);   // clamp → idx 0
    expect(tilerStepN(10)).toBe(16);  // clamp → idx 5
  });
});

describe('tilerSnapNearestN — snap an arbitrary N to the nearest valid grid', () => {
  it('returns valid N values unchanged', () => {
    for (const n of TILER_GRID_STEPS) expect(tilerSnapNearestN(n)).toBe(n);
  });

  it('snaps an in-between N to the nearest valid step', () => {
    expect(tilerSnapNearestN(2)).toBe(1);   // closer to 1 than 4
    expect(tilerSnapNearestN(3)).toBe(4);   // closer to 4 than 1
    expect(tilerSnapNearestN(5)).toBe(4);   // equidist 4/6 → smaller (4)
    expect(tilerSnapNearestN(7)).toBe(6);   // equidist 6/8 → smaller (6)
    expect(tilerSnapNearestN(7.4)).toBe(8); // closer to 8
    expect(tilerSnapNearestN(10)).toBe(8);  // equidist 8/12 → smaller (8)
    expect(tilerSnapNearestN(13)).toBe(12); // closer to 12
    expect(tilerSnapNearestN(14)).toBe(12); // equidist 12/16 (|14-12|=|14-16|=2) → smaller (12)
    expect(tilerSnapNearestN(15)).toBe(16); // closer to 16
  });

  it('ties resolve to the SMALLER N (the lower grid)', () => {
    // exact midpoints between adjacent steps:
    expect(tilerSnapNearestN(2.5)).toBe(1);  // mid 1..4 → 1
    expect(tilerSnapNearestN(5)).toBe(4);    // mid 4..6 → 4
    expect(tilerSnapNearestN(7)).toBe(6);    // mid 6..8 → 6
    expect(tilerSnapNearestN(10)).toBe(8);   // mid 8..12 → 8
    expect(tilerSnapNearestN(14)).toBe(12);  // mid 12..16 → 12
  });

  it('clamps beyond the ends to the extreme valid steps', () => {
    expect(tilerSnapNearestN(-5)).toBe(1);
    expect(tilerSnapNearestN(999)).toBe(16);
  });

  it('non-finite → the default N', () => {
    expect(tilerSnapNearestN(NaN)).toBe(TILER_GRID_STEPS[TILER_DEFAULT_TILE_INDEX]);
  });
});

describe('tilerResolveN — CV sum-then-snap (the effective grid)', () => {
  it('with NO CV (an integer index) == the plain knob → N mapping', () => {
    for (let i = 0; i < TILER_GRID_STEPS.length; i++) {
      expect(tilerResolveN(i)).toBe(tilerStepN(i));
    }
  });

  it('a fractional summed index interpolates N then snaps to the nearest valid grid', () => {
    // index 1.5 = halfway between N=4 (idx1) and N=6 (idx2) → interpN=5 →
    // equidistant 4/6 → snaps to the SMALLER (4).
    expect(tilerResolveN(1.5)).toBe(4);
    // index 2.5 = halfway 6..8 → interpN=7 → equidist → 6.
    expect(tilerResolveN(2.5)).toBe(6);
    // index 1.7 = 4 + 0.7*(6-4)=5.4 → nearest valid is 6.
    expect(tilerResolveN(1.7)).toBe(6);
  });

  it('a CV nudge past the step midpoint lands on the nearest valid N, never an invalid grid', () => {
    // knob at idx2 (N=6); CV adds +0.6 → summed 2.6 → interpN = 6+0.6*(8-6)=7.2
    // → nearest valid is 8 (never an invalid 7×7).
    expect(tilerResolveN(2.6)).toBe(8);
    // a smaller +0.4 nudge → interpN = 6.8 → still closer to 6 → stays 6.
    expect(tilerResolveN(2.4)).toBe(6);
    // small +0.1 nudge → interpN = 6.2 → nearest valid stays 6.
    expect(tilerResolveN(2.1)).toBe(6);
  });

  it('CV can sweep all the way up to N=16 and down to N=1 passthrough', () => {
    expect(tilerResolveN(0)).toBe(1);                       // bottom → passthrough
    expect(tilerResolveN(TILER_GRID_STEPS.length - 1)).toBe(16); // top → 16×16
  });

  it('clamps a summed index beyond the knob range to the end grids', () => {
    expect(tilerResolveN(-2)).toBe(1);   // CV drags below 0 → passthrough
    expect(tilerResolveN(8)).toBe(16);   // CV pushes past the top → 16×16
  });

  it('non-finite summed index → the default N', () => {
    expect(tilerResolveN(NaN)).toBe(TILER_GRID_STEPS[TILER_DEFAULT_TILE_INDEX]);
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
      max: TILER_GRID_STEPS.length - 1, // 5
      defaultValue: TILER_DEFAULT_TILE_INDEX, // 0
      curve: 'discrete',
    });
  });

  it('exposes a TILE CV input (discrete cvScale, targets the tile param)', () => {
    const cv = tilerDef.inputs.find((p) => p.id === 'tile_cv');
    expect(cv, 'tile_cv port').toBeDefined();
    expect(cv?.type).toBe('cv');
    expect(cv?.paramTarget).toBe('tile');
    // DISCRETE so the CV snaps onto the index steps before summing; the
    // module then snaps the summed value to the nearest valid N.
    expect(cv?.cvScale).toEqual({ mode: 'discrete' });
  });
});
