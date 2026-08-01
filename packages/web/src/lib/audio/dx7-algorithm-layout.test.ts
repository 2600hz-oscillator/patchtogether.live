// packages/web/src/lib/audio/dx7-algorithm-layout.test.ts
//
// The GOLDEN PIN for the algorithm picture, plus the structural invariants a
// renderer relies on. The golden is what stops a routing-table edit from
// silently producing a different diagram: dx7-algorithms.test.ts already pins
// the TABLE against the real DX7 chart, and this pins the PICTURE derived
// from it, so the two can only move together and only on purpose.

import { describe, it, expect } from 'vitest';
import { DX7_ALGORITHMS } from './dx7-algorithms';
import { dx7AlgorithmLayout, dx7LayoutGolden, type Dx7Layout } from './dx7-algorithm-layout';

// `num|op:col,row …|from>to …|fb from>to|colsXrows`
const LAYOUT_GOLDEN: string[] = [
  '1|0:0,0 1:0,1 2:1,0 3:1,1 4:1,2 5:1,3|1>0 3>2 4>3 5>4|fb5>5|2x4',
  '2|0:0,0 1:0,1 2:1,0 3:1,1 4:1,2 5:1,3|1>0 3>2 4>3 5>4|fb1>1|2x4',
  '3|0:0,0 1:0,1 2:0,2 3:1,0 4:1,1 5:1,2|1>0 2>1 4>3 5>4|fb5>5|2x3',
  '4|0:0,0 1:0,1 2:0,2 3:1,0 4:1,1 5:1,2|1>0 2>1 4>3 5>4|fb3>5|2x3',
  '5|0:0,0 1:0,1 2:1,0 3:1,1 4:2,0 5:2,1|1>0 3>2 5>4|fb5>5|3x2',
  '6|0:0,0 1:0,1 2:1,0 3:1,1 4:2,0 5:2,1|1>0 3>2 5>4|fb4>5|3x2',
  '7|0:0,0 1:0,1 2:1,0 3:1,1 4:2,1 5:2,2|1>0 3>2 4>2 5>4|fb5>5|3x3',
  '8|0:0,0 1:0,1 2:1,0 3:1,1 4:2,1 5:2,2|1>0 3>2 4>2 5>4|fb3>3|3x3',
  '9|0:0,0 1:0,1 2:1,0 3:1,1 4:2,1 5:2,2|1>0 3>2 4>2 5>4|fb1>1|3x3',
  '10|0:0,0 1:0,1 2:0,2 3:1,0 4:1,1 5:2,1|1>0 2>1 4>3 5>3|fb2>2|3x3',
  '11|0:0,0 1:0,1 2:0,2 3:1,0 4:1,1 5:2,1|1>0 2>1 4>3 5>3|fb5>5|3x3',
  '12|0:0,0 1:0,1 2:1,0 3:1,1 4:2,1 5:3,1|1>0 3>2 4>2 5>2|fb1>1|4x2',
  '13|0:0,0 1:0,1 2:1,0 3:1,1 4:2,1 5:3,1|1>0 3>2 4>2 5>2|fb5>5|4x2',
  '14|0:0,0 1:0,1 2:1,0 3:1,1 4:1,2 5:2,2|1>0 3>2 4>3 5>3|fb5>5|3x3',
  '15|0:0,0 1:0,1 2:1,0 3:1,1 4:1,2 5:2,2|1>0 3>2 4>3 5>3|fb1>1|3x3',
  '16|0:0,0 1:0,1 2:1,1 3:1,2 4:2,1 5:2,2|1>0 2>0 4>0 3>2 5>4|fb5>5|3x3',
  '17|0:0,0 1:0,1 2:1,1 3:1,2 4:2,1 5:2,2|1>0 2>0 4>0 3>2 5>4|fb1>1|3x3',
  '18|0:0,0 1:0,1 2:1,1 3:2,1 4:2,2 5:2,3|1>0 2>0 3>0 4>3 5>4|fb2>2|3x4',
  '19|0:0,0 1:0,1 2:0,2 3:1,0 4:2,0 5:1,1|1>0 2>1 5>3 5>4|fb5>5|3x3',
  '20|0:0,0 1:1,0 2:0,1 3:2,0 4:2,1 5:3,1|2>0 2>1 4>3 5>3|fb2>2|4x2',
  '21|0:0,0 1:1,0 2:0,1 3:2,0 4:3,0 5:2,1|2>0 2>1 5>3 5>4|fb2>2|4x2',
  '22|0:0,0 1:0,1 2:1,0 3:2,0 4:3,0 5:1,1|1>0 5>2 5>3 5>4|fb5>5|4x2',
  '23|0:0,0 1:1,0 2:1,1 3:2,0 4:3,0 5:2,1|2>1 5>3 5>4|fb5>5|4x2',
  '24|0:0,0 1:1,0 2:2,0 3:3,0 4:4,0 5:2,1|5>2 5>3 5>4|fb5>5|5x2',
  '25|0:0,0 1:1,0 2:2,0 3:3,0 4:4,0 5:3,1|5>3 5>4|fb5>5|5x2',
  '26|0:0,0 1:1,0 2:1,1 3:2,0 4:2,1 5:3,1|2>1 4>3 5>3|fb5>5|4x2',
  '27|0:0,0 1:1,0 2:1,1 3:2,0 4:2,1 5:3,1|2>1 4>3 5>3|fb2>2|4x2',
  '28|0:0,0 1:0,1 2:1,0 3:1,1 4:1,2 5:2,0|1>0 3>2 4>3|fb4>4|3x3',
  '29|0:0,0 1:1,0 2:2,0 3:2,1 4:3,0 5:3,1|3>2 5>4|fb5>5|4x2',
  '30|0:0,0 1:1,0 2:2,0 3:2,1 4:2,2 5:3,0|3>2 4>3|fb4>4|4x3',
  '31|0:0,0 1:1,0 2:2,0 3:3,0 4:4,0 5:4,1|5>4|fb5>5|5x2',
  '32|0:0,0 1:1,0 2:2,0 3:3,0 4:4,0 5:5,0||fb5>5|6x1',
];

