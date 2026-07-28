// packages/web/src/lib/ui/controls/param-grid-model.test.ts
//
// Pure-unit gate for the ParamGrid resolvers (PF-15). Zero-flake, node-env: no
// DOM, no registry, no timers.

import { describe, it, expect } from 'vitest';
import {
  GRID_MAX_CELLS,
  gridChipLabel,
  gridColumns,
  gridNavIndex,
  nearestGridIndex,
  paramGridCells,
  type GridCell,
} from './param-grid-model';

describe('paramGridCells — the roster', () => {
  it('derives one cell per integer step of the param range', () => {
    const cells = paramGridCells({ min: 1, max: 32 });
    expect(cells).toHaveLength(32);
    expect(cells[0]).toEqual({ value: 1, label: '1' });
    expect(cells[31]).toEqual({ value: 32, label: '32' });
  });

  it('labels derived cells with the def’s format when it declares one', () => {
    const cells = paramGridCells({ min: 1, max: 3 }, (v) => `ALG ${String(v).padStart(2, '0')}`);
    expect(cells.map((c) => c.label)).toEqual(['ALG 01', 'ALG 02', 'ALG 03']);
  });

  it('a DECLARED options roster wins over the derived range, titles included', () => {
    const cells = paramGridCells({
      min: 0,
      max: 2,
      options: [
        { value: 0, label: 'LP', title: 'low pass' },
        { value: 2, label: 'BP' },
      ],
    });
    expect(cells).toEqual([
      { value: 0, label: 'LP', title: 'low pass' },
      { value: 2, label: 'BP' },
    ]);
  });

  it('CAPS a runaway range at GRID_MAX_CELLS instead of painting 20000 cells', () => {
    // The footgun this exists for: `paramCells: { cutoff: 'grid' }` on a 20 Hz
    // .. 20 kHz continuous param. The face-lint discrete/step-count rule is the
    // real guard; this stops the tab hanging if one ever slips past it.
    const cells = paramGridCells({ min: 20, max: 20000 });
    expect(cells).toHaveLength(GRID_MAX_CELLS);
  });

  it('a fractional range walks the integers inside it', () => {
    expect(paramGridCells({ min: -1.5, max: 2.5 }).map((c) => c.value)).toEqual([-1, 0, 1, 2]);
  });

  it('an inverted range still produces the ascending roster', () => {
    expect(paramGridCells({ min: 3, max: 1 }).map((c) => c.value)).toEqual([1, 2, 3]);
  });
});

describe('nearestGridIndex — a param always HAS a state', () => {
  const cells: GridCell[] = [
    { value: 1, label: '1' },
    { value: 2, label: '2' },
    { value: 3, label: '3' },
  ];

  it('matches exactly when the value is on a detent', () => {
    expect(nearestGridIndex(2, cells)).toBe(1);
  });

  it('snaps an OFF-DETENT value to its nearest cell (a CV-motorized read)', () => {
    expect(nearestGridIndex(2.4, cells)).toBe(1);
    expect(nearestGridIndex(2.6, cells)).toBe(2);
  });

  it('ties resolve EARLIER, matching nearestSegmentValue', () => {
    expect(nearestGridIndex(1.5, cells)).toBe(0);
  });

  it('clamps outside the roster rather than reporting nothing', () => {
    expect(nearestGridIndex(-99, cells)).toBe(0);
    expect(nearestGridIndex(99, cells)).toBe(2);
  });

  it('an empty roster reports -1', () => {
    expect(nearestGridIndex(1, [])).toBe(-1);
  });
});

describe('gridColumns — the default layout', () => {
  it('lays 32 cells out 8 wide (the DX7 chart’s own 4x8 shape)', () => {
    expect(gridColumns(32)).toBe(8);
  });
  it('keeps a small roster on one row', () => {
    expect(gridColumns(3)).toBe(3);
  });
  it('never returns 0 columns', () => {
    expect(gridColumns(0)).toBe(1);
  });
});

describe('gridNavIndex — CLAMPED chart navigation, never wrapping', () => {
  const N = 32;
  const C = 8;

  it('arrows move within the row and the column', () => {
    expect(gridNavIndex(0, 'ArrowRight', N, C)).toBe(1);
    expect(gridNavIndex(1, 'ArrowLeft', N, C)).toBe(0);
    expect(gridNavIndex(0, 'ArrowDown', N, C)).toBe(8);
    expect(gridNavIndex(8, 'ArrowUp', N, C)).toBe(0);
  });

  it('does NOT wrap off either end — a chart order is not a ring', () => {
    expect(gridNavIndex(0, 'ArrowLeft', N, C)).toBe(0);
    expect(gridNavIndex(N - 1, 'ArrowRight', N, C)).toBe(N - 1);
  });

  it('a vertical move that would leave the grid HOLDS', () => {
    expect(gridNavIndex(3, 'ArrowUp', N, C)).toBe(3);
    expect(gridNavIndex(N - 1, 'ArrowDown', N, C)).toBe(N - 1);
  });

  it('a PARTIAL last row does not swallow the cursor', () => {
    // 10 cells, 8 wide → row 2 holds indices 8,9. Down from 5 would land on 13.
    expect(gridNavIndex(5, 'ArrowDown', 10, 8)).toBe(5);
    expect(gridNavIndex(1, 'ArrowDown', 10, 8)).toBe(9);
  });

  it('Home/End jump to the ends', () => {
    expect(gridNavIndex(17, 'Home', N, C)).toBe(0);
    expect(gridNavIndex(17, 'End', N, C)).toBe(N - 1);
  });

  it('an unfocused grid (-1) lands INSIDE on any navigation key', () => {
    expect(gridNavIndex(-1, 'ArrowRight', N, C)).toBe(0);
    expect(gridNavIndex(-1, 'ArrowLeft', N, C)).toBe(0);
    expect(gridNavIndex(-1, 'Home', N, C)).toBe(0);
    expect(gridNavIndex(-1, 'End', N, C)).toBe(N - 1);
  });

  it('an unrelated key changes nothing, and an empty grid reports -1', () => {
    expect(gridNavIndex(4, 'a', N, C)).toBe(4);
    expect(gridNavIndex(4, 'ArrowRight', 0, C)).toBe(-1);
  });

  it('a degenerate column count is treated as one column', () => {
    expect(gridNavIndex(0, 'ArrowDown', 4, 0)).toBe(1);
  });
});

describe('gridChipLabel — what the always-visible chip says', () => {
  const cells: GridCell[] = [
    { value: 1, label: 'one' },
    { value: 2, label: 'two' },
  ];

  it('uses the declared format when there is one', () => {
    expect(gridChipLabel(2, cells, (v) => `ALG ${v}`)).toBe('ALG 2');
  });

  it('falls back to the NEAREST cell’s label', () => {
    expect(gridChipLabel(1.9, cells)).toBe('two');
  });

  it('falls back to the raw number for an empty roster', () => {
    expect(gridChipLabel(7, [])).toBe('7');
  });
});
