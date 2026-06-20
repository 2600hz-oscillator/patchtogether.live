import { describe, it, expect } from 'vitest';
import {
  GRID,
  CELL_COUNT,
  OUTPUT_IDS,
  cellCol,
  cellRow,
  cellSourceRect,
  oneToNineDef,
} from './onetonine';

describe('onetonine module def', () => {
  it('is a video module with lowercase label "one to nine"', () => {
    expect(oneToNineDef.type).toBe('onetonine');
    expect(oneToNineDef.domain).toBe('video');
    expect(oneToNineDef.label).toBe('one to nine');
    expect(oneToNineDef.label).toBe(oneToNineDef.label.toLowerCase());
  });

  it('declares a single video input "in" and nine video outputs out1..out9', () => {
    expect(oneToNineDef.inputs).toEqual([{ id: 'in', type: 'video' }]);
    expect(oneToNineDef.outputs.map((p) => p.id)).toEqual([...OUTPUT_IDS]);
    for (const p of oneToNineDef.outputs) expect(p.type).toBe('video');
    expect(oneToNineDef.outputs).toHaveLength(9);
    // No CV inputs — fixed 3×3 split, no params required beyond the grid toggle.
    expect(oneToNineDef.inputs.some((p) => p.type === 'cv')).toBe(false);
  });

  it('exposes a showGrid param defaulting ON', () => {
    const p = oneToNineDef.params.find((x) => x.id === 'showGrid');
    expect(p).toBeTruthy();
    expect(p!.defaultValue).toBe(1);
  });
});

describe('cell row/col (reading order)', () => {
  it('GRID is 3, CELL_COUNT is 9', () => {
    expect(GRID).toBe(3);
    expect(CELL_COUNT).toBe(9);
  });

  it('maps cell numbers to reading-order row/col', () => {
    // 1 2 3 / 4 5 6 / 7 8 9
    expect([cellRow(1), cellCol(1)]).toEqual([0, 0]); // top-left
    expect([cellRow(2), cellCol(2)]).toEqual([0, 1]); // top-center
    expect([cellRow(3), cellCol(3)]).toEqual([0, 2]); // top-right
    expect([cellRow(5), cellCol(5)]).toEqual([1, 1]); // centre
    expect([cellRow(7), cellCol(7)]).toEqual([2, 0]); // bottom-left
    expect([cellRow(9), cellCol(9)]).toEqual([2, 2]); // bottom-right
  });
});

describe('cellSourceRect (y-UP source crop math)', () => {
  const third = 1 / 3;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  it('cell 1 (top-left) crops HIGH v + LOW u', () => {
    const r = cellSourceRect(1);
    // u band = leftmost third
    expect(near(r.u0, 0)).toBe(true);
    expect(near(r.u1, third)).toBe(true);
    // v band = TOP third → v near 1 (y-UP). v1 (top) = 1, v0 (bottom) = 2/3.
    expect(near(r.v1, 1)).toBe(true);
    expect(near(r.v0, 2 * third)).toBe(true);
    // sanity: this rect is in the upper-left quadrant of the y-UP source.
    expect(r.v0).toBeGreaterThan(0.5);
    expect(r.u1).toBeLessThanOrEqual(0.5);
  });

  it('cell 9 (bottom-right) crops LOW v + HIGH u', () => {
    const r = cellSourceRect(9);
    expect(near(r.u0, 2 * third)).toBe(true);
    expect(near(r.u1, 1)).toBe(true);
    expect(near(r.v0, 0)).toBe(true);
    expect(near(r.v1, third)).toBe(true);
    // sanity: lower-right quadrant of the y-UP source.
    expect(r.v1).toBeLessThan(0.5);
    expect(r.u0).toBeGreaterThanOrEqual(0.5);
  });

  it('cell 5 (centre) crops the middle band', () => {
    const r = cellSourceRect(5);
    expect(near(r.u0, third)).toBe(true);
    expect(near(r.u1, 2 * third)).toBe(true);
    expect(near(r.v0, third)).toBe(true);
    expect(near(r.v1, 2 * third)).toBe(true);
  });

  it('cell 3 (top-right) is high v + high u; cell 7 (bottom-left) is low v + low u', () => {
    const c3 = cellSourceRect(3);
    expect(c3.v0).toBeGreaterThan(0.5); // top
    expect(c3.u0).toBeGreaterThanOrEqual(0.5); // right
    const c7 = cellSourceRect(7);
    expect(c7.v1).toBeLessThan(0.5); // bottom
    expect(c7.u1).toBeLessThanOrEqual(0.5); // left
  });

  it('every rect is a 1/3 × 1/3 sub-rectangle within [0,1]^2', () => {
    for (let n = 1; n <= 9; n++) {
      const r = cellSourceRect(n);
      expect(near(r.u1 - r.u0, third)).toBe(true);
      expect(near(r.v1 - r.v0, third)).toBe(true);
      expect(r.u0).toBeGreaterThanOrEqual(0);
      expect(r.u1).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.v0).toBeGreaterThanOrEqual(-1e-9);
      expect(r.v1).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.v1).toBeGreaterThan(r.v0);
      expect(r.u1).toBeGreaterThan(r.u0);
    }
  });

  it('the nine rects exactly tile the unit square (no gaps / overlaps)', () => {
    // Collect the distinct u and v edges; each must be {0,1/3,2/3,1}.
    const us = new Set<number>();
    const vs = new Set<number>();
    for (let n = 1; n <= 9; n++) {
      const r = cellSourceRect(n);
      us.add(Math.round(r.u0 * 3)); us.add(Math.round(r.u1 * 3));
      vs.add(Math.round(r.v0 * 3)); vs.add(Math.round(r.v1 * 3));
    }
    expect([...us].sort()).toEqual([0, 1, 2, 3]);
    expect([...vs].sort()).toEqual([0, 1, 2, 3]);
  });
});
