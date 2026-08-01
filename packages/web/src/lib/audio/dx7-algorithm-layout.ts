// packages/web/src/lib/audio/dx7-algorithm-layout.ts
//
// GEOMETRY FOR THE DX7 ALGORITHM PICTURE — derived, never hand-drawn.
//
// ONE pure function feeds the algorithm picker, the operator map, the operator
// tiles and the rackline glyph, so the picture can never drift from the engine:
// every block, every edge and the feedback marker are computed from
// `DX7_ALGORITHMS` (the corrected 32-row routing table), which is the same
// table `dx7-render.ts` and the worklet route with. Ship 32 hand-drawn SVGs
// instead and they rot the instant the table changes, with nothing noticing.
//
// UNITS — state them, because both fields are integers and neither is pixels:
//   `col` is a COLUMN INDEX (0 = leftmost), `row` is a ROW INDEX where
//   **row 0 is the CARRIER row**, growing UPWARDS through the modulator stack.
//   `row` is literally the longest path from the block DOWN to a carrier, so a
//   4-deep serial algorithm has rows 0..3 and `rows === 4`. A renderer that
//   draws modulators above carriers maps row → y as `(rows - 1 - row)`;
//   nothing in this module knows about pixels, viewBoxes or which way is up.
//
// The layout is deliberately NOT scaled to any canvas: consumers compute a
// viewBox from `cols`/`rows` and use `preserveAspectRatio="xMidYMid meet"`, so
// a deep serial algorithm shrinks and a flat additive one grows without
// clipping.

import { DX7_ALGORITHMS, type DX7Feedback } from './dx7-algorithms';

/** One operator block, positioned on the integer (col, row) grid. */
export interface Dx7Block {
  /** Operator index 0..5 (op1 = 0). */
  op: number;
  /** Column index, 0 = leftmost. */
  col: number;
  /** Row index, 0 = the CARRIER row; higher = further up the modulator stack. */
  row: number;
}

/** A modulation edge: operator `from`'s output bends operator `to`'s phase. */
export interface Dx7Edge {
  from: number;
  to: number;
}

/**
 * The computed picture for one algorithm.
 *
 * INVARIANTS (all asserted in dx7-algorithm-layout.test.ts, for all 32 rows):
 *   - `blocks.length === 6` — every operator is placed exactly once;
 *   - no two blocks share a `(col, row)` pair;
 *   - `edges` is exactly the union of the table's `modSrcs` entries;
 *   - `feedback` is the table's feedback pair, verbatim, and there is one;
 *   - `cols`/`rows` are max index + 1 (so the grid is exactly filled).
 */
export interface Dx7Layout {
  /** 1-indexed algorithm number 1..32. */
  num: number;
  blocks: Dx7Block[];
  edges: Dx7Edge[];
  /** The algorithm's single feedback loop. `from === to` is a self-loop; the
   *  two multi-operator loops are algorithm 4 (op4 → op6) and 6 (op5 → op6). */
  feedback: DX7Feedback;
  /** Grid width  = max col + 1. */
  cols: number;
  /** Grid height = max row + 1. */
  rows: number;
}

/**
 * Compute the block/edge geometry for DX7 algorithm `num` (1..32).
 *
 * Returns `undefined` for an out-of-range or non-integer `num` rather than
 * throwing — callers render whatever they have and a bad stored algorithm
 * value must not take a card down.
 *
 * ROWS — longest path down to a carrier. A carrier is row 0. Any other
 * operator sits one row above the DEEPEST consumer it modulates, so a stack
 * never draws an edge that skips backwards over a block.
 *
 * COLS — a left-to-right depth-first walk over the carriers in operator order.
 * Each LEAF (an operator nothing modulates) claims the next free column; a
 * consumer left-aligns onto the leftmost column of the children *it* placed,
 * which makes a serial stack render as one vertical column. An operator that
 * feeds SEVERAL consumers (algorithms 19-22 and friends) is placed once, by
 * its first consumer; the later consumers find it already placed, have no
 * fresh child to align to, and claim a fresh column of their own — which is
 * exactly what stops two carriers sharing a cell and turns the shared
 * modulator's second edge into the diagonal fan-out the DX7 chart draws.
 */
