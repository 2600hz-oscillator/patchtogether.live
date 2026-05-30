// packages/web/src/lib/cadillac/collision.test.ts
//
// Unit tests for the pure collision math. Zero DOM / no svelte —
// runs in node via vitest.

import { describe, it, expect } from 'vitest';
import {
  currentX,
  leftmostOtherX,
  hits,
  shouldSelfDestruct,
  type OtherNode,
} from './collision';

describe('currentX', () => {
  it('returns startX at t=spawnedAtMs', () => {
    expect(currentX(1000, 1000, 300, 5000)).toBe(5000);
  });
  it('decreases monotonically with time', () => {
    const startX = 5000;
    const spawnedAtMs = 1000;
    const speed = 300;
    let last = Number.POSITIVE_INFINITY;
    for (let dt = 0; dt < 10000; dt += 100) {
      const x = currentX(spawnedAtMs + dt, spawnedAtMs, speed, startX);
      expect(x).toBeLessThanOrEqual(last);
      last = x;
    }
  });
  it('clamps negative elapsed to 0 (no time-travel)', () => {
    expect(currentX(500, 1000, 300, 5000)).toBe(5000);
  });
  it('matches the documented formula', () => {
    // 1.5 seconds after spawn @ 300px/s → 450px to the left
    expect(currentX(1000 + 1500, 1000, 300, 5000)).toBe(5000 - 450);
  });
});

describe('leftmostOtherX', () => {
  const nodes: OtherNode[] = [
    { id: 'a', position: { x: 100, y: 0 } },
    { id: 'b', position: { x: -50, y: 0 } },
    { id: 'cad', position: { x: -9999, y: 0 } }, // would win if not excluded
    { id: 'c', position: { x: 200, y: 0 } },
  ];

  it('excludes the cadillac itself', () => {
    expect(leftmostOtherX(nodes, 'cad')).toBe(-50);
  });

  it('excludes skipped ids (undeletables / already-deleted)', () => {
    expect(leftmostOtherX(nodes, 'cad', new Set(['b']))).toBe(100);
  });

  it('returns null when no other nodes remain', () => {
    expect(leftmostOtherX([{ id: 'cad', position: { x: 0, y: 0 } }], 'cad')).toBe(null);
  });

  it('returns null when every other node is skipped', () => {
    expect(leftmostOtherX(nodes, 'cad', new Set(['a', 'b', 'c']))).toBe(null);
  });
});

describe('hits (AABB)', () => {
  const car = { x: 0, y: 0, width: 100, height: 50 };

  it('finds overlapping nodes', () => {
    const others: OtherNode[] = [
      { id: 'overlap', position: { x: 50, y: 20 }, width: 80, height: 80 },
      { id: 'far-right', position: { x: 500, y: 0 }, width: 80, height: 80 },
      { id: 'far-down', position: { x: 0, y: 500 }, width: 80, height: 80 },
    ];
    expect(hits(car, others)).toEqual(['overlap']);
  });

  it('treats touching-edge as non-overlap (open intervals)', () => {
    const flush: OtherNode[] = [
      { id: 'flush-right', position: { x: 100, y: 0 }, width: 80, height: 80 },
    ];
    expect(hits(car, flush)).toEqual([]);
  });

  it('skips nodes with no measured size (not yet measured by xyflow)', () => {
    const unmeasured: OtherNode[] = [
      { id: 'no-size', position: { x: 10, y: 10 } },
    ];
    expect(hits(car, unmeasured)).toEqual([]);
  });

  it('returns multiple ids when the car spans several modules', () => {
    const others: OtherNode[] = [
      { id: 'a', position: { x: 10, y: 0 }, width: 20, height: 20 },
      { id: 'b', position: { x: 40, y: 0 }, width: 20, height: 20 },
    ];
    expect(hits(car, others).sort()).toEqual(['a', 'b']);
  });
});

describe('shouldSelfDestruct', () => {
  it('triggers fallback after 8s when no other nodes', () => {
    expect(
      shouldSelfDestruct({
        now: 9001,
        spawnedAtMs: 1000,
        currentCarX: -1000,
        leftmost: null,
      }),
    ).toBe(true);
    expect(
      shouldSelfDestruct({
        now: 8999,
        spawnedAtMs: 1000,
        currentCarX: -1000,
        leftmost: null,
      }),
    ).toBe(false);
  });

  it('triggers 200px past leftmost when nodes exist', () => {
    expect(
      shouldSelfDestruct({
        now: 5000,
        spawnedAtMs: 0,
        currentCarX: -201,
        leftmost: 0,
      }),
    ).toBe(true);
    expect(
      shouldSelfDestruct({
        now: 5000,
        spawnedAtMs: 0,
        currentCarX: -199,
        leftmost: 0,
      }),
    ).toBe(false);
  });

  it('honors custom pastPx', () => {
    expect(
      shouldSelfDestruct({
        now: 5000,
        spawnedAtMs: 0,
        currentCarX: -50,
        leftmost: 0,
        pastPx: 50,
      }),
    ).toBe(true);
  });

  it('honors custom fallbackMs', () => {
    expect(
      shouldSelfDestruct({
        now: 4001,
        spawnedAtMs: 0,
        currentCarX: 0,
        leftmost: null,
        fallbackMs: 4000,
      }),
    ).toBe(true);
  });
});
