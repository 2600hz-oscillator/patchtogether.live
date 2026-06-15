// packages/web/src/lib/ui/rack-grid.test.ts
//
// Pure snap-math for the virtual-rack grid. Covers: exact-on-line, round-down,
// round-up, the half-boundary, negatives, a custom unit, and the {x,y} wrapper
// (incl. the "1u lands on a third of a 3u slot" behaviour the Phase-2 spec
// relies on falling out for free).

import { describe, it, expect } from 'vitest';
import {
  snapToGrid,
  snapPositionToGrid,
  RACK_UNIT,
  HP_UNIT,
  HP_PER_U,
  rectsOverlap,
  findFreeRackSlot,
  type RackRect,
} from './rack-grid';

describe('snapToGrid', () => {
  it('the rack unit is 180px (mirrors --rack-unit)', () => {
    expect(RACK_UNIT).toBe(180);
  });

  it('leaves a value already on a grid line untouched', () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(180)).toBe(180);
    expect(snapToGrid(540)).toBe(540); // a 3u slot boundary
    expect(snapToGrid(1800)).toBe(1800);
  });

  it('rounds DOWN when nearer the lower grid line', () => {
    expect(snapToGrid(80)).toBe(0);
    expect(snapToGrid(260)).toBe(180); // 260 is 80 past 180 → nearest is 180
    expect(snapToGrid(620)).toBe(540);
  });

  it('rounds UP when nearer the higher grid line', () => {
    expect(snapToGrid(100)).toBe(180);
    expect(snapToGrid(280)).toBe(360); // 280 is 100 past 180 → nearest is 360
    expect(snapToGrid(460)).toBe(540);
  });

  it('rounds half UP at the exact midpoint (90px)', () => {
    expect(snapToGrid(90)).toBe(180);
    expect(snapToGrid(270)).toBe(360); // exactly between 180 and 360
  });

  it('snaps negatives symmetrically (no -0 leakage)', () => {
    expect(snapToGrid(-180)).toBe(-180);
    expect(snapToGrid(-100)).toBe(-180);
    expect(snapToGrid(-80)).toBe(0);
    // -0 must read as a clean 0
    expect(Object.is(snapToGrid(-80), 0)).toBe(true);
    // -90/180 = -0.5; Math.round(-0.5) === -0 (rounds toward +Inf at .5) → 0
    expect(snapToGrid(-90)).toBe(0);
    expect(Object.is(snapToGrid(-90), 0)).toBe(true);
    expect(snapToGrid(-100)).toBe(-180); // -100/180 ≈ -0.56 → -1 → -180
  });

  it('honours a custom unit', () => {
    expect(snapToGrid(46, 50)).toBe(50);
    expect(snapToGrid(24, 50)).toBe(0);
  });
});

describe('HP pitch', () => {
  it('1u = 8hp → hp pitch is 22.5px', () => {
    expect(HP_PER_U).toBe(8);
    expect(HP_UNIT).toBe(22.5);
  });
});

