// packages/web/src/lib/video/modules/circles.test.ts
//
// Unit coverage for CIRCLES — the def/port/param shape + the entire stateful
// particle sim (seeded spawn, rate-clock cadence capped at 1/500ms,
// center-bounce reflection, per-circle d/v/spd latching, max-circle cull) +
// the per-output derivation math (overlap / contour / combine-hue / mapped).
// All WebGL-free: the sim + derivation live in circles-sim.ts.

import { describe, it, expect } from 'vitest';
import { circlesDef, CIRCLES_GATE_PORT_ID, CIRCLES_GATE_PARAM_ID } from './circles';
import {
  CirclesSim,
  CIRCLES_FIELD,
  D_MIN,
  D_MAX,
  SPD_MAX,
  MAX_CIRCLES,
  RATE_MIN_INTERVAL_MS,
  mapDiameter,
  mapAngle,
  mapSpeed,
  mapRateIntervalMs,
  clamp01,
  overlapCountAt,
  overlapValueAt,
  contourValueAt,
  ringWidth,
  combineHueAt,
  combineRgbAt,
  mappedMaskAt,
  hsvToRgb,
  type Circle,
} from './circles-sim';

// ---------------------------------------------------------------------------
// Def / port / param shape.
// ---------------------------------------------------------------------------