export function dx7AlgorithmLayout(num: number): Dx7Layout | undefined {
  if (!Number.isInteger(num) || num < 1 || num > 32) return undefined;
  const algo = DX7_ALGORITHMS[num - 1];
  if (!algo) return undefined;

  const OPS = 6;
  const carrier = new Array<boolean>(OPS).fill(false);
  for (const c of algo.carriers) if (c >= 0 && c < OPS) carrier[c] = true;

  // Consumers: `consumers[m]` = the operators whose phase m modulates.
  const consumers: number[][] = Array.from({ length: OPS }, () => [] as number[]);
  const edges: Dx7Edge[] = [];
  for (let to = 0; to < OPS; to++) {
    for (const from of algo.modSrcs[to] ?? []) {
      consumers[from]!.push(to);
      edges.push({ from, to });
    }
  }

  // ---- ROWS: longest path down to a carrier -------------------------------
  // The table is acyclic (asserted in the test), so a memoised DFS terminates;
  // the `visiting` guard is belt-and-braces against a future bad table row and
  // degrades to "treat it as a carrier" rather than hanging the UI.
  const row = new Array<number>(OPS).fill(-1);
  const visiting = new Array<boolean>(OPS).fill(false);
  function depth(o: number): number {
    if (row[o]! >= 0) return row[o]!;
    if (visiting[o]) return 0;
    visiting[o] = true;
    let d = carrier[o] ? 0 : -1;
    for (const c of consumers[o]!) d = Math.max(d, depth(c) + 1);
    visiting[o] = false;
    row[o] = Math.max(0, d);
    return row[o]!;
  }
  for (let o = 0; o < OPS; o++) depth(o);

  // ---- COLS: left-to-right DFS over the carriers in operator order --------
  const col = new Array<number>(OPS).fill(-1);
  let nextCol = 0;
  function place(o: number): void {
    if (col[o]! >= 0 || col[o] === -2) return;
    col[o] = -2; // in-progress marker; also breaks a hypothetical cycle
    let leftmost = Number.POSITIVE_INFINITY;
    for (const m of [...(algo.modSrcs[o] ?? [])].sort((a, b) => a - b)) {
      if (col[m]! >= 0 || col[m] === -2) continue; // already placed / in progress
      place(m);
      leftmost = Math.min(leftmost, col[m]!);
    }
    col[o] = Number.isFinite(leftmost) ? leftmost : nextCol++;
  }
  for (const c of [...algo.carriers].sort((a, b) => a - b)) place(c);
  // Safety sweep: an operator reachable from no carrier (none exist in the
  // shipped table — the test asserts it) still gets a cell rather than a -1.
  for (let o = 0; o < OPS; o++) if (col[o]! < 0) col[o] = nextCol++;

  const blocks: Dx7Block[] = [];
  for (let o = 0; o < OPS; o++) blocks.push({ op: o, col: col[o]!, row: row[o]! });

  let cols = 0;
  let rows = 0;
  for (const b of blocks) {
    cols = Math.max(cols, b.col + 1);
    rows = Math.max(rows, b.row + 1);
  }

  return { num, blocks, edges, feedback: { ...algo.feedback }, cols, rows };
}

/**
 * A compact, diffable one-line encoding of a layout — the GOLDEN format.
 *
 *   `5|0:0,0 1:0,1 2:1,0 3:1,1 4:2,0 5:2,1|1>0 3>2 5>4|fb5>5|3x2`
 *    ^  ^op:col,row per operator          ^edges  ^loop  ^cols x rows
 *
 * Pinned for all 32 algorithms in dx7-algorithm-layout.test.ts, so any change
 * to the routing table (or to the placement rules) surfaces as a readable
 * line diff rather than a silently different picture.
 */
export function dx7LayoutGolden(layout: Dx7Layout): string {
  const blocks = layout.blocks.map((b) => `${b.op}:${b.col},${b.row}`).join(' ');
  const edges = layout.edges.map((e) => `${e.from}>${e.to}`).join(' ');
  return `${layout.num}|${blocks}|${edges}|fb${layout.feedback.from}>${layout.feedback.to}|${layout.cols}x${layout.rows}`;
}