describe('snapPositionToGrid (anisotropic: X→hp, Y→u)', () => {
  it('snaps X to the HP pitch (22.5px) and Y to the U row (180px)', () => {
    // X: 100/22.5 = 4.44 → 4 hp → 90 ; Y: 260 → 180
    expect(snapPositionToGrid({ x: 100, y: 260 })).toEqual({ x: 90, y: 180 });
    expect(snapPositionToGrid({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    // X: 50/22.5 = 2.22 → 2 hp → 45 ; Y: 80 → 0
    expect(snapPositionToGrid({ x: 50, y: 80 })).toEqual({ x: 45, y: 0 });
    // X already on an hp line stays put
    expect(snapPositionToGrid({ x: 67.5, y: 0 }).x).toBe(67.5); // 3hp
  });

  it('gives 8 distinct horizontal lock positions per 1u of width', () => {
    const xs = new Set<number>();
    for (let i = 0; i < HP_PER_U; i++) xs.add(snapPositionToGrid({ x: i * HP_UNIT, y: 0 }).x);
    expect(xs.size).toBe(HP_PER_U); // 0, 22.5, 45, … 157.5 all distinct
  });

  it('a 1u module snaps to a third-of-3u-slot Y for free (spec §3)', () => {
    // Y still locks to the 180px U row — a 1u card lands on a third of a 3u slot.
    expect(snapPositionToGrid({ x: 0, y: 540 + 30 }).y).toBe(540); // top third
    expect(snapPositionToGrid({ x: 0, y: 540 + 200 }).y).toBe(720); // middle third
    expect(snapPositionToGrid({ x: 0, y: 540 + 380 }).y).toBe(900); // bottom third
  });
});

describe('rectsOverlap', () => {
  const R = (x: number, y: number, w = 180, h = 180): RackRect => ({ x, y, w, h });
  it('true when the rects intersect', () => {
    expect(rectsOverlap(R(0, 0), R(90, 90))).toBe(true);
  });
  it('false when they only touch edges (adjacent slots are NOT overlapping)', () => {
    expect(rectsOverlap(R(0, 0), R(180, 0))).toBe(false);
    expect(rectsOverlap(R(0, 0), R(0, 180))).toBe(false);
  });
  it('false when fully disjoint', () => {
    expect(rectsOverlap(R(0, 0), R(360, 0))).toBe(false);
  });
});

describe('findFreeRackSlot (lock never lands a card on top of another)', () => {
  const R = (x: number, y: number, w = 180, h = 180): RackRect => ({ x, y, w, h });
  const fits = (r: { x: number; y: number }, size: { w: number; h: number }, others: RackRect[]) =>
    !others.some((o) => rectsOverlap({ ...r, ...size }, o));

  it('returns the snapped position unchanged when nothing is there', () => {
    expect(findFreeRackSlot({ x: 360, y: 0 }, { w: 180, h: 180 }, [])).toEqual({ x: 360, y: 0 });
    // an existing card elsewhere doesn't block a clear slot
    expect(findFreeRackSlot({ x: 360, y: 0 }, { w: 180, h: 180 }, [R(0, 0)])).toEqual({ x: 360, y: 0 });
  });

  it('nudges to a free slot when the snapped slot is taken', () => {
    const others = [R(0, 0)];
    const r = findFreeRackSlot({ x: 0, y: 0 }, { w: 180, h: 180 }, others);
    expect(fits(r, { w: 180, h: 180 }, others)).toBe(true);
    // A 180-wide card beside a 180-wide obstacle: nearest free is one full
    // module to the side (or one U down) — all 180px away.
    expect(Math.abs(r.x) + Math.abs(r.y)).toBe(180);
  });

  it('slides HORIZONTALLY by HP (not a whole U) into the nearest gap', () => {
    // A 2hp (45px) card clashing with a 2hp obstacle slides 45px = 2hp sideways,
    // NOT a 180px row jump — horizontal moves are cheap (anisotropic search).
    const obstacle = [R(0, 0, 45, 180)];
    const r = findFreeRackSlot({ x: 0, y: 0 }, { w: 45, h: 180 }, obstacle);
    expect(fits(r, { w: 45, h: 180 }, obstacle)).toBe(true);
    expect(r).toEqual({ x: -45, y: 0 }); // 2hp left, same row — least relocation
  });

  it('reaches past a fully-surrounded slot to the nearest free one', () => {
    // Occupy the snapped slot + all 4 orthogonal neighbours → must go to a
    // diagonal (ring-1) which is still collision-free.
    const others = [R(0, 0), R(180, 0), R(-180, 0), R(0, 180), R(0, -180)];
    const r = findFreeRackSlot({ x: 0, y: 0 }, { w: 180, h: 180 }, others);
    expect(fits(r, { w: 180, h: 180 }, others)).toBe(true);
  });

  it('accounts for the LOCKING card’s own multi-tile footprint', () => {
    // A 2hp×1u card (360×180) at {0,0}: a neighbour exactly abutting at x=360
    // only TOUCHES → no move needed.
    expect(findFreeRackSlot({ x: 0, y: 0 }, { w: 360, h: 180 }, [R(360, 0)])).toEqual({ x: 0, y: 0 });
    // …but a neighbour at x=180 is UNDER the 360-wide card → it must relocate.
    const r = findFreeRackSlot({ x: 0, y: 0 }, { w: 360, h: 180 }, [R(180, 0)]);
    expect(fits(r, { w: 360, h: 180 }, [R(180, 0)])).toBe(true);
  });
});
