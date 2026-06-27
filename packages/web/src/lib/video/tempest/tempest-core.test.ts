// packages/web/src/lib/video/tempest/tempest-core.test.ts
//
// Pure unit tests for the TEMPEST geometry core (P0) — GL-free, deterministic.

import { describe, expect, it } from 'vitest';
import {
  TUBE_SHAPES,
  DEFAULT_LANES,
  PIT_SCALE,
  easeOutQuad,
  wrapLane,
  cvToLane,
  shortestLaneDelta,
  rimVertices,
  rimAt,
  projectToScreen,
  bandsToRadii,
} from './tempest-core';

const len = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);

describe('easeOutQuad', () => {
  it('pins the endpoints and clamps out-of-range', () => {
    expect(easeOutQuad(0)).toBe(0);
    expect(easeOutQuad(1)).toBe(1);
    expect(easeOutQuad(-5)).toBe(0);
    expect(easeOutQuad(5)).toBe(1);
  });
  it('accelerates toward the rim (out-eased)', () => {
    expect(easeOutQuad(0.5)).toBeCloseTo(0.75, 6); // 1-(0.5)^2
    expect(easeOutQuad(0.5)).toBeGreaterThan(0.5);
  });
});

describe('wrapLane / cvToLane', () => {
  it('wraps into [0, lanes)', () => {
    expect(wrapLane(0, 16)).toBe(0);
    expect(wrapLane(16, 16)).toBe(0);
    expect(wrapLane(17, 16)).toBe(1);
    expect(wrapLane(-1, 16)).toBe(15);
  });
  it('maps CV 0..1 around the loop with wrap (joystick → rim)', () => {
    expect(cvToLane(0, 16)).toBe(0);
    expect(cvToLane(0.5, 16)).toBe(8);
    expect(cvToLane(1, 16)).toBe(0); // full sweep wraps
    expect(cvToLane(-0.0625, 16)).toBe(15); // -1 lane wraps to last
  });
});

describe('shortestLaneDelta', () => {
  it('takes the short way around the loop (signed)', () => {
    expect(shortestLaneDelta(0, 1, 16)).toBe(1);
    expect(shortestLaneDelta(0, 15, 16)).toBe(-1); // backward is shorter
    expect(shortestLaneDelta(15, 0, 16)).toBe(1); // forward wraps
    expect(shortestLaneDelta(0, 8, 16)).toBe(8); // half-way: +8 (tie → +)
  });
});

describe('rimVertices', () => {
  it.each(TUBE_SHAPES)('%s returns `lanes` vertices within the unit bounding box', (shape) => {
    const rim = rimVertices(shape, DEFAULT_LANES);
    expect(rim).toHaveLength(DEFAULT_LANES);
    // Extent invariant is the BOUNDING BOX (|x|,|y| ≤ 1): the square's corners sit
    // at radial distance √2, so a radial-length check would be wrong for it.
    for (const v of rim) {
      expect(Math.abs(v.x)).toBeLessThanOrEqual(1.0000001);
      expect(Math.abs(v.y)).toBeLessThanOrEqual(1.0000001);
      expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
    }
  });
  it('circle vertices are all unit-radius', () => {
    for (const v of rimVertices('circle', 12)) expect(len(v)).toBeCloseTo(1, 6);
  });
  it('per-lane radii scale each vertex (the audio-breathing hook)', () => {
    const lanes = 8;
    const radii = Array.from({ length: lanes }, (_, i) => 1 + i * 0.1);
    const plain = rimVertices('circle', lanes);
    const breathed = rimVertices('circle', lanes, radii);
    for (let i = 0; i < lanes; i++) {
      expect(len(breathed[i]!)).toBeCloseTo(len(plain[i]!) * radii[i]!, 6);
    }
  });
  it('ignores a radii array of the wrong length', () => {
    const r = rimVertices('circle', 8, [1, 2, 3]);
    for (const v of r) expect(len(v)).toBeCloseTo(1, 6);
  });
});

describe('rimAt', () => {
  it('returns exact vertices at integer lanes and interpolates between', () => {
    const rim = rimVertices('circle', 4);
    expect(rimAt(rim, 0)).toEqual(rim[0]);
    expect(rimAt(rim, 1)).toEqual(rim[1]);
    const mid = rimAt(rim, 0.5);
    expect(mid.x).toBeCloseTo((rim[0]!.x + rim[1]!.x) / 2, 6);
    expect(mid.y).toBeCloseTo((rim[0]!.y + rim[1]!.y) / 2, 6);
  });
  it('wraps the continuous coordinate', () => {
    const rim = rimVertices('circle', 4);
    expect(rimAt(rim, 4)).toEqual(rimAt(rim, 0));
  });
});

describe('projectToScreen', () => {
  it('z=1 lands on the rim; z=0 lands at the pit (PIT_SCALE of rim)', () => {
    const rim = rimVertices('circle', 16);
    const atRim = projectToScreen(rim, 3, 1);
    const atPit = projectToScreen(rim, 3, 0);
    expect(len(atRim)).toBeCloseTo(1, 6);
    expect(len(atPit)).toBeCloseTo(PIT_SCALE, 6);
  });
  it('depth is monotonic pit→rim (enemies grow as they approach)', () => {
    const rim = rimVertices('circle', 16);
    const a = len(projectToScreen(rim, 0, 0.25));
    const b = len(projectToScreen(rim, 0, 0.5));
    const c = len(projectToScreen(rim, 0, 0.75));
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});

describe('bandsToRadii', () => {
  it('one band per lane: radius = base + band*depth', () => {
    const r = bandsToRadii([0, 1, 0.5, 0], 4, 1, 0.4);
    expect(r).toEqual([1, 1.4, 1.2, 1]);
  });
  it('resamples mismatched band counts by nearest index', () => {
    const r = bandsToRadii([1], 4, 1, 1); // single band → all lanes use it
    expect(r).toEqual([2, 2, 2, 2]);
  });
  it('empty bands → resting radius', () => {
    expect(bandsToRadii([], 3, 1, 0.4)).toEqual([1, 1, 1]);
  });
  it('clamps band magnitudes to [0,1]', () => {
    expect(bandsToRadii([5, -5], 2, 1, 0.5)).toEqual([1.5, 1]);
  });
});
