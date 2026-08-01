// packages/web/src/lib/ui/modules/dx7/dx7-glyph-model.ts
//
// PURE SVG GEOMETRY for the DX7 algorithm diagram (dx7 PR 4).
//
// `dx7-algorithm-layout.ts` (PR 3) answers "which operator sits at which
// (col, row)"; this module answers "where does that land on a canvas". The
// split is the repo idiom — `param-grid-model.ts` / `scope-screen-model.ts`
// are the same shape — and it is what makes the picture TESTABLE: every
// invariant below is asserted against all 32 algorithms in the sibling spec,
// with no browser and no component harness.
//
// ONE geometry, THREE consumers (the plan's "one pure layout function shared
// with the picker, the operator map and the tiles"): the shell's face glyph,
// the 32-cell ParamGrid picker, and — next PR — the operator map. They differ
// only by the `unit` they pass, so a 46 px lane tile and a dock faceplate can
// never disagree about the SHAPE of algorithm 5.
//
// ORIENTATION: row 0 is the CARRIER row and it renders at the BOTTOM, which is
// how every Yamaha chart draws it — signal falls down the stack to the output.
// `dx7AlgorithmLayout` guarantees a modulator sits above the deepest operator
// it modulates, so mapping row→y with the flip below makes every edge point
// strictly downward. That is asserted, not assumed (see `EDGES POINT DOWN`).

import type { Dx7Layout } from '$lib/audio/dx7-algorithm-layout';

/** Layout units per grid column / row, and the block drawn inside that cell. */
export const COL_PITCH = 14;
export const ROW_PITCH = 14;
export const BLOCK_W = 10;
export const BLOCK_H = 8;

/** Horizontal room reserved right of the grid for the feedback loop to run in. */
export const FEEDBACK_GUTTER = 6;

/** One operator block, placed on the canvas. */
export interface Dx7GlyphBlock {
  /** Operator index 0..5 (op1 = 0) — the caption is `op + 1`. */
  op: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Row 0 — reaches the output directly, so it is drawn filled. */
  carrier: boolean;
}

/** A modulation edge, as a straight segment from modulator down to consumer. */
export interface Dx7GlyphEdge {
  from: number;
  to: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The feedback loop, as a ready-to-draw path `d`. */
export interface Dx7GlyphFeedback {
  from: number;
  to: number;
  d: string;
}

export interface Dx7GlyphGeometry {
  num: number;
  /** `0 0 w h` — pair with `preserveAspectRatio="xMidYMid meet"`. */
  viewBox: string;
  width: number;
  height: number;
  blocks: Dx7GlyphBlock[];
  edges: Dx7GlyphEdge[];
  feedback: Dx7GlyphFeedback | undefined;
}

/**
 * Project a `Dx7Layout` onto drawing coordinates.
 *
 * Deliberately NOT scaled to a pixel size — the canvas is in layout units and
 * the consumer scales via `viewBox` + `preserveAspectRatio`, so a deep serial
 * algorithm shrinks and a flat additive one grows without clipping (the note
 * `dx7-algorithm-layout.ts` leaves for exactly this).
 */
export function dx7GlyphGeometry(layout: Dx7Layout): Dx7GlyphGeometry {
  const width = layout.cols * COL_PITCH + FEEDBACK_GUTTER;
  const height = layout.rows * ROW_PITCH;

  const blockX = (col: number) => col * COL_PITCH + (COL_PITCH - BLOCK_W) / 2;
  // ROW FLIP: row 0 (carriers) renders at the BOTTOM of the canvas.
  const blockY = (row: number) => (layout.rows - 1 - row) * ROW_PITCH + (ROW_PITCH - BLOCK_H) / 2;

  const blocks: Dx7GlyphBlock[] = layout.blocks.map((b) => ({
    op: b.op,
    x: blockX(b.col),
    y: blockY(b.row),
    w: BLOCK_W,
    h: BLOCK_H,
    carrier: b.row === 0,
  }));

  const byOp = new Map(layout.blocks.map((b) => [b.op, b]));

  const edges: Dx7GlyphEdge[] = layout.edges.flatMap((e) => {
    const from = byOp.get(e.from);
    const to = byOp.get(e.to);
    // `dx7AlgorithmLayout` places all six operators, so both lookups hold for
    // every table row. Skip rather than throw if a future table edit breaks
    // that — a bad diagram must never take the card down.
    if (!from || !to) return [];
    return [
      {
        from: e.from,
        to: e.to,
        x1: blockX(from.col) + BLOCK_W / 2,
        y1: blockY(from.row) + BLOCK_H,
        x2: blockX(to.col) + BLOCK_W / 2,
        y2: blockY(to.row),
      },
    ];
  });

  return {
    num: layout.num,
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    blocks,
    edges,
    feedback: feedbackPath(layout, blockX, blockY, width),
  };
}

/**
 * The feedback loop as an SVG path, routed in the right-hand gutter so it can
 * never cross the block stack.
 *
 * Two shapes, because the table has two kinds: a SELF-loop (op n → op n, the
 * common case) draws a small ear on the block's right edge; the two MULTI-op
 * loops (algorithm 4's op4 → op6 and algorithm 6's op5 → op6) run out to the
 * gutter, along, and back — so the picture shows the span the loop encloses.
 */
function feedbackPath(
  layout: Dx7Layout,
  blockX: (col: number) => number,
  blockY: (row: number) => number,
  width: number,
): Dx7GlyphFeedback | undefined {
  const fb = layout.feedback;
  if (!fb) return undefined;
  const from = layout.blocks.find((b) => b.op === fb.from);
  const to = layout.blocks.find((b) => b.op === fb.to);
  if (!from || !to) return undefined;

  const fx = blockX(from.col) + BLOCK_W;
  const fy = blockY(from.row);
  const tx = blockX(to.col) + BLOCK_W;
  const ty = blockY(to.row);

  if (fb.from === fb.to) {
    // Self-loop: an ear off the right edge, from just below the top corner
    // back to just above the bottom corner.
    const r = 3;
    return {
      from: fb.from,
      to: fb.to,
      d: `M ${fx} ${fy + 1.5} q ${r} 0 ${r} ${r} q 0 ${r} ${-r} ${r}`,
    };
  }

  // Multi-operator loop: out to the gutter lane, along it, and back in.
  const lane = width - FEEDBACK_GUTTER / 2;
  return {
    from: fb.from,
    to: fb.to,
    d: `M ${fx} ${fy + BLOCK_H / 2} H ${lane} V ${ty + BLOCK_H / 2} H ${tx}`,
  };
}