const all: Dx7Layout[] = Array.from({ length: 32 }, (_, i) => dx7AlgorithmLayout(i + 1)!);

describe('dx7AlgorithmLayout — the golden', () => {
  it('pins all 32 layouts', () => {
    expect(all.map(dx7LayoutGolden)).toEqual(LAYOUT_GOLDEN);
  });

  it('is deterministic — the same call twice gives the same picture', () => {
    for (let n = 1; n <= 32; n++) {
      expect(dx7LayoutGolden(dx7AlgorithmLayout(n)!)).toBe(dx7LayoutGolden(dx7AlgorithmLayout(n)!));
    }
  });

  it('rejects an out-of-range or non-integer algorithm rather than throwing', () => {
    for (const bad of [0, 33, -1, 1.5, NaN, Infinity]) {
      expect(dx7AlgorithmLayout(bad)).toBeUndefined();
    }
  });
});

describe('dx7AlgorithmLayout — structural invariants (all 32)', () => {
  it('places all 6 operators exactly once', () => {
    for (const lay of all) {
      expect(lay.blocks).toHaveLength(6);
      expect(lay.blocks.map((b) => b.op).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    }
  });

  it('never puts two blocks in the same (col, row) cell', () => {
    for (const lay of all) {
      const cells = new Set(lay.blocks.map((b) => `${b.col},${b.row}`));
      expect(cells.size, `alg ${lay.num} has overlapping blocks`).toBe(6);
    }
  });

  it('draws exactly the table\'s modSrcs edges — no more, no fewer', () => {
    for (const lay of all) {
      const algo = DX7_ALGORITHMS[lay.num - 1]!;
      const want: string[] = [];
      for (let to = 0; to < 6; to++) for (const from of algo.modSrcs[to]!) want.push(`${from}>${to}`);
      const got = lay.edges.map((e) => `${e.from}>${e.to}`);
      expect(got.slice().sort()).toEqual(want.slice().sort());
    }
  });

  it('carries exactly one feedback marker, verbatim from the table', () => {
    for (const lay of all) {
      const algo = DX7_ALGORITHMS[lay.num - 1]!;
      expect(lay.feedback).toEqual(algo.feedback);
      expect(lay.feedback.from).toBeGreaterThanOrEqual(0);
      expect(lay.feedback.to).toBeLessThanOrEqual(5);
    }
  });

  it('puts every CARRIER on row 0 — the carrier rail — and nothing else there', () => {
    for (const lay of all) {
      const algo = DX7_ALGORITHMS[lay.num - 1]!;
      for (const b of lay.blocks) {
        expect(
          algo.carriers.includes(b.op),
          `alg ${lay.num} op ${b.op + 1} sits on row ${b.row} — "row 0 IS the carrier rail" is ` +
            'the premise the map\'s accessible primary cue rests on. A table row that makes an ' +
            'operator BOTH a carrier and a modSrcs entry breaks it, and the renderer needs ' +
            'rethinking, not this assertion relaxing.',
        ).toBe(b.row === 0);
      }
    }
  });

  it('never draws an edge that points sideways or downwards (a modulator is always ABOVE its target)', () => {
    for (const lay of all) {
      const rowOf = new Map(lay.blocks.map((b) => [b.op, b.row]));
      for (const e of lay.edges) {
        expect(
          rowOf.get(e.from)!,
          `alg ${lay.num}: op ${e.from + 1} modulates op ${e.to + 1} but is not above it`,
        ).toBeGreaterThan(rowOf.get(e.to)!);
      }
    }
  });

  it('fills the grid exactly — cols/rows are max index + 1, with no empty edge column or row', () => {
    for (const lay of all) {
      const cols = new Set(lay.blocks.map((b) => b.col));
      const rows = new Set(lay.blocks.map((b) => b.row));
      expect(lay.cols).toBe(Math.max(...cols) + 1);
      expect(lay.rows).toBe(Math.max(...rows) + 1);
      // Every intermediate column and row is used, so a viewBox computed from
      // cols x rows has no dead gutter.
      for (let c = 0; c < lay.cols; c++) expect(cols.has(c), `alg ${lay.num} col ${c} empty`).toBe(true);
      for (let r = 0; r < lay.rows; r++) expect(rows.has(r), `alg ${lay.num} row ${r} empty`).toBe(true);
    }
  });

  it('keeps the grid small enough to draw — at most 6 columns and 4 rows', () => {
    for (const lay of all) {
      expect(lay.cols).toBeLessThanOrEqual(6);
      expect(lay.rows).toBeLessThanOrEqual(4);
      expect(lay.cols * lay.rows).toBeGreaterThanOrEqual(6);
    }
  });

  it('the routing table is ACYCLIC — the premise the row walk depends on', () => {
    for (const algo of DX7_ALGORITHMS) {
      const state = new Array<number>(6).fill(0);
      const walk = (o: number): boolean => {
        if (state[o] === 1) return false;
        if (state[o] === 2) return true;
        state[o] = 1;
        for (const m of algo.modSrcs[o]!) if (!walk(m)) return false;
        state[o] = 2;
        return true;
      };
      for (let o = 0; o < 6; o++) {
        expect(walk(o), `alg ${algo.num} has a modulation cycle`).toBe(true);
      }
    }
  });
});

describe('dx7AlgorithmLayout — negative controls on the instrument', () => {
  // A golden that cannot move is decoration. These perturb the INPUT the
  // layout claims to read and assert the output actually changes.
  it('a different modSrcs row produces a different golden line', () => {
    const seen = new Set(all.map(dx7LayoutGolden));
    expect(seen.size).toBe(32); // every algorithm draws a distinct picture
  });

  it('algorithms that differ ONLY in feedback placement still differ in the golden', () => {
    // 1 vs 2, 8 vs 9, 26 vs 27 route identically and differ only in where the
    // loop sits — exactly what PR 0 corrected. If the layout dropped the
    // feedback pair, these pairs would collapse and the test above would
    // still pass on 29 of 32.
    for (const [a, b] of [[1, 2], [8, 9], [26, 27], [12, 13], [14, 15], [16, 17]] as const) {
      const la = dx7AlgorithmLayout(a)!;
      const lb = dx7AlgorithmLayout(b)!;
      expect(la.blocks).toEqual(lb.blocks);
      expect(la.edges).toEqual(lb.edges);
      expect(dx7LayoutGolden(la)).not.toBe(dx7LayoutGolden(lb));
    }
  });

  it('the two MULTI-OPERATOR loops are the only ones where from !== to', () => {
    const multi = all.filter((l) => l.feedback.from !== l.feedback.to).map((l) => l.num);
    expect(multi).toEqual([4, 6]);
    expect(dx7AlgorithmLayout(4)!.feedback).toEqual({ from: 3, to: 5 }); // op4 -> op6
    expect(dx7AlgorithmLayout(6)!.feedback).toEqual({ from: 4, to: 5 }); // op5 -> op6
  });
});
