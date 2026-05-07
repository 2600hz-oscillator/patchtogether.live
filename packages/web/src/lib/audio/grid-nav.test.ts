// packages/web/src/lib/audio/grid-nav.test.ts
//
// Unit tests for the keyboard-grid focus resolver shared by SequencerCard +
// CartesianCard. Each cell's gate (top) + pitch (bottom) form two conceptual
// rows; arrow keys resolve against the (row, col) coordinate of the focused
// element. No wrap; clamps to null at edges (caller leaves focus put).

import { describe, it, expect } from 'vitest';
import {
  resolveArrowNav,
  focusToCoord,
  coordToFocus,
  type GridSpec,
} from './grid-nav';

const SEQ: GridSpec = { cols: 16, cellRows: 1 }; // 1 cell row -> 2 conceptual rows
const CART: GridSpec = { cols: 4, cellRows: 4 }; // 4 cell rows -> 8 conceptual rows

describe('grid-nav: focus<->coord round-trip', () => {
  it('Sequencer: gate at idx 0 is row 0, col 0', () => {
    expect(focusToCoord({ index: 0, role: 'gate' }, SEQ)).toEqual({ row: 0, col: 0 });
  });
  it('Sequencer: pitch at idx 0 is row 1, col 0', () => {
    expect(focusToCoord({ index: 0, role: 'pitch' }, SEQ)).toEqual({ row: 1, col: 0 });
  });
  it('Sequencer: gate at idx 5 is row 0, col 5', () => {
    expect(focusToCoord({ index: 5, role: 'gate' }, SEQ)).toEqual({ row: 0, col: 5 });
  });
  it('Cartesian: gate at idx 5 (row 1, col 1) is row 2, col 1', () => {
    expect(focusToCoord({ index: 5, role: 'gate' }, CART)).toEqual({ row: 2, col: 1 });
  });
  it('Cartesian: pitch at idx 15 (row 3, col 3) is row 7, col 3', () => {
    expect(focusToCoord({ index: 15, role: 'pitch' }, CART)).toEqual({ row: 7, col: 3 });
  });
  it('round-trips every cell-role combo on Cartesian', () => {
    for (let i = 0; i < 16; i++) {
      for (const role of ['pitch', 'gate'] as const) {
        const coord = focusToCoord({ index: i, role }, CART);
        const back = coordToFocus(coord.row, coord.col, CART);
        expect(back).toEqual({ index: i, role });
      }
    }
  });
});

describe('grid-nav: Sequencer (linear, no wrap)', () => {
  it('Up from pitch lands on gate of same step', () => {
    expect(resolveArrowNav({ index: 5, role: 'pitch' }, 'ArrowUp', SEQ))
      .toEqual({ index: 5, role: 'gate' });
  });
  it('Down from gate lands on pitch of same step', () => {
    expect(resolveArrowNav({ index: 5, role: 'gate' }, 'ArrowDown', SEQ))
      .toEqual({ index: 5, role: 'pitch' });
  });
  it('Up from gate clamps (top of grid)', () => {
    expect(resolveArrowNav({ index: 5, role: 'gate' }, 'ArrowUp', SEQ)).toBeNull();
  });
  it('Down from pitch clamps (bottom of grid)', () => {
    expect(resolveArrowNav({ index: 5, role: 'pitch' }, 'ArrowDown', SEQ)).toBeNull();
  });
  it('Right moves to next step, same role', () => {
    expect(resolveArrowNav({ index: 5, role: 'pitch' }, 'ArrowRight', SEQ))
      .toEqual({ index: 6, role: 'pitch' });
    expect(resolveArrowNav({ index: 5, role: 'gate' }, 'ArrowRight', SEQ))
      .toEqual({ index: 6, role: 'gate' });
  });
  it('Right at last step clamps (no wrap)', () => {
    expect(resolveArrowNav({ index: 15, role: 'pitch' }, 'ArrowRight', SEQ)).toBeNull();
    expect(resolveArrowNav({ index: 15, role: 'gate' }, 'ArrowRight', SEQ)).toBeNull();
  });
  it('Left at first step clamps', () => {
    expect(resolveArrowNav({ index: 0, role: 'pitch' }, 'ArrowLeft', SEQ)).toBeNull();
    expect(resolveArrowNav({ index: 0, role: 'gate' }, 'ArrowLeft', SEQ)).toBeNull();
  });
});

