// Unit tests for the organize-modules layout pass.
// Pure data, no DOM. Run via vitest in the web workspace.

import { describe, it, expect } from 'vitest';
import { organizeLayout, hasNoOverlaps, type Box } from './organize';

const W = 200;
const H = 100;

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

describe('organizeLayout', () => {
  it('returns input unchanged when there are no overlaps', () => {
    const input = [box('a', 0, 0), box('b', 300, 0), box('c', 0, 200)];
    const out = organizeLayout(input);
    expect(out).toHaveLength(3);
    expect(hasNoOverlaps(input, out)).toBe(true);
    for (const b of input) {
      const p = out.find((o) => o.id === b.id)!;
      expect(p.x).toBe(b.x);
      expect(p.y).toBe(b.y);
    }
  });

  it('separates a fully stacked pair', () => {
    const input = [box('a', 100, 100), box('b', 100, 100)];
    const out = organizeLayout(input);
    expect(hasNoOverlaps(input, out)).toBe(true);
  });

  it('separates a partially overlapping pair along the smaller axis', () => {
    // Heavy X overlap, tiny Y overlap → push along Y (less disruptive).
    const input = [box('a', 0, 0, 200, 100), box('b', 10, 90, 200, 100)];
    const out = organizeLayout(input);
    expect(hasNoOverlaps(input, out)).toBe(true);
    const a = out.find((o) => o.id === 'a')!;
    const b = out.find((o) => o.id === 'b')!;
    expect(Math.abs(a.x)).toBeLessThan(2);
    expect(Math.abs(b.x - 10)).toBeLessThan(2);
  });

  it('grows the bounding box to fit decluttered nodes', () => {
    const input = [
      box('a', 0, 0),
      box('b', 0, 0),
      box('c', 0, 0),
    ];
    const before = bbox(input, input.map((b) => ({ id: b.id, x: b.x, y: b.y })));
    const out = organizeLayout(input);
    const after = bbox(input, out);
    expect(hasNoOverlaps(input, out)).toBe(true);
    // Bbox area must grow — three coincident boxes can no longer all fit
    // inside a single-box bbox after declutter (regardless of axis).
    const beforeArea = before.w * before.h;
    const afterArea = after.w * after.h;
    expect(afterArea).toBeGreaterThan(beforeArea);
  });

  it('preserves overall left-to-right order along X', () => {
    const input = [
      box('left', 0, 0),
      box('mid', 50, 5),
      box('right', 100, 10),
    ];
    const out = organizeLayout(input);
    expect(hasNoOverlaps(input, out)).toBe(true);
    const left = out.find((o) => o.id === 'left')!;
    const mid = out.find((o) => o.id === 'mid')!;
    const right = out.find((o) => o.id === 'right')!;
    expect(left.x).toBeLessThan(mid.x);
    expect(mid.x).toBeLessThan(right.x);
  });

  it('returns positions sorted by id (deterministic)', () => {
    const input = [box('z', 0, 0), box('a', 10, 10), box('m', 20, 20)];
    const out = organizeLayout(input);
    expect(out.map((p) => p.id)).toEqual(['a', 'm', 'z']);
  });

  it('is deterministic across runs given the same input', () => {
    const input = [box('a', 0, 0), box('b', 50, 0), box('c', 100, 0), box('d', 30, 30)];
    const a = organizeLayout(input);
    const b = organizeLayout(input);
    expect(a).toEqual(b);
  });

  it('handles a tight cluster of 5 fully stacked boxes', () => {
    const input = [
      box('n0', 100, 100),
      box('n1', 100, 100),
      box('n2', 100, 100),
      box('n3', 100, 100),
      box('n4', 100, 100),
    ];
    const out = organizeLayout(input);
    expect(hasNoOverlaps(input, out)).toBe(true);
    expect(out).toHaveLength(5);
  });

  it('handles heterogeneous box sizes (small + large modules together)', () => {
    const input = [
      box('big', 0, 0, 540, 240),
      box('small', 100, 100, 160, 200),
      box('mid', 200, 50, 240, 280),
    ];
    const out = organizeLayout(input);
    expect(hasNoOverlaps(input, out)).toBe(true);
  });

  it('handles a single box (no-op)', () => {
    const input = [box('only', 50, 50)];
    const out = organizeLayout(input);
    expect(out).toEqual([{ id: 'only', x: 50, y: 50 }]);
  });

  it('handles an empty array', () => {
    expect(organizeLayout([])).toEqual([]);
  });

  it('respects a custom minGap', () => {
    const input = [box('a', 0, 0, 100, 100), box('b', 0, 0, 100, 100)];
    const out = organizeLayout(input, { minGap: 64 });
    expect(hasNoOverlaps(input, out)).toBe(true);
    const a = out.find((o) => o.id === 'a')!;
    const b = out.find((o) => o.id === 'b')!;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(100 + 64 - 1);
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
