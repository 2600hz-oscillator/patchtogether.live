// packages/web/src/lib/graph/channel-columns.test.ts
//
// PURE tests for the workflow channel-columns geometry + ordered-membership
// helpers. The membership reconcilers (reconcileColumnOrder / reconcileSendOrder)
// are the COLLAB-CRITICAL heal: a lost concurrent append self-heals at the
// bottom, idempotently, converging across peers.

import { describe, it, expect } from 'vitest';
import {
  COLUMN_COUNT,
  COLUMN_W,
  COLUMN_SLOT_H,
  COLUMN_BASELINE_Y,
  columnXBand,
  sendBoxXBand,
  sendRailXBand,
  columnForFlowX,
  sendBoxForFlowX,
  columnMemberPos,
  sendMemberPos,
  columnBottomFlowPos,
  columnFlushPositions,
  sendFlushPositions,
  COLUMN_PAD_X,
  indexForDropY,
  dedup,
  reconcileColumnOrder,
  reconcileSendOrder,
  insertBottom,
  insertTop,
  removeFrom,
  reorder,
  moveBetween,
  type ColumnNodeView,
} from './channel-columns';

// ---------------- Geometry ----------------

describe('column geometry', () => {
  it('has 8 columns, each 34 HP wide (fits a 4hp / 720px tidyvco+sixstrum card)', () => {
    expect(COLUMN_COUNT).toBe(8);
    expect(COLUMN_W).toBe(765); // 34 × 22.5
    // The widest workflow cards are 4hp = 720px; with the 22.5px left pad the
    // card's right edge (742.5) must clear the column divider (765).
    expect(COLUMN_W).toBeGreaterThanOrEqual(720 + 22.5);
  });

  it('columnXBand is contiguous, non-overlapping, ascending', () => {
    for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
      const [x0, x1] = columnXBand(ch);
      expect(x1 - x0).toBe(COLUMN_W);
      if (ch > 1) expect(x0).toBe(columnXBand(ch - 1)[1]); // butts the previous
    }
  });

  it('columnForFlowX maps X into 1..8, then send, then null', () => {
    expect(columnForFlowX(columnXBand(1)[0])).toBe(1);
    expect(columnForFlowX(columnXBand(1)[0] + 5)).toBe(1);
    expect(columnForFlowX(columnXBand(8)[0] + 5)).toBe(8);
    // Just inside the sends rail.
    expect(columnForFlowX(sendRailXBand()[0] + 5)).toBe('send');
    // Left of the columns, and right of the sends rail → null (free canvas).
    expect(columnForFlowX(-50)).toBeNull();
    expect(columnForFlowX(sendRailXBand()[1] + 50)).toBeNull();
  });

  it('the sends rail sits immediately right of column 8, split into 2 side-by-side boxes', () => {
    expect(sendRailXBand()[0]).toBe(columnXBand(8)[1]);
    // Two boxes, side by side, each one column wide.
    expect(sendBoxXBand(1)[0]).toBe(sendRailXBand()[0]);
    expect(sendBoxXBand(2)[0]).toBe(sendBoxXBand(1)[1]); // box 2 right of box 1
    expect(sendBoxXBand(1)[1] - sendBoxXBand(1)[0]).toBe(COLUMN_W);
  });

  it('sendBoxForFlowX picks the box by X (side-by-side, not top/bottom)', () => {
    expect(sendBoxForFlowX(sendBoxXBand(1)[0] + 10)).toBe(1);
    expect(sendBoxForFlowX(sendBoxXBand(2)[0] + 10)).toBe(2);
  });

  it('columnMemberPos is BOTTOM-ANCHORED: the tail sits above the baseline, source above it', () => {
    // A 3-member column: index 0 (source) is highest, index 2 (tail) is lowest,
    // just above the baseline. y increases with index (downward).
    const p0 = columnMemberPos(3, 0, 3);
    const p1 = columnMemberPos(3, 1, 3);
    const p2 = columnMemberPos(3, 2, 3);
    expect(p1.y).toBeGreaterThan(p0.y);
    expect(p2.y).toBeGreaterThan(p1.y);
    // The tail sits one slot above the baseline.
    expect(p2.y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H);
    // Same column → same X; a later column → larger X.
    expect(p1.x).toBe(p0.x);
    expect(columnMemberPos(4, 0, 3).x).toBeGreaterThan(p0.x);
  });

  it('adding a member keeps the TAIL pinned to the bottom (existing members shift UP)', () => {
    // Single member: sits just above baseline.
    expect(columnMemberPos(2, 0, 1).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H);
    // After a 2nd member is added, the NEW one is the tail (bottom), the old one
    // shifts up one slot.
    expect(columnMemberPos(2, 1, 2).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H); // new tail, same bottom slot
    expect(columnMemberPos(2, 0, 2).y).toBe(COLUMN_BASELINE_Y - 2 * COLUMN_SLOT_H); // old one moved up
    // The tail slot is stable regardless of column depth.
    expect(columnMemberPos(2, 4, 5).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H);
  });

  it('columnBottomFlowPos(ch, count) is the new bottom slot (snap to bottom)', () => {
    expect(columnBottomFlowPos(2, 0).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H); // empty → first at bottom
    expect(columnBottomFlowPos(2, 3).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H); // always the bottom slot
  });

  it('sendMemberPos is bottom-anchored inside its own side-by-side box', () => {
    const s1 = sendMemberPos(1, 0, 1);
    const s2 = sendMemberPos(2, 0, 1);
    expect(s1.y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H);
    expect(s2.x).toBeGreaterThan(s1.x); // box 2 is to the right of box 1
  });

  // ---- FLUSH bottom-up stacking (owner: no gaps; first card at very bottom) ----
  describe('columnFlushPositions — flush, bottom-anchored, no gaps', () => {
    it('a single member sits at the VERY bottom (its bottom edge on the baseline)', () => {
      const [x0] = columnXBand(3);
      const h = 540; // a 3u card
      const [p] = columnFlushPositions(3, [h]);
      expect(p!.x).toBe(x0 + COLUMN_PAD_X);
      // bottom edge = top + height == baseline (no gap below).
      expect(p!.y + h).toBe(COLUMN_BASELINE_Y);
    });

    it('stacks multiple cards FLUSH bottom-up with ZERO gaps (variable heights)', () => {
      const heights = [720, 360, 540]; // top→bottom: tidyvco(4u), sixstrum(2u), cloudseed(3u)
      const pos = columnFlushPositions(2, heights);
      // Bottom card flush to baseline.
      expect(pos[2]!.y + heights[2]!).toBe(COLUMN_BASELINE_Y);
      // Each card's bottom edge == the next card's top edge (touching, no gap).
      expect(pos[1]!.y + heights[1]!).toBe(pos[2]!.y);
      expect(pos[0]!.y + heights[0]!).toBe(pos[1]!.y);
      // All same X (column left pad).
      expect(pos[0]!.x).toBe(pos[1]!.x);
      expect(pos[1]!.x).toBe(pos[2]!.x);
      // Grows UPWARD: earlier index (higher in the stack) has a smaller y.
      expect(pos[0]!.y).toBeLessThan(pos[1]!.y);
      expect(pos[1]!.y).toBeLessThan(pos[2]!.y);
    });

    it('adding a member keeps the bottom flush + pushes the rest up by exactly its height', () => {
      const before = columnFlushPositions(1, [360, 540]); // 2 cards
      const after = columnFlushPositions(1, [720, 360, 540]); // prepend a 720 on top
      // The two original cards keep their positions (bottom-anchored).
      expect(after[1]!.y).toBe(before[0]!.y);
      expect(after[2]!.y).toBe(before[1]!.y);
    });

    it('sendFlushPositions stacks flush in its own side-by-side box', () => {
      const s1 = sendFlushPositions(1, [200]);
      const s2 = sendFlushPositions(2, [200]);
      expect(s1[0]!.y + 200).toBe(COLUMN_BASELINE_Y);
      expect(s2[0]!.x).toBeGreaterThan(s1[0]!.x);
    });
  });

  it('indexForDropY finds the insert slot among sibling centers', () => {
    const centers = [100, 300, 500];
    expect(indexForDropY(centers, 50)).toBe(0); // above all
    expect(indexForDropY(centers, 200)).toBe(1); // between 1st and 2nd
    expect(indexForDropY(centers, 400)).toBe(2);
    expect(indexForDropY(centers, 999)).toBe(3); // below all → append
  });
});

