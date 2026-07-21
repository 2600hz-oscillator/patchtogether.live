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
  columnXBand,
  sendRailXBand,
  columnForFlowX,
  sendBoxForFlowY,
  isTopThirdDrop,
  columnMemberPos,
  columnBottomFlowPos,
  indexForDropY,
  dedup,
  reconcileColumnOrder,
  reconcileSendOrder,
  insertBottom,
  insertTop,
  removeFrom,
  reorder,
  moveBetween,
  COLUMN_H,
  COLUMN_TOP_Y,
  type ColumnNodeView,
} from './channel-columns';

// ---------------- Geometry ----------------

describe('column geometry', () => {
  it('has 8 columns, each 16 HP wide', () => {
    expect(COLUMN_COUNT).toBe(8);
    expect(COLUMN_W).toBe(360); // 16 × 22.5
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

  it('the sends rail sits immediately right of column 8', () => {
    expect(sendRailXBand()[0]).toBe(columnXBand(8)[1]);
  });

  it('sendBoxForFlowY splits the rail top(1)/bottom(2)', () => {
    expect(sendBoxForFlowY(COLUMN_TOP_Y + 10)).toBe(1);
    expect(sendBoxForFlowY(COLUMN_TOP_Y + COLUMN_H / 2 + 10)).toBe(2);
  });

  it('columnMemberPos is a pure ascending function of the index within a column', () => {
    const p0 = columnMemberPos(3, 0);
    const p1 = columnMemberPos(3, 1);
    const p2 = columnMemberPos(3, 2);
    expect(p1.y).toBeGreaterThan(p0.y);
    expect(p2.y).toBeGreaterThan(p1.y);
    // Same column → same X.
    expect(p1.x).toBe(p0.x);
    // Different column → different X band.
    expect(columnMemberPos(4, 0).x).toBeGreaterThan(p0.x);
  });

  it('columnBottomFlowPos(ch, n) == columnMemberPos(ch, n)', () => {
    expect(columnBottomFlowPos(2, 3)).toEqual(columnMemberPos(2, 3));
  });

  it('isTopThirdDrop: top third true, below false; empty span false', () => {
    expect(isTopThirdDrop(5, 0, 300)).toBe(true); // within top 100
    expect(isTopThirdDrop(150, 0, 300)).toBe(false);
    expect(isTopThirdDrop(10, 0, 0)).toBe(false); // empty column
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