describe('grid-nav: Cartesian (4x4, no wrap)', () => {
  // Cell layout (idx by row, col):
  //   (r0)  0  1  2  3
  //   (r1)  4  5  6  7
  //   (r2)  8  9 10 11
  //   (r3) 12 13 14 15
  // Conceptual keyboard rows interleave gate/pitch per cell row.

  it('user scenario: pitch under a gate, hit Up -> land on that gate', () => {
    // Cell idx 5 (row 1, col 1). Pitch row in cell -> Up -> gate of same cell.
    expect(resolveArrowNav({ index: 5, role: 'pitch' }, 'ArrowUp', CART))
      .toEqual({ index: 5, role: 'gate' });
  });

  it('Up from gate of cell row 1 lands on pitch of cell row 0 (same column)', () => {
    expect(resolveArrowNav({ index: 5, role: 'gate' }, 'ArrowUp', CART))
      .toEqual({ index: 1, role: 'pitch' });
  });

  it('Up from gate of top-row cell clamps (top of grid)', () => {
    for (let col = 0; col < 4; col++) {
      expect(resolveArrowNav({ index: col, role: 'gate' }, 'ArrowUp', CART)).toBeNull();
    }
  });

  it('Down from pitch of cell row 0 lands on gate of cell row 1', () => {
    expect(resolveArrowNav({ index: 1, role: 'pitch' }, 'ArrowDown', CART))
      .toEqual({ index: 5, role: 'gate' });
  });

  it('Down from pitch of bottom-row cell clamps (bottom of grid)', () => {
    for (let col = 0; col < 4; col++) {
      const idx = 12 + col;
      expect(resolveArrowNav({ index: idx, role: 'pitch' }, 'ArrowDown', CART)).toBeNull();
    }
  });

  it('Right wraps within row but does not jump to next row (clamp at row end)', () => {
    expect(resolveArrowNav({ index: 0, role: 'pitch' }, 'ArrowRight', CART))
      .toEqual({ index: 1, role: 'pitch' });
    expect(resolveArrowNav({ index: 3, role: 'pitch' }, 'ArrowRight', CART)).toBeNull();
    expect(resolveArrowNav({ index: 7, role: 'gate' }, 'ArrowRight', CART)).toBeNull();
  });

  it('Left clamps at column 0', () => {
    expect(resolveArrowNav({ index: 0, role: 'pitch' }, 'ArrowLeft', CART)).toBeNull();
    expect(resolveArrowNav({ index: 4, role: 'gate' }, 'ArrowLeft', CART)).toBeNull();
    expect(resolveArrowNav({ index: 1, role: 'pitch' }, 'ArrowLeft', CART))
      .toEqual({ index: 0, role: 'pitch' });
  });

  it('rapid-add scenario: type c3, ArrowRight x3 across row 0', () => {
    let pos: { index: number; role: 'pitch' | 'gate' } = { index: 0, role: 'pitch' };
    for (let i = 1; i < 4; i++) {
      const next = resolveArrowNav(pos, 'ArrowRight', CART);
      expect(next).toEqual({ index: i, role: 'pitch' });
      pos = next!;
    }
  });

  it('rapid-add scenario: ArrowDown moves pitch -> gate-below; ArrowDown again -> pitch-below', () => {
    let pos: { index: number; role: 'pitch' | 'gate' } = { index: 0, role: 'pitch' };
    pos = resolveArrowNav(pos, 'ArrowDown', CART)!;
    expect(pos).toEqual({ index: 4, role: 'gate' });
    pos = resolveArrowNav(pos, 'ArrowDown', CART)!;
    expect(pos).toEqual({ index: 4, role: 'pitch' });
    pos = resolveArrowNav(pos, 'ArrowDown', CART)!;
    expect(pos).toEqual({ index: 8, role: 'gate' });
  });
});