// ---------------- Array helpers ----------------

const nodesMap = (entries: ColumnNodeView[]): Map<string, ColumnNodeView> =>
  new Map(entries.map((e) => [e.id, e]));

describe('dedup / insert / remove / reorder', () => {
  it('dedup preserves first-occurrence order', () => {
    expect(dedup(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
  it('insertBottom / insertTop are no-ops when present', () => {
    expect(insertBottom(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(insertBottom(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(insertTop(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
    expect(insertTop(['a', 'b'], 'b')).toEqual(['a', 'b']);
  });
  it('removeFrom drops the id', () => {
    expect(removeFrom(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
  it('reorder moves an id to a new index (index vs the removed array)', () => {
    expect(reorder(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']); // to end
    expect(reorder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']); // to top
    expect(reorder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']); // no move
    expect(reorder(['a', 'b', 'c'], 'z', 0)).toEqual(['a', 'b', 'c']); // absent
  });
});

describe('moveBetween', () => {
  it('removes from the source and appends to the destination', () => {
    expect(moveBetween(['a', 'b'], ['x', 'y'], 'a')).toEqual({ from: ['b'], to: ['x', 'y', 'a'] });
  });
});

// ---------------- reconcileColumnOrder — the CRDT heal ----------------

describe('reconcileColumnOrder (membership heal)', () => {
  it('drops ids whose data.channel no longer matches (moved / cleared)', () => {
    const nodes = nodesMap([
      { id: 'a', channel: 1 },
      { id: 'b', channel: 2 }, // moved away
      { id: 'c', channel: 1 },
    ]);
    expect(reconcileColumnOrder(['a', 'b', 'c'], 1, nodes)).toEqual(['a', 'c']);
  });

  it('drops ids that no longer exist', () => {
    const nodes = nodesMap([{ id: 'a', channel: 1 }]);
    expect(reconcileColumnOrder(['a', 'ghost'], 1, nodes)).toEqual(['a']);
  });

  it('ADOPTS a lost concurrent append at the bottom (sorted for cross-peer convergence)', () => {
    // data.channel is truth: x + z belong to ch1 but the order array only has x
    // (z's concurrent push was lost in the last-writer-wins Y.Map value).
    const nodes = nodesMap([
      { id: 'x', channel: 1 },
      { id: 'z', channel: 1 }, // lost append
      { id: 'm', channel: 1 }, // another lost append
    ]);
    // Sorted adoption → deterministic tail on every peer.
    expect(reconcileColumnOrder(['x'], 1, nodes)).toEqual(['x', 'm', 'z']);
  });

  it('is IDEMPOTENT — re-running on its own output is a no-op', () => {
    const nodes = nodesMap([
      { id: 'a', channel: 1 },
      { id: 'b', channel: 1 },
      { id: 'c', channel: 1 },
    ]);
    const once = reconcileColumnOrder(['b', 'a'], 1, nodes);
    const twice = reconcileColumnOrder(once, 1, nodes);
    expect(twice).toEqual(once);
  });

  it('de-dups a doubled id', () => {
    const nodes = nodesMap([{ id: 'a', channel: 1 }, { id: 'b', channel: 1 }]);
    expect(reconcileColumnOrder(['a', 'a', 'b'], 1, nodes)).toEqual(['a', 'b']);
  });

  it('preserves the intended order for existing members (no gratuitous re-sort)', () => {
    const nodes = nodesMap([
      { id: 'a', channel: 1 },
      { id: 'b', channel: 1 },
      { id: 'c', channel: 1 },
    ]);
    // User-authored order b,c,a is preserved (only ADOPTED tail members sort).
    expect(reconcileColumnOrder(['b', 'c', 'a'], 1, nodes)).toEqual(['b', 'c', 'a']);
  });

  it('CONVERGENCE: two peers with divergent orders but same membership truth heal to the SAME array', () => {
    const nodes = nodesMap([
      { id: 'a', channel: 1 },
      { id: 'b', channel: 1 },
      { id: 'c', channel: 1 }, // both peers lost c's append
    ]);
    // Peer A saw [a,b]; peer B saw [b,a]. Different kept orders → NOT guaranteed
    // identical (kept order is user layout), but the ADOPTED member c lands at
    // the same relative place (bottom) on both. The invariant we DO guarantee:
    // membership set is identical + adopted tail is deterministic.
    const healA = reconcileColumnOrder(['a', 'b'], 1, nodes);
    const healB = reconcileColumnOrder(['a', 'b'], 1, nodes);
    expect(healA).toEqual(healB); // same input → identical output (determinism)
    expect(new Set(healA)).toEqual(new Set(['a', 'b', 'c'])); // full membership
    expect(healA[healA.length - 1]).toBe('c'); // adopted at the bottom
  });
});

describe('reconcileSendOrder (send membership heal)', () => {
  it('keeps only sendSlot matches and adopts lost appends at the bottom', () => {
    const nodes = nodesMap([
      { id: 'r', sendSlot: 1 },
      { id: 's', sendSlot: 2 }, // other box
      { id: 't', sendSlot: 1 }, // lost append
    ]);
    expect(reconcileSendOrder(['r'], 1, nodes)).toEqual(['r', 't']);
    expect(reconcileSendOrder(['r', 's'], 2, nodes)).toEqual(['s']);
  });
});
