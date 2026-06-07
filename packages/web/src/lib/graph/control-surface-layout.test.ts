// packages/web/src/lib/graph/control-surface-layout.test.ts
//
// CONTROL SURFACE — layout geometry coverage (the resize-clip bug fix).
//
// The bug: the card was fixed-width (360px) with a fixed-height (~150px),
// overflow:hidden `.cs-canvas`, while group boxes are absolutely positioned and
// tiled in rows of 2 at a fixed 150px row pitch. Absolute children don't expand
// their parent, so any group past the FIRST ROW (y >= 160, below the 150px
// canvas) and the column-1 box (x=190..358, past the 344px inner width) were
// added-to-the-Y.Doc-but-CLIPPED → the user thought "can't add more than ~2".
//
// The fix (unlocked layout): size `.cs-canvas` from the box positions so it
// GROWS to contain every box. These tests pin that geometry so a regression to
// a fixed canvas size is caught WITHOUT a browser (vitest runs in `node`; the
// rendered/DOM bounds are covered by the e2e control-surface spec).

import { describe, it, expect } from 'vitest';
import {
  BOX_W,
  ORIGIN,
  groupBoxHeight,
  defaultPos,
  posFor,
  unlockedCanvasSize,
  type Pos,
} from './control-surface-layout';

// A box at `pos` occupies [pos.x, pos.x+BOX_W] × [pos.y, pos.y+groupBoxHeight].
function boxRect(pos: Pos, knobCount: number) {
  return {
    left: pos.x,
    right: pos.x + BOX_W,
    top: pos.y,
    bottom: pos.y + groupBoxHeight(knobCount),
  };
}

describe('control-surface-layout geometry', () => {
  it('groupBoxHeight grows with knob count (rows of 3) and is never < one row', () => {
    const h1 = groupBoxHeight(1);
    const h3 = groupBoxHeight(3);
    const h4 = groupBoxHeight(4); // wraps to a 2nd row
    expect(h1).toBeGreaterThan(0);
    expect(h3).toBe(h1); // 1..3 knobs = one row
    expect(h4).toBeGreaterThan(h3); // 4 knobs = taller box
    expect(groupBoxHeight(0)).toBe(h1); // empty still reserves a row
  });

  it('defaultPos tiles in rows of 2', () => {
    expect(defaultPos(0)).toEqual({ x: ORIGIN, y: ORIGIN });
    expect(defaultPos(1)).toEqual({ x: ORIGIN + BOX_W + 12, y: ORIGIN });
    // index 2 starts a new row (BUG: this y was below the old 150px canvas)
    expect(defaultPos(2).y).toBeGreaterThan(150);
  });

  it('posFor prefers a saved layout, else the default tile', () => {
    const layout = { 'mod-a': { x: 999, y: 888 } };
    expect(posFor(layout, 'mod-a', 0)).toEqual({ x: 999, y: 888 });
    expect(posFor(layout, 'mod-b', 1)).toEqual(defaultPos(1)); // unsaved → tile
    expect(posFor(undefined, 'mod-a', 3)).toEqual(defaultPos(3)); // no layout
  });

  // ── the core regression: with >= 4 groups, the computed canvas CONTAINS
  //    every box. Under the old fixed 360px/150px canvas these would clip. ──
  it('unlocked canvas grows to contain ALL groups (>=4 across modules) — none clipped', () => {
    const groups = [
      { moduleId: 'adsr-1', knobCount: 4 }, // ADSR: A/D/S/R
      { moduleId: 'filter-1', knobCount: 3 },
      { moduleId: 'lfo-1', knobCount: 2 },
      { moduleId: 'vca-1', knobCount: 1 },
    ];
    const layout = undefined; // fresh surface → default tiling
    const size = unlockedCanvasSize(groups, layout);

    // Every box must be fully inside [0,width] × [0,height] (no clip).
    groups.forEach((g, i) => {
      const r = boxRect(posFor(layout, g.moduleId, i), g.knobCount);
      expect(r.right, `${g.moduleId} right within canvas`).toBeLessThanOrEqual(size.width);
      expect(r.bottom, `${g.moduleId} bottom within canvas`).toBeLessThanOrEqual(size.height);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
    });

    // The 2nd row (index 2,3) sits well below the OLD fixed 150px canvas, and
    // the column-1 box (index 1,3) extends past the OLD 344px inner width —
    // proving the new size accommodates exactly what used to be clipped.
    expect(size.height).toBeGreaterThan(150 + groupBoxHeight(2));
    expect(size.width).toBeGreaterThanOrEqual(defaultPos(1).x + BOX_W);
  });

  it('respects dragged (saved) positions — a far box still fits the canvas', () => {
    const groups = [
      { moduleId: 'a', knobCount: 3 },
      { moduleId: 'b', knobCount: 4 },
    ];
    // User dragged 'b' far down-right while UNLOCKED.
    const layout = { b: { x: 500, y: 400 } };
    const size = unlockedCanvasSize(groups, layout);
    const rb = boxRect(posFor(layout, 'b', 1), 4);
    expect(rb.right).toBeLessThanOrEqual(size.width);
    expect(rb.bottom).toBeLessThanOrEqual(size.height);
    // Canvas extended to include the far box (+ ORIGIN margin).
    expect(size.width).toBeGreaterThanOrEqual(500 + BOX_W);
    expect(size.height).toBeGreaterThanOrEqual(400 + groupBoxHeight(4));
  });

  it('a tall many-knob box is fully contained (height tracks knob rows)', () => {
    const groups = [{ moduleId: 'big', knobCount: 9 }]; // 3 rows of knobs
    const size = unlockedCanvasSize(groups, undefined);
    const r = boxRect(posFor(undefined, 'big', 0), 9);
    expect(r.bottom).toBeLessThanOrEqual(size.height);
    expect(size.height).toBeGreaterThanOrEqual(groupBoxHeight(9));
  });

  it('empty / single-group surface keeps a sane minimum footprint', () => {
    const empty = unlockedCanvasSize([], undefined);
    expect(empty.width).toBeGreaterThanOrEqual(BOX_W);
    expect(empty.height).toBeGreaterThanOrEqual(groupBoxHeight(1));
  });
});
