// Unit tests for the organize-modules layout pass.
// Pure data, no DOM. Run via vitest in the web workspace.
//
// The pass is a row-pack: sort by (y, x), then walk modules into rows of
// width ≤ viewport.width with GAP between every adjacent box. The tests
// assert the contract (no overlap + relative arrangement preserved + dense
// packing inside the viewport + idempotent on a second pass).

import { describe, it, expect } from 'vitest';
import { organizeLayout, hasNoOverlaps, type Box, type OrganizeViewport } from './organize';

const W = 200;
const H = 100;
const VIEW: OrganizeViewport = { width: 1280, height: 720, originX: 0, originY: 0 };
const GAP = 24;

function box(id: string, x: number, y: number, w: number = W, h: number = H): Box {
  return { id, x, y, w, h };
}

function bbox(boxes: Box[], positions: { id: string; x: number; y: number }[]) {
  const byId = new Map(positions.map((p) => [p.id, p]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    const p = byId.get(b.id) ?? { x: b.x, y: b.y };
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + b.w);
    maxY = Math.max(maxY, p.y + b.h);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function quadrant(p: { x: number; y: number }, mid: { x: number; y: number }) {
  // 'tl' / 'tr' / 'bl' / 'br'.
  const v = p.y < mid.y ? 't' : 'b';
  const h = p.x < mid.x ? 'l' : 'r';
  return v + h;
}

describe('organizeLayout', () => {
  it('returns positions sorted by id (deterministic)', () => {
    const input = [box('z', 0, 0), box('a', 10, 10), box('m', 20, 20)];
    const out = organizeLayout(input, { viewport: VIEW });
    expect(out.map((p) => p.id)).toEqual(['a', 'm', 'z']);
  });

  it('is deterministic across runs given the same input', () => {
    const input = [box('a', 0, 0), box('b', 50, 0), box('c', 100, 0), box('d', 30, 30)];
    const a = organizeLayout(input, { viewport: VIEW });
    const b = organizeLayout(input, { viewport: VIEW });
    expect(a).toEqual(b);
  });

  it('returns integer-snapped positions', () => {
    const input = [
      box('a', 0.7, 1.3, 200.4, 100.1),
      box('b', 50.5, 0.2, 200.9, 100.6),
    ];
    const out = organizeLayout(input, { viewport: VIEW });
    for (const p of out) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });

  it('separates a fully stacked pair (no overlap)', () => {
    const input = [box('a', 100, 100), box('b', 100, 100)];
    const out = organizeLayout(input, { viewport: VIEW });
    expect(hasNoOverlaps(input, out)).toBe(true);
  });

  it('separates two modules far apart and packs them inside the viewport', () => {
    // Far-apart pair with a small viewport — both must end up inside
    // viewport.width × viewport.height with at least GAP between them.
    const tinyView: OrganizeViewport = { width: 800, height: 600, originX: 0, originY: 0 };
    const input = [box('a', -2000, -2000, 200, 100), box('b', 5000, 4000, 200, 100)];
    const out = organizeLayout(input, { viewport: tinyView, gap: GAP });
    expect(hasNoOverlaps(input, out)).toBe(true);
    const after = bbox(input, out);
    expect(after.maxX).toBeLessThanOrEqual(tinyView.width);
    expect(after.maxY).toBeLessThanOrEqual(tinyView.height);
    // Per-box bounds at the viewport top-left, GAP from each edge.
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(GAP - 1);
      expect(p.y).toBeGreaterThanOrEqual(GAP - 1);
    }
    // Adjacent boxes within the same row are GAP apart on their facing edges.
    const a = out.find((o) => o.id === 'a')!;
    const b = out.find((o) => o.id === 'b')!;
    if (a.y === b.y) {
      const left = a.x < b.x ? a : b;
      const right = a.x < b.x ? b : a;
      expect(right.x - (left.x + 200)).toBeGreaterThanOrEqual(GAP - 1);
    }
  });

  it('preserves overall left-to-right order along X (single row)', () => {
    // Distinct y values, but small enough that the natural y-sort is left
    // → right keeps the user's left/right read intact.
    const input = [
      box('left', 0, 0),
      box('mid', 50, 0),
      box('right', 100, 0),
    ];
    const out = organizeLayout(input, { viewport: VIEW });
    expect(hasNoOverlaps(input, out)).toBe(true);
    const left = out.find((o) => o.id === 'left')!;
    const mid = out.find((o) => o.id === 'mid')!;
    const right = out.find((o) => o.id === 'right')!;
    expect(left.x).toBeLessThan(mid.x);
    expect(mid.x).toBeLessThan(right.x);
  });

  it('preserves quadrant relative arrangement (TL/TR/BL/BR)', () => {
    // Four modules, one per quadrant. We constrain the viewport width so the
    // algorithm can't collapse all four into a single row — that way the
    // 2x2 grid (top row + bottom row) survives, and quadrant identity is
    // preserved end-to-end.
    const narrow: OrganizeViewport = { width: 600, height: 800, originX: 0, originY: 0 };
    const input = [
      box('tl', 0, 0),
      box('tr', 1000, 0),
      box('bl', 0, 800),
      box('br', 1000, 800),
    ];
    const before = bbox(input, input.map((b) => ({ id: b.id, x: b.x, y: b.y })));
    const beforeMid = {
      x: before.minX + before.w / 2,
      y: before.minY + before.h / 2,
    };
    const beforeQuads = Object.fromEntries(
      input.map((b) => [b.id, quadrant({ x: b.x, y: b.y }, beforeMid)]),
    );
    const out = organizeLayout(input, { viewport: narrow, gap: GAP });
    expect(hasNoOverlaps(input, out)).toBe(true);
    const after = bbox(input, out);
    const afterMid = {
      x: after.minX + after.w / 2,
      y: after.minY + after.h / 2,
    };
    for (const p of out) {
      expect(quadrant(p, afterMid)).toBe(beforeQuads[p.id]);
    }
  });

  it('30 random modules pack inside the viewport with no overlap', () => {
    // Seeded pseudo-random so the test is deterministic.
    let seed = 0xCAFEBABE >>> 0;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xFFFFFFFF;
    };
    const input: Box[] = [];
    for (let i = 0; i < 30; i++) {
      input.push(box(`n${i}`, rand() * 4000 - 2000, rand() * 3000 - 1500, 200, 100));
    }
    // Use a viewport tall enough to fit 6 rows of 100px + 7 gaps. 5 cols of
    // 200px + 6 gaps fit in 1280 width: 1000 + 144 = 1144 ≤ 1280. Height:
    // 6 * 100 + 7 * 24 = 768.
    const wideView: OrganizeViewport = { width: 1280, height: 800, originX: 0, originY: 0 };
    const out = organizeLayout(input, { viewport: wideView, gap: GAP });
    expect(out).toHaveLength(30);
    expect(hasNoOverlaps(input, out)).toBe(true);
    // Every box fully inside the viewport rect.
    for (const b of input) {
      const p = out.find((o) => o.id === b.id)!;
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + b.w).toBeLessThanOrEqual(wideView.width + 1);
      expect(p.y + b.h).toBeLessThanOrEqual(wideView.height + 1);
    }
    // Sanity: the pack actually used multiple rows (not just one giant row).
    const distinctY = new Set(out.map((p) => p.y));
    expect(distinctY.size).toBeGreaterThan(1);
  });

  it('is idempotent: organize(organize(L)) === organize(L)', () => {
    const input = [
      box('a', 0, 0),
      box('b', 300, 50),
      box('c', 600, 100),
      box('d', 100, 400, 240, 180),
      box('e', 800, 350, 120, 240),
    ];
    const first = organizeLayout(input, { viewport: VIEW, gap: GAP });
    // Re-package the input as the new positions for the second pass — same
    // sizes, new x/y. (organize doesn't mutate, so we must rebuild boxes.)
    const second = organizeLayout(
      input.map((b) => {
        const p = first.find((q) => q.id === b.id)!;
        return { ...b, x: p.x, y: p.y };
      }),
      { viewport: VIEW, gap: GAP },
    );
    expect(second).toEqual(first);
  });

  it('handles heterogeneous box sizes (small + large modules together)', () => {
    const input = [
      box('big', 0, 0, 540, 240),
      box('small', 100, 100, 160, 200),
      box('mid', 200, 50, 240, 280),
    ];
    const out = organizeLayout(input, { viewport: VIEW });
    expect(hasNoOverlaps(input, out)).toBe(true);
    // Per-row gap respected: scan horizontally adjacent pairs.
    const sortedByY = [...out].sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 1; i < sortedByY.length; i++) {
      const prev = sortedByY[i - 1];
      const cur = sortedByY[i];
      if (prev.y === cur.y) {
        const prevBox = input.find((b) => b.id === prev.id)!;
        expect(cur.x - (prev.x + prevBox.w)).toBeGreaterThanOrEqual(GAP - 1);
      }
    }
  });

  it('handles a single box (no-op apart from rounding)', () => {
    const input = [box('only', 50, 50)];
    const out = organizeLayout(input);
    expect(out).toEqual([{ id: 'only', x: 50, y: 50 }]);
  });

  it('handles an empty array', () => {
    expect(organizeLayout([])).toEqual([]);
  });

  it('respects a custom gap', () => {
    const input = [box('a', 0, 0, 100, 100), box('b', 0, 0, 100, 100)];
    const out = organizeLayout(input, { gap: 64, viewport: VIEW });
    expect(hasNoOverlaps(input, out)).toBe(true);
    const a = out.find((o) => o.id === 'a')!;
    const b = out.find((o) => o.id === 'b')!;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(100 + 64 - 1);
  });

  it('back-compat: minGap option still controls spacing when provided', () => {
    // Old callers passed `minGap`; our `gap` param is the new name. Both must
    // work since organize.ts has callers in flight on adjacent branches.
    const input = [box('a', 0, 0, 100, 100), box('b', 0, 0, 100, 100)];
    const out = organizeLayout(input, { minGap: 48, viewport: VIEW });
    expect(hasNoOverlaps(input, out)).toBe(true);
    const a = out.find((o) => o.id === 'a')!;
    const b = out.find((o) => o.id === 'b')!;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(100 + 48 - 1);
  });

  it('packs densely (vs the original far-apart layout): bbox area must shrink', () => {
    // The user's complaint: "leaves big gaps". When given a sparse layout the
    // new pass must produce a tighter bbox — no more gaps.
    const input = [
      box('a', 0, 0),
      box('b', 1500, 0),
      box('c', 0, 1500),
      box('d', 1500, 1500),
    ];
    const before = bbox(input, input.map((b) => ({ id: b.id, x: b.x, y: b.y })));
    const out = organizeLayout(input, { viewport: VIEW, gap: GAP });
    const after = bbox(input, out);
    expect(hasNoOverlaps(input, out)).toBe(true);
    expect(after.w * after.h).toBeLessThan(before.w * before.h);
  });

  it('grows the bounding box to fit decluttered nodes (3 coincident → spread)', () => {
    const input = [
      box('a', 0, 0),
      box('b', 0, 0),
      box('c', 0, 0),
    ];
    const before = bbox(input, input.map((b) => ({ id: b.id, x: b.x, y: b.y })));
    const out = organizeLayout(input, { viewport: VIEW });
    const after = bbox(input, out);
    expect(hasNoOverlaps(input, out)).toBe(true);
    // 3 coincident boxes can't fit inside a single-box bbox after declutter.
    expect(after.w * after.h).toBeGreaterThan(before.w * before.h);
  });

  it('wraps to a new row when viewport width is exceeded', () => {
    // 5 modules @ 200px wide + 4 gaps @ 24 = 1096; force wrap by giving a
    // viewport that only fits 3 across (200 * 3 + 4 * 24 = 696).
    const tinyView: OrganizeViewport = { width: 700, height: 1200, originX: 0, originY: 0 };
    const input = [
      box('a', 0, 0),
      box('b', 100, 0),
      box('c', 200, 0),
      box('d', 300, 0),
      box('e', 400, 0),
    ];
    const out = organizeLayout(input, { viewport: tinyView, gap: GAP });
    expect(hasNoOverlaps(input, out)).toBe(true);
    // After wrapping at most 3 modules can share a row; expect ≥ 2 distinct y.
    const distinctY = new Set(out.map((p) => p.y));
    expect(distinctY.size).toBeGreaterThanOrEqual(2);
  });

  it('respects viewport origin (modules placed relative to originX/Y)', () => {
    // Pan the viewport into negative flow-space; organize should place the
    // top-left module near (originX + GAP, originY + GAP).
    const pannedView: OrganizeViewport = {
      width: 1000, height: 800, originX: -500, originY: -300,
    };
    const input = [box('a', 0, 0), box('b', 0, 0)];
    const out = organizeLayout(input, { viewport: pannedView, gap: GAP });
    expect(hasNoOverlaps(input, out)).toBe(true);
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(pannedView.originX! + GAP - 1);
      expect(p.y).toBeGreaterThanOrEqual(pannedView.originY! + GAP - 1);
      expect(p.x).toBeLessThanOrEqual(pannedView.originX! + pannedView.width);
      expect(p.y).toBeLessThanOrEqual(pannedView.originY! + pannedView.height);
    }
  });
});

describe('hasNoOverlaps', () => {
  it('returns true for disjoint boxes', () => {
    const input = [box('a', 0, 0), box('b', 300, 0)];
    expect(hasNoOverlaps(input, input.map((b) => ({ id: b.id, x: b.x, y: b.y })))).toBe(true);
  });

  it('returns false for stacked boxes', () => {
    const input = [box('a', 0, 0), box('b', 50, 50)];
    expect(hasNoOverlaps(input, input.map((b) => ({ id: b.id, x: b.x, y: b.y })))).toBe(false);
  });

  it('treats edge-touching boxes as non-overlapping', () => {
    const input = [box('a', 0, 0, 100, 100), box('b', 100, 0, 100, 100)];
    expect(hasNoOverlaps(input, input.map((b) => ({ id: b.id, x: b.x, y: b.y })))).toBe(true);
  });
});
