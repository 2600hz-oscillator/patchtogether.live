// packages/dsp/src/lib/seq960-dsp.test.ts
//
// Pure-logic coverage for the MOOG 960 column stepper. Proves the column
// pointer advances correctly under every per-column MODE combination (NORMAL
// advance + wrap, SKIP pass-through, STOP halt, all-skip graceful no-op) and
// pins the RANGE-switch multiplier table + rowOutput() CV scaling.

import { describe, it, expect } from 'vitest';
import {
  Seq960Stepper,
  rowOutput,
  rangeMultiplier,
  RANGE_MULTIPLIERS,
  SEQ960_COLUMNS,
  MODE_NORMAL,
  MODE_SKIP,
  MODE_STOP,
} from './seq960-dsp';

const ALL_NORMAL = Array(SEQ960_COLUMNS).fill(MODE_NORMAL);

describe('Seq960Stepper: NORMAL advance + wrap', () => {
  it('starts at column 0', () => {
    expect(new Seq960Stepper().column).toBe(0);
  });

  it('advances one column per call with all-NORMAL modes', () => {
    const s = new Seq960Stepper();
    const seen: number[] = [];
    for (let i = 0; i < SEQ960_COLUMNS; i++) {
      seen.push(s.advance(ALL_NORMAL).column);
    }
    // From 0: 1,2,3,4,5,6,7, then wrap to 0.
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
  });

  it('wraps 8→1 (column 7 → column 0)', () => {
    const s = new Seq960Stepper();
    s.setColumn(7);
    expect(s.advance(ALL_NORMAL).column).toBe(0);
  });

  it('never reports stopped under all-NORMAL modes', () => {
    const s = new Seq960Stepper();
    for (let i = 0; i < SEQ960_COLUMNS * 2; i++) {
      expect(s.advance(ALL_NORMAL).stopped).toBe(false);
    }
  });
});

describe('Seq960Stepper: SKIP columns', () => {
  it('skips a single SKIP column', () => {
    // Column 1 is SKIP → advancing from 0 lands on 2.
    const modes = [...ALL_NORMAL];
    modes[1] = MODE_SKIP;
    const s = new Seq960Stepper();
    expect(s.advance(modes).column).toBe(2);
  });

  it('skips a run of consecutive SKIP columns', () => {
    // Columns 1,2,3 SKIP → 0 advances straight to 4.
    const modes = [...ALL_NORMAL];
    modes[1] = MODE_SKIP;
    modes[2] = MODE_SKIP;
    modes[3] = MODE_SKIP;
    const s = new Seq960Stepper();
    expect(s.advance(modes).column).toBe(4);
  });

  it('skips a SKIP column across the wrap boundary', () => {
    // Column 0 is SKIP → advancing from 7 wraps past 0 onto 1.
    const modes = [...ALL_NORMAL];
    modes[0] = MODE_SKIP;
    const s = new Seq960Stepper();
    s.setColumn(7);
    expect(s.advance(modes).column).toBe(1);
  });

  it('all-SKIP degrades gracefully: pointer holds, no stop, no infinite loop', () => {
    const modes = Array(SEQ960_COLUMNS).fill(MODE_SKIP);
    const s = new Seq960Stepper();
    s.setColumn(3);
    const r = s.advance(modes);
    expect(r.column).toBe(3); // unchanged
    expect(r.stopped).toBe(false);
    expect(s.column).toBe(3);
  });
});

describe('Seq960Stepper: STOP columns', () => {
  it('reports stopped when it LANDS on a STOP column', () => {
    // Column 1 is STOP → advancing from 0 lands on 1 and halts.
    const modes = [...ALL_NORMAL];
    modes[1] = MODE_STOP;
    const s = new Seq960Stepper();
    const r = s.advance(modes);
    expect(r.column).toBe(1);
    expect(r.stopped).toBe(true);
  });

  it('a STOP column is still playable (it is the landed-on/selected column)', () => {
    const modes = [...ALL_NORMAL];
    modes[2] = MODE_STOP;
    const s = new Seq960Stepper();
    s.advance(modes); // → col 1, normal
    const r = s.advance(modes); // → col 2, STOP
    expect(r.column).toBe(2);
    expect(r.stopped).toBe(true);
    // The pointer rests on the STOP column (CV held there).
    expect(s.column).toBe(2);
  });

  it('does not stop on a SKIP+STOP mix until it lands on the STOP', () => {
    // col1 SKIP, col2 STOP → from 0: skip 1, land 2 = STOP.
    const modes = [...ALL_NORMAL];
    modes[1] = MODE_SKIP;
    modes[2] = MODE_STOP;
    const s = new Seq960Stepper();
    const r = s.advance(modes);
    expect(r.column).toBe(2);
    expect(r.stopped).toBe(true);
  });

  it('reset() returns the pointer to column 0', () => {
    const s = new Seq960Stepper();
    s.advance(ALL_NORMAL);
    s.advance(ALL_NORMAL);
    expect(s.column).toBe(2);
    s.reset();
    expect(s.column).toBe(0);
  });
});

describe('range multiplier table + rowOutput CV scale', () => {
  it('RANGE_MULTIPLIERS = [1, 2, 4]', () => {
    expect([...RANGE_MULTIPLIERS]).toEqual([1, 2, 4]);
  });

  it('rangeMultiplier maps 0→1, 1→2, 2→4', () => {
    expect(rangeMultiplier(0)).toBe(1);
    expect(rangeMultiplier(1)).toBe(2);
    expect(rangeMultiplier(2)).toBe(4);
  });

  it('rangeMultiplier clamps out-of-range / float params', () => {
    expect(rangeMultiplier(-5)).toBe(1);
    expect(rangeMultiplier(99)).toBe(4);
    expect(rangeMultiplier(1.4)).toBe(2); // rounds to 1
    expect(rangeMultiplier(1.6)).toBe(4); // rounds to 2
  });

  it('rowOutput scales the 0..1 pot by the range multiplier', () => {
    expect(rowOutput(0.5, 0)).toBeCloseTo(0.5, 6); // ×1
    expect(rowOutput(0.5, 1)).toBeCloseTo(1.0, 6); // ×2
    expect(rowOutput(0.5, 2)).toBeCloseTo(2.0, 6); // ×4
    expect(rowOutput(1.0, 2)).toBeCloseTo(4.0, 6); // full pot at ×4
    expect(rowOutput(0.0, 2)).toBeCloseTo(0.0, 6); // zero pot stays zero
  });
});