describe('circlesDef — shape', () => {
  it('is a video-domain source with the lowercase label', () => {
    expect(circlesDef.type).toBe('circles');
    expect(circlesDef.domain).toBe('video');
    expect(circlesDef.label).toBe('circles');
    expect(circlesDef.category).toBe('sources');
  });

  it('declares gate / d / v / spd / video inputs', () => {
    const byId = Object.fromEntries(circlesDef.inputs.map((p) => [p.id, p]));
    expect(byId[CIRCLES_GATE_PORT_ID].type).toBe('gate');
    expect(byId[CIRCLES_GATE_PORT_ID].paramTarget).toBe(CIRCLES_GATE_PARAM_ID);
    // Per-param CV ports: id == param id (the CV-bridge routes onto setParam).
    for (const id of ['d', 'v', 'spd']) {
      expect(byId[id].type).toBe('cv');
      expect(byId[id].paramTarget).toBe(id);
    }
    expect(byId['video'].type).toBe('video');
  });

  it('has NO cv input for rate (knob only)', () => {
    expect(circlesDef.inputs.find((p) => p.id === 'rate')).toBeUndefined();
  });

  it('declares the four outputs with the right cable types', () => {
    const byId = Object.fromEntries(circlesDef.outputs.map((p) => [p.id, p]));
    expect(byId['overlap'].type).toBe('mono-video');
    expect(byId['contour'].type).toBe('mono-video');
    expect(byId['combine'].type).toBe('video');
    expect(byId['mapped'].type).toBe('video');
  });

  it('exposes d / v / spd / rate knobs (+ a hidden synthetic gate param)', () => {
    const ids = circlesDef.params.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['d', 'v', 'spd', 'rate', CIRCLES_GATE_PARAM_ID]));
    for (const id of ['d', 'v', 'spd', 'rate']) {
      const p = circlesDef.params.find((x) => x.id === id)!;
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Param mapping ranges.
// ---------------------------------------------------------------------------

describe('param mapping ranges', () => {
  it('d 0..1 → 5..90 px', () => {
    expect(mapDiameter(0)).toBe(D_MIN);
    expect(mapDiameter(1)).toBe(D_MAX);
    expect(mapDiameter(0.5)).toBeCloseTo((D_MIN + D_MAX) / 2);
  });

  it('v 0..1 → 0..2π (every angle reachable)', () => {
    expect(mapAngle(0)).toBe(0);
    expect(mapAngle(1)).toBeCloseTo(Math.PI * 2);
    expect(mapAngle(0.25)).toBeCloseTo(Math.PI / 2);
  });

  it('spd 0..1 → 0..300 px/s', () => {
    expect(mapSpeed(0)).toBe(0);
    expect(mapSpeed(1)).toBe(SPD_MAX);
  });

  it('clamps out-of-range CV', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.7)).toBe(1);
    expect(mapDiameter(2)).toBe(D_MAX);
    expect(mapSpeed(-1)).toBe(0);
  });

  it('rate=0 disengages the clock; rate>0 engages, capped at 1/500ms', () => {
    expect(mapRateIntervalMs(0)).toBeNull();
    const slow = mapRateIntervalMs(0.1)!;
    const fast = mapRateIntervalMs(1)!;
    expect(fast).toBe(RATE_MIN_INTERVAL_MS); // 500ms cap at max
    expect(slow).toBeGreaterThan(fast);      // lower rate = slower
    // Interval can never drop below the cap regardless of input.
    expect(mapRateIntervalMs(1)!).toBeGreaterThanOrEqual(RATE_MIN_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// Spawn — seeded, latched, random position.
// ---------------------------------------------------------------------------

describe('CirclesSim — spawn', () => {
  it('gate spawn adds one circle at a position inside the field', () => {
    const sim = new CirclesSim(123);
    sim.setParams({ d: 0.5, v: 0, spd: 0.5, rate: 0 });
    expect(sim.count).toBe(0);
    sim.spawnFromGate();
    expect(sim.count).toBe(1);
    const c = sim.circles[0]!;
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x).toBeLessThanOrEqual(CIRCLES_FIELD);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeLessThanOrEqual(CIRCLES_FIELD);
  });

  it('spawn position is RANDOM but SEEDED (same seed → identical sequence)', () => {
    const a = new CirclesSim(0xABCDEF);
    const b = new CirclesSim(0xABCDEF);
    a.setParams({ d: 0.5, v: 0, spd: 0, rate: 0 });
    b.setParams({ d: 0.5, v: 0, spd: 0, rate: 0 });
    for (let i = 0; i < 5; i++) { a.spawn(); b.spawn(); }
    expect(a.circles.map((c) => [c.x, c.y])).toEqual(b.circles.map((c) => [c.x, c.y]));
    // Different seed → different positions (overwhelmingly likely).
    const d = new CirclesSim(0x999999);
    d.setParams({ d: 0.5, v: 0, spd: 0, rate: 0 });
    d.spawn();
    expect([d.circles[0]!.x, d.circles[0]!.y]).not.toEqual([a.circles[0]!.x, a.circles[0]!.y]);
  });

  it('does NOT use Math.random (seeded → reproducible even if Math.random is stubbed)', () => {
    const orig = Math.random;
    Math.random = () => { throw new Error('Math.random must not be called'); };
    try {
      const sim = new CirclesSim(42);
      sim.setParams({ d: 0.5, v: 0.5, spd: 0.5, rate: 1 });
      sim.spawn();
      sim.step(600);
      expect(sim.count).toBeGreaterThanOrEqual(1);
    } finally {
      Math.random = orig;
    }
  });

  it('latches d/v/spd at spawn — later param changes affect only NEW circles', () => {
    const sim = new CirclesSim(7);
    sim.setParams({ d: 0, v: 0, spd: 1, rate: 0 }); // d=5px, spd=300, angle 0 (+x)
    sim.spawn();
    const first = sim.circles[0]!;
    expect(first.diameter).toBe(D_MIN);
    expect(first.vx).toBeCloseTo(SPD_MAX);
    expect(first.vy).toBeCloseTo(0);

    // Change every param, spawn again.
    sim.setParams({ d: 1, v: 0.25, spd: 0.5, rate: 0 }); // d=90, angle 90° (+y)
    sim.spawn();
    const second = sim.circles[1]!;
    expect(second.diameter).toBe(D_MAX);
    expect(second.vx).toBeCloseTo(0, 5);
    expect(second.vy).toBeCloseTo(SPD_MAX * 0.5);

    // The FIRST circle is unchanged by the param change.
    expect(first.diameter).toBe(D_MIN);
    expect(first.vx).toBeCloseTo(SPD_MAX);
  });

  it('spd=0 spawns a STATIC circle (zero velocity)', () => {
    const sim = new CirclesSim(1);
    sim.setParams({ d: 0.5, v: 0.7, spd: 0, rate: 0 });
    sim.spawn();
    const c = sim.circles[0]!;
    // (cos/sin × 0 can produce a signed -0; magnitude is what matters — the
    // circle is static.)
    expect(Math.abs(c.vx)).toBe(0);
    expect(Math.abs(c.vy)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Internal rate clock cadence.
// ---------------------------------------------------------------------------

describe('CirclesSim — internal rate clock', () => {
  it('rate=0 spawns NOTHING (gate-only)', () => {
    const sim = new CirclesSim(1);
    sim.setParams({ d: 0.5, v: 0, spd: 0, rate: 0 });
    let total = 0;
    for (let i = 0; i < 200; i++) total += sim.step(16); // ~3.2s
    expect(total).toBe(0);
    expect(sim.count).toBe(0);
  });

  it('rate=1 spawns at the 1/500ms cap — ~2 circles per second', () => {
    const sim = new CirclesSim(1);
    sim.setParams({ d: 0.5, v: 0, spd: 0, rate: 1 });
    let total = 0;
    // Advance 2000ms in 16ms ticks.
    for (let i = 0; i < 125; i++) total += sim.step(16);
    // 2000ms / 500ms = 4 spawns (±1 for accumulator phase).
    expect(total).toBeGreaterThanOrEqual(3);
    expect(total).toBeLessThanOrEqual(5);
  });

  it('never spawns faster than 1 per 500ms even with a single huge dt', () => {
    const sim = new CirclesSim(1);
    sim.setParams({ d: 0.5, v: 0, spd: 0, rate: 1 });
    // One 10-second tick: would be 20 spawns at the cap, but the backlog
    // guard prevents an unbounded dump.
    const n = sim.step(10000);
    // Guard caps the burst (≤ 8), so this is bounded, not 20.
    expect(n).toBeLessThanOrEqual(8);
  });

  it('lower rate = fewer spawns over the same window', () => {
    const fast = new CirclesSim(1);
    const slow = new CirclesSim(1);
    fast.setParams({ d: 0.5, v: 0, spd: 0, rate: 1 });
    slow.setParams({ d: 0.5, v: 0, spd: 0, rate: 0.2 });
    let nf = 0, ns = 0;
    for (let i = 0; i < 200; i++) { nf += fast.step(16); ns += slow.step(16); }
    expect(nf).toBeGreaterThan(ns);
  });
});

// ---------------------------------------------------------------------------
// Integration + center-bounce.
// ---------------------------------------------------------------------------

describe('CirclesSim — motion + center-bounce', () => {
  it('a moving circle drifts in its velocity direction', () => {
    const sim = new CirclesSim(1);
    sim.setParams({ d: 0.5, v: 0, spd: 1, rate: 0 }); // +x at 300 px/s
    sim.spawn();
    const c = sim.circles[0]!;
    c.x = 100; c.y = 100;
    sim.step(100); // 0.1s → +30 px in x
    expect(c.x).toBeCloseTo(130, 0);
    expect(c.y).toBeCloseTo(100, 0);
  });

  it('reflects velocity when the CENTER hits a wall (no radius collision math)', () => {
    const sim = new CirclesSim(1);
    sim.setParams({ d: 1, v: 0, spd: 1, rate: 0 }); // +x, big diameter
    sim.spawn();
    const c = sim.circles[0]!;
    c.x = CIRCLES_FIELD - 5; c.y = 500; c.vx = SPD_MAX; c.vy = 0;
    sim.step(100); // would overshoot past the right wall
    // Center clamped to the wall + velocity reflected.
    expect(c.x).toBe(CIRCLES_FIELD);
    expect(c.vx).toBeLessThan(0);
    // Next step moves back inward.
    const before = c.x;
    sim.step(50);
    expect(c.x).toBeLessThan(before);
  });

  it('center stays within [0, FIELD] across many bounces', () => {
    const sim = new CirclesSim(99);
    sim.setParams({ d: 0.8, v: 0.13, spd: 1, rate: 0 });
    for (let i = 0; i < 6; i++) sim.spawn();
    for (let i = 0; i < 400; i++) sim.step(16);
    for (const c of sim.circles) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(CIRCLES_FIELD);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(CIRCLES_FIELD);
    }
  });
});

// ---------------------------------------------------------------------------
// Max-circle cap / cull-oldest.
// ---------------------------------------------------------------------------

describe('CirclesSim — max-circle cull', () => {
  it('never exceeds MAX_CIRCLES; culls the OLDEST first', () => {
    const sim = new CirclesSim(5);
    sim.setParams({ d: 0.5, v: 0, spd: 0, rate: 0 });
    // Spawn well beyond the cap, tagging each circle's spawn order via x.
    for (let i = 0; i < MAX_CIRCLES + 50; i++) {
      const c = sim.spawn();
      c.x = i; // overwrite position with an index tag
    }
    expect(sim.count).toBe(MAX_CIRCLES);
    expect(sim.cullCount).toBe(50);
    // The oldest 50 (indices 0..49) were culled; the survivors start at 50.
    expect(sim.circles[0]!.x).toBe(50);
    expect(sim.circles[sim.count - 1]!.x).toBe(MAX_CIRCLES + 49);
  });
});

// ---------------------------------------------------------------------------
// Output derivation — overlap / contour / combine / mapped.
// ---------------------------------------------------------------------------

function disc(x: number, y: number, diameter: number): Circle {
  return { x, y, vx: 0, vy: 0, diameter };
}

describe('output derivation', () => {
  it('overlapCount counts every disc covering the point', () => {
    const circles = [disc(100, 100, 40), disc(110, 100, 40), disc(800, 800, 40)];
    // (105,100) is inside the first two discs (r=20 each), not the third.
    expect(overlapCountAt(circles, 105, 100)).toBe(2);
    expect(overlapCountAt(circles, 800, 800)).toBe(1);
    expect(overlapCountAt(circles, 500, 500)).toBe(0);
  });

  it('overlap output = white where ≥1 circle covers, black elsewhere', () => {
    const circles = [disc(100, 100, 40)];
    expect(overlapValueAt(circles, 100, 100)).toBe(1);
    expect(overlapValueAt(circles, 500, 500)).toBe(0);
  });

  it('contour ring width = 10% of diameter, min 2px', () => {
    expect(ringWidth(100)).toBe(10);
    expect(ringWidth(10)).toBe(2);   // 10% = 1 → clamped to 2
    expect(ringWidth(5)).toBe(2);
  });

  it('contour = on the ring band only (outline, not fill)', () => {
    const circles = [disc(500, 500, 200)]; // r=100, lw=20 → band [80,100]
    // Center is INSIDE the disc but OUTSIDE the ring band → not contour.
    expect(contourValueAt(circles, 500, 500)).toBe(0);
    // A point ~90px from center is inside the band.
    expect(contourValueAt(circles, 500 + 90, 500)).toBe(1);
    // A point outside the disc → not contour.
    expect(contourValueAt(circles, 500 + 150, 500)).toBe(0);
  });

  it('combine hue ramps by count: 1 = first hue, then cycles', () => {
    expect(combineHueAt(0)).toBe(0);
    expect(combineHueAt(1)).toBe(0);
    // count 2 advances the hue; consecutive counts are distinct.
    expect(combineHueAt(2)).not.toBe(combineHueAt(1));
    expect(combineHueAt(3)).not.toBe(combineHueAt(2));
  });

  it('combine RGB is black at count 0, brighter as circles stack', () => {
    const one = [disc(100, 100, 40)];
    const two = [disc(100, 100, 40), disc(100, 100, 40)];
    expect(combineRgbAt(one, 500, 500)).toEqual([0, 0, 0]); // uncovered → black
    const c1 = combineRgbAt(one, 100, 100);
    const c2 = combineRgbAt(two, 100, 100);
    const lum = ([r, g, b]: number[]) => r! + g! + b!;
    expect(lum(c1)).toBeGreaterThan(0);
    // Deeper stack → brighter (higher value channel sum), distinct from 1.
    expect(c2).not.toEqual(c1);
  });

  it('hsvToRgb is sane at the cardinal hues', () => {
    expect(hsvToRgb(0, 1, 1)).toEqual([1, 0, 0]);       // red
    const green = hsvToRgb(1 / 3, 1, 1);
    expect(green[1]).toBeCloseTo(1);                     // green dominant
    const blue = hsvToRgb(2 / 3, 1, 1);
    expect(blue[2]).toBeCloseTo(1);                      // blue dominant
  });

  it('mapped mask = 1 only where ≥2 circles overlap', () => {
    const circles = [disc(100, 100, 40), disc(110, 100, 40)];
    expect(mappedMaskAt(circles, 105, 100)).toBe(1); // 2 overlap
    expect(mappedMaskAt(circles, 88, 100)).toBe(0);  // only 1 disc (well left)
    expect(mappedMaskAt(circles, 500, 500)).toBe(0); // none
  });
});
