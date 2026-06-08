// packages/web/src/lib/video/modules/circles.test.ts
//
// Unit coverage for CIRCLES — the def/port/param shape + the entire stateful
// particle sim (seeded spawn, rate-clock cadence capped at 1/500ms,
// center-bounce reflection, per-circle d/v/spd latching, max-circle cull) +
// the per-output derivation math (overlap / contour / combine-hue / mapped).
// All WebGL-free: the sim + derivation live in circles-sim.ts.

import { describe, it, expect } from 'vitest';
import {
  circlesDef,
  CIRCLES_GATE_PORT_ID,
  CIRCLES_GATE_PARAM_ID,
  CIRCLES_COLLIDE_PORT_ID,
  CIRCLES_COLLIDE_PARAM_ID,
} from './circles';
import type { VideoEngineContext, VideoFrameContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
import {
  CirclesSim,
  CIRCLES_FIELD,
  D_MIN,
  D_MAX,
  SPD_MAX,
  DECAY_MAX_S,
  MAX_CIRCLES,
  RATE_MIN_INTERVAL_MS,
  mapDiameter,
  mapAngle,
  mapSpeed,
  mapDecay,
  mapRateIntervalMs,
  alphaFor,
  clamp01,
  overlapCountAt,
  overlapAlphaAt,
  overlapValueAt,
  contourValueAt,
  ringWidth,
  combineHueAt,
  combineRgbAt,
  mappedMaskAt,
  hsvToRgb,
  circlesCollide,
  resolveElasticPair,
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

  it('declares gate / collide / d / v / spd / decay / video inputs', () => {
    const byId = Object.fromEntries(circlesDef.inputs.map((p) => [p.id, p]));
    expect(byId[CIRCLES_GATE_PORT_ID].type).toBe('gate');
    expect(byId[CIRCLES_GATE_PORT_ID].paramTarget).toBe(CIRCLES_GATE_PARAM_ID);
    // The COLLIDE gate is a second gate input routed to a separate synthetic param.
    expect(byId[CIRCLES_COLLIDE_PORT_ID].type).toBe('gate');
    expect(byId[CIRCLES_COLLIDE_PORT_ID].paramTarget).toBe(CIRCLES_COLLIDE_PARAM_ID);
    // Per-param CV ports: id == param id (the CV-bridge routes onto setParam).
    for (const id of ['d', 'v', 'spd', 'decay']) {
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

  it('exposes d / v / spd / decay / rate knobs (+ hidden synthetic gate + collide params)', () => {
    const ids = circlesDef.params.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(['d', 'v', 'spd', 'decay', 'rate', CIRCLES_GATE_PARAM_ID, CIRCLES_COLLIDE_PARAM_ID]),
    );
    for (const id of ['d', 'v', 'spd', 'decay', 'rate']) {
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
  it('d 0..1 → 5..270 px (MAX bumped 90 → 270, 3×; MIN unchanged)', () => {
    expect(D_MIN).toBe(5);
    expect(D_MAX).toBe(270);
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

  it('decay 0..1 → 0..10 s (0 = persist)', () => {
    expect(DECAY_MAX_S).toBe(10);
    expect(mapDecay(0)).toBe(0);
    expect(mapDecay(1)).toBe(DECAY_MAX_S);
    expect(mapDecay(0.5)).toBeCloseTo(5);
    expect(mapDecay(-1)).toBe(0); // clamped
    expect(mapDecay(2)).toBe(DECAY_MAX_S); // clamped
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

  it('latches d/v/spd/decay at spawn — later param changes affect only NEW circles', () => {
    const sim = new CirclesSim(7);
    sim.setParams({ d: 0, v: 0, spd: 1, decay: 0, rate: 0 }); // d=5px, spd=300, angle 0 (+x), persist
    sim.spawn();
    const first = sim.circles[0]!;
    expect(first.diameter).toBe(D_MIN);
    expect(first.vx).toBeCloseTo(SPD_MAX);
    expect(first.vy).toBeCloseTo(0);
    expect(first.decayS).toBe(0);

    // Change every param, spawn again.
    sim.setParams({ d: 1, v: 0.25, spd: 0.5, decay: 0.5, rate: 0 }); // d=270, angle 90° (+y), 5s decay
    sim.spawn();
    const second = sim.circles[1]!;
    expect(second.diameter).toBe(D_MAX);
    expect(second.vx).toBeCloseTo(0, 5);
    expect(second.vy).toBeCloseTo(SPD_MAX * 0.5);
    expect(second.decayS).toBeCloseTo(5);

    // The FIRST circle is unchanged by the param change.
    expect(first.diameter).toBe(D_MIN);
    expect(first.vx).toBeCloseTo(SPD_MAX);
    expect(first.decayS).toBe(0);
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
// DECAY — per-circle latched fade-out (0 = persist → up to 10 s fade).
// ---------------------------------------------------------------------------

describe('alphaFor — fade ramp', () => {
  it('decay=0 → always alpha 1 (no decay / persist)', () => {
    expect(alphaFor(0, 0)).toBe(1);
    expect(alphaFor(100, 0)).toBe(1);
  });
  it('linear ramp 1 → 0 over the latched decay seconds', () => {
    expect(alphaFor(0, 4)).toBe(1);
    expect(alphaFor(2, 4)).toBeCloseTo(0.5);
    expect(alphaFor(4, 4)).toBe(0);
    expect(alphaFor(8, 4)).toBe(0); // clamped, never negative
  });
});

describe('CirclesSim — decay (latched at spawn)', () => {
  it('latches decay at spawn; later decay changes affect only NEW circles', () => {
    const sim = new CirclesSim(7);
    sim.setParams({ d: 0.5, v: 0, spd: 0, decay: 0.5, rate: 0 }); // 5 s decay
    sim.spawn();
    const first = sim.circles[0]!;
    expect(first.decayS).toBeCloseTo(5);
    // Change decay, spawn again.
    sim.setParams({ d: 0.5, v: 0, spd: 0, decay: 1, rate: 0 }); // 10 s decay
    sim.spawn();
    expect(sim.circles[1]!.decayS).toBeCloseTo(10);
    // The first circle's latched decay is untouched.
    expect(first.decayS).toBeCloseTo(5);
  });

  it('decay=0 circle PERSISTS — never removed by decay (FIFO is the only cap)', () => {
    const sim = new CirclesSim(7);
    sim.setParams({ d: 0.5, v: 0, spd: 0, decay: 0, rate: 0 });
    sim.spawn();
    const c = sim.circles[0]!;
    for (let i = 0; i < 2000; i++) sim.step(16); // ~32 s
    expect(sim.count).toBe(1);
    expect(c.alpha).toBe(1);
    expect(sim.decayCount).toBe(0);
  });

  it('a decaying circle fades (alpha → 0) and VANISHES after its decay time', () => {
    const sim = new CirclesSim(7);
    sim.setParams({ d: 0.5, v: 0, spd: 0, decay: 0.2, rate: 0 }); // 2 s decay
    sim.spawn();
    const c = sim.circles[0]!;
    expect(c.alpha).toBe(1);
    // Halfway (1 s): alpha ~0.5, still present.
    for (let i = 0; i < 62; i++) sim.step(16); // ~0.99 s
    expect(sim.count).toBe(1);
    expect(c.alpha).toBeGreaterThan(0.4);
    expect(c.alpha).toBeLessThan(0.6);
    // Past the full decay window: removed.
    for (let i = 0; i < 80; i++) sim.step(16); // +~1.28 s → past 2 s total
    expect(sim.count).toBe(0);
    expect(sim.decayCount).toBe(1);
  });

  it('a fading circle contributes LESS to the overlap weight + a lighter output', () => {
    // Two stacked circles, one fully alive + one half-faded.
    const full: Circle = { x: 100, y: 100, vx: 0, vy: 0, diameter: 80, decayS: 2, ageS: 0, alpha: 1 };
    const half: Circle = { x: 100, y: 100, vx: 0, vy: 0, diameter: 80, decayS: 2, ageS: 1, alpha: 0.5 };
    // Both still cover the point → integer count 2.
    expect(overlapCountAt([full, half], 100, 100)).toBe(2);
    // …but the soft alpha weight is 1.5 (1 + 0.5), not 2.
    expect(overlapAlphaAt([full, half], 100, 100)).toBeCloseTo(1.5);
    // overlapValueAt = the strongest covering alpha → 1 here (the full circle).
    expect(overlapValueAt([full, half], 100, 100)).toBe(1);
    // A lone half-faded circle dims its overlap value to ~0.5.
    expect(overlapValueAt([half], 100, 100)).toBeCloseTo(0.5);
    // combine RGB of the faded stack is dimmer than the all-full stack.
    const lum = ([r, g, b]: number[]) => r! + g! + b!;
    const faded = combineRgbAt([full, half], 100, 100);
    const allFull = combineRgbAt([full, { ...half, ageS: 0, alpha: 1 }], 100, 100);
    expect(lum(faded)).toBeLessThan(lum(allFull));
  });
});

// ---------------------------------------------------------------------------
// INDEPENDENT per-circle SPEED — the headline fix. Each circle integrates from
// its OWN latched velocity; changing `spd` after spawn affects only NEW circles.
// ---------------------------------------------------------------------------

describe('CirclesSim — independent per-circle speed', () => {
  it('circle A keeps spd=X after spd is changed to Y for circle B', () => {
    const sim = new CirclesSim(11);
    // Spawn A at spd=X (1 → 300 px/s, +x).
    sim.setParams({ d: 0.5, v: 0, spd: 1, decay: 0, rate: 0 });
    sim.spawn();
    const a = sim.circles[0]!;
    a.x = 200; a.y = 200; // park A away from any wall

    // Change spd to Y (0.2 → 60 px/s, +x) and spawn B.
    sim.setParams({ d: 0.5, v: 0, spd: 0.2, decay: 0, rate: 0 });
    sim.spawn();
    const b = sim.circles[1]!;
    b.x = 200; b.y = 500; // park B away from any wall

    // A latched 300 px/s, B latched 60 px/s — independent of the live param.
    expect(a.vx).toBeCloseTo(300);
    expect(b.vx).toBeCloseTo(60);

    // Step 0.5 s: A moves 150 px, B moves 30 px — each at ITS OWN latched speed.
    sim.step(500);
    expect(a.x).toBeCloseTo(200 + 150, 0); // 300 px/s × 0.5 s
    expect(b.x).toBeCloseTo(200 + 30, 0);  // 60 px/s × 0.5 s
  });

  it('changing spd AFTER a circle spawned does NOT change that circle\'s motion', () => {
    const sim = new CirclesSim(13);
    sim.setParams({ d: 0.5, v: 0, spd: 1, decay: 0, rate: 0 }); // 300 px/s
    sim.spawn();
    const a = sim.circles[0]!;
    a.x = 100; a.y = 100;

    // Drop the live spd to 0 — a static field — AFTER A exists.
    sim.setParams({ d: 0.5, v: 0, spd: 0, decay: 0, rate: 0 });
    sim.step(100); // 0.1 s
    // A still moves at its latched 300 px/s (+30 px), unaffected by spd=0.
    expect(a.x).toBeCloseTo(130, 0);
    expect(a.vx).toBeCloseTo(300);
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
// COLLIDE gate — live inter-circle ELASTIC bounce via EDGE detection.
// The headline behaviour: gate ON → two head-on circles bounce APART (don't
// pass through); gate OFF → they pass through unaffected.
// ---------------------------------------------------------------------------

describe('circlesCollide — EDGE detection (uses radii, not centers)', () => {
  it('two discs collide when center distance ≤ r1 + r2', () => {
    // r1 = r2 = 50 (d=100). Centers 90 px apart → distance 90 ≤ 100 → collide.
    const a: Circle = { x: 0, y: 0, vx: 0, vy: 0, diameter: 100 };
    const b: Circle = { x: 90, y: 0, vx: 0, vy: 0, diameter: 100 };
    expect(circlesCollide(a, b)).toBe(true);
    // 110 px apart → distance 110 > 100 → no collision.
    const far: Circle = { x: 110, y: 0, vx: 0, vy: 0, diameter: 100 };
    expect(circlesCollide(a, far)).toBe(false);
    // EXACTLY touching (distance == r1+r2 == 100) counts as colliding.
    const touch: Circle = { x: 100, y: 0, vx: 0, vy: 0, diameter: 100 };
    expect(circlesCollide(a, touch)).toBe(true);
  });

  it('the EDGE test uses RADII — centers far apart still collide if the discs are big', () => {
    // Centers 150 px apart but each disc has r=100 (d=200) → r1+r2=200 > 150 →
    // collide. A CENTER-based test (like the wall bounce) would miss this; the
    // edge test catches it.
    const a: Circle = { x: 0, y: 0, vx: 0, vy: 0, diameter: 200 };
    const b: Circle = { x: 150, y: 0, vx: 0, vy: 0, diameter: 200 };
    expect(circlesCollide(a, b)).toBe(true);
  });
});

describe('resolveElasticPair — equal-mass elastic bounce + separation', () => {
  it('head-on equal/opposite velocities → swap (each reverses)', () => {
    // A moving +x, B moving -x, overlapping on the x axis.
    const a: Circle = { x: 0, y: 0, vx: 100, vy: 0, diameter: 100 };
    const b: Circle = { x: 80, y: 0, vx: -100, vy: 0, diameter: 100 };
    const hit = resolveElasticPair(a, b);
    expect(hit).toBe(true);
    // Equal-mass head-on swap: A now moves -x, B now moves +x.
    expect(a.vx).toBeCloseTo(-100);
    expect(b.vx).toBeCloseTo(100);
    // Separated so they no longer overlap (center distance ≥ r1+r2 = 100).
    const dx = b.x - a.x;
    expect(Math.abs(dx)).toBeGreaterThanOrEqual(100 - 1e-6);
  });

  it('only exchanges the NORMAL component; the tangential component is untouched', () => {
    // A has a tangential (y) velocity that must survive a head-on (x-normal) hit.
    const a: Circle = { x: 0, y: 0, vx: 100, vy: 40, diameter: 100 };
    const b: Circle = { x: 80, y: 0, vx: -100, vy: 0, diameter: 100 };
    resolveElasticPair(a, b);
    // The x (normal) components swapped; A keeps its y (tangential) velocity.
    expect(a.vx).toBeCloseTo(-100);
    expect(a.vy).toBeCloseTo(40);
    expect(b.vx).toBeCloseTo(100);
  });

  it('returns false (no-op) when the discs do NOT overlap', () => {
    const a: Circle = { x: 0, y: 0, vx: 100, vy: 0, diameter: 100 };
    const b: Circle = { x: 300, y: 0, vx: -100, vy: 0, diameter: 100 };
    const before = { ...a };
    expect(resolveElasticPair(a, b)).toBe(false);
    expect([a.vx, a.vy, a.x, a.y]).toEqual([before.vx, before.vy, before.x, before.y]);
  });

  it('coincident centers separate deterministically (no NaN / no RNG)', () => {
    const a: Circle = { x: 100, y: 100, vx: 0, vy: 0, diameter: 100 };
    const b: Circle = { x: 100, y: 100, vx: 0, vy: 0, diameter: 100 };
    expect(resolveElasticPair(a, b)).toBe(true);
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(b.x)).toBe(true);
    expect(a.x).not.toBe(b.x); // pushed apart
  });

  it('conserves total kinetic energy + momentum (equal mass)', () => {
    const a: Circle = { x: 0, y: 0, vx: 70, vy: 25, diameter: 100 };
    const b: Circle = { x: 60, y: 30, vx: -10, vy: 50, diameter: 100 };
    const ke = (c: Circle) => c.vx * c.vx + c.vy * c.vy;
    const keBefore = ke(a) + ke(b);
    const pxBefore = a.vx + b.vx;
    const pyBefore = a.vy + b.vy;
    resolveElasticPair(a, b);
    expect(ke(a) + ke(b)).toBeCloseTo(keBefore, 3);
    expect(a.vx + b.vx).toBeCloseTo(pxBefore, 6);
    expect(a.vy + b.vy).toBeCloseTo(pyBefore, 6);
  });
});

describe('CirclesSim — COLLIDE gate (live global mode)', () => {
  /** Place exactly two circles on a head-on course on the x-axis, away from
   *  walls, with collide set to `on`. Returns the two circles + the sim. */
  function headOnPair(on: boolean): { sim: CirclesSim; a: Circle; b: Circle } {
    const sim = new CirclesSim(1);
    // spawn two static circles, then hand-place + hand-velocity them.
    sim.setParams({ d: 0.5, v: 0, spd: 0, rate: 0, collide: on });
    sim.spawn();
    sim.spawn();
    const a = sim.circles[0]!;
    const b = sim.circles[1]!;
    // Diameter 100 (override the spawn diameter for clean radius math).
    a.diameter = 100; b.diameter = 100;
    // A at x=400 moving +x; B at x=460 moving -x → centers 60 < 100 = on a
    // collision course (already overlapping). Both at y=500 (mid-field).
    a.x = 400; a.y = 500; a.vx = 120; a.vy = 0;
    b.x = 460; b.y = 500; b.vx = -120; b.vy = 0;
    return { sim, a, b };
  }

  it('GATE ON → the two circles BOUNCE APART (velocities reverse, no pass-through)', () => {
    const { sim, a, b } = headOnPair(true);
    // One small step: they're overlapping → elastic swap fires.
    sim.step(16);
    // Head-on equal-mass swap: A reverses to -x, B reverses to +x.
    expect(a.vx).toBeLessThan(0);
    expect(b.vx).toBeGreaterThan(0);
    // …and at least one collision was registered.
    expect(sim.collisionCount).toBeGreaterThanOrEqual(1);

    // Keep stepping: because they bounced apart, A drifts LEFT and B drifts
    // RIGHT — they never swap order (no pass-through).
    for (let i = 0; i < 40; i++) sim.step(16);
    expect(a.x).toBeLessThan(b.x); // A still left of B
    expect(a.x).toBeLessThan(400); // A moved left of its start
    expect(b.x).toBeGreaterThan(460); // B moved right of its start
  });

  it('GATE OFF → the two circles PASS THROUGH each other (unaffected)', () => {
    const { sim, a, b } = headOnPair(false);
    // Step long enough for A (moving +x) to cross past B (moving -x).
    for (let i = 0; i < 40; i++) sim.step(16);
    // No collision was ever resolved.
    expect(sim.collisionCount).toBe(0);
    // Velocities never reversed from the collision (still their original signs,
    // unless they hit a wall — but they're mid-field with this short run).
    expect(a.vx).toBeGreaterThan(0); // still +x (passed through, not bounced)
    expect(b.vx).toBeLessThan(0);    // still -x
    // They CROSSED: A (started left, +x) is now RIGHT of B (started right, -x).
    expect(a.x).toBeGreaterThan(b.x);
  });

  it('collide is a LIVE GLOBAL toggle (not latched): flips with the gate frame-to-frame', () => {
    const { sim, a, b } = headOnPair(false);
    // Gate LOW: one step, no collision even though they overlap.
    sim.step(16);
    expect(sim.collisionCount).toBe(0);
    // Flip the gate HIGH (live) — re-place them overlapping + head-on.
    a.x = 400; a.vx = 120; b.x = 460; b.vx = -120;
    sim.setParams({ d: 0.5, v: 0, spd: 0, rate: 0, collide: true });
    sim.step(16);
    expect(sim.collisionCount).toBeGreaterThanOrEqual(1);
    expect(a.vx).toBeLessThan(0); // now bounced
  });

  it('a colliding circle keeps its independent latched SPEED magnitude (head-on swap)', () => {
    const sim = new CirclesSim(2);
    sim.setParams({ d: 0.5, v: 0, spd: 0, rate: 0, collide: true });
    sim.spawn(); sim.spawn();
    const a = sim.circles[0]!;
    const b = sim.circles[1]!;
    a.diameter = 100; b.diameter = 100;
    // A fast (200 px/s +x), B slow (50 px/s -x), head-on overlapping.
    a.x = 400; a.y = 500; a.vx = 200; a.vy = 0;
    b.x = 460; b.y = 500; b.vx = -50; b.vy = 0;
    const spdA = Math.hypot(a.vx, a.vy);
    const spdB = Math.hypot(b.vx, b.vy);
    sim.step(16);
    // Head-on equal-mass elastic swap exchanges the speeds: A now carries B's
    // old speed and vice-versa — the SET of speed magnitudes is conserved.
    expect([Math.hypot(a.vx, a.vy), Math.hypot(b.vx, b.vy)].sort((p, q) => p - q))
      .toEqual([spdB, spdA].sort((p, q) => p - q));
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

// ---------------------------------------------------------------------------
// GATE-spawn latches the LIVE params — the headline bug fix.
//
// Regression for: a circle spawned via the GATE input didn't move + didn't
// decay, while rate-clock-spawned circles did. ROOT CAUSE: the module only
// pushed live knob/CV params into the sim inside surface.draw() (per render
// frame), but the gate spawn fired in the setParam(cv_gate) handler — which
// runs on the CV-bridge's cadence, BEFORE the first draw() or between draws
// after a knob change. So a gate-spawned circle latched the sim's STALE params
// (its constructor default decay=0 → never fades, and whatever spd the last
// draw happened to push → wrong/zero velocity). The fix pushes the CURRENT
// live params into the sim in the gate handler, immediately before spawnFromGate().
//
// These tests drive the REAL module factory's setParam('cv_gate', …) gate path
// (not the sim in isolation) and inspect the spawned circle via read('circles').
// ---------------------------------------------------------------------------

/** A minimal fake WebGL2 context: factory only needs non-null texture / fbo /
 *  uniform-location handles; every draw call no-ops. */
function makeFakeGl(): WebGL2RenderingContext {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'createTexture' || prop === 'createFramebuffer') return () => ({});
        if (prop === 'getUniformLocation') return () => ({});
        return () => 0;
      },
    },
  ) as unknown as WebGL2RenderingContext;
}

function makeCirclesCtx(): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
  };
}

function makeFrameCtx(frameNo: number): VideoFrameContext {
  return { gl: makeFakeGl(), time: frameNo / 60, frame: frameNo, getInputTexture: () => null };
}

function spawnCircles() {
  const node = { id: 'c', type: 'circles', domain: 'video', params: {}, position: { x: 0, y: 0 } } as ModuleNode;
  return circlesDef.factory(makeCirclesCtx(), node);
}

/** Fire one rising-edge gate pulse through the real CV-bridge entry point. */
function fireGate(h: ReturnType<typeof spawnCircles>): void {
  h.setParam(CIRCLES_GATE_PARAM_ID, 1); // rising edge → spawn
  h.setParam(CIRCLES_GATE_PARAM_ID, 0); // release → re-arm
}

/** The most-recently-spawned circle (the gate-spawn under test). */
function lastCircle(h: ReturnType<typeof spawnCircles>): Circle {
  const cs = h.read?.('circles') as readonly Circle[];
  expect(cs.length).toBeGreaterThan(0);
  return cs[cs.length - 1]!;
}

describe('CIRCLES module — gate-spawned circle latches the LIVE params', () => {
  it('BEFORE the first draw(): gate spawn latches live spd (MOVES) + live decay (DECAYS)', () => {
    const h = spawnCircles();
    h.setParam('rate', 0); // gate-only — no rate-clock spawns
    h.setParam('spd', 0.6); // ~180 px/s → must move
    h.setParam('decay', 0.5); // 5 s decay → must fade

    // Fire the gate with NO draw() in between (the before-first-draw ordering
    // that the old code latched the sim's constructor defaults on).
    fireGate(h);
    expect(h.read?.('circleCount')).toBe(1);

    const c = lastCircle(h);
    // MOVES: latched velocity is nonzero (≈ live spd 0.6 → 0.6×300 = 180 px/s).
    const speed = Math.hypot(c.vx, c.vy);
    expect(speed).toBeGreaterThan(0);
    expect(speed).toBeCloseTo(0.6 * 300, 0);
    // DECAYS: latched decay is the live 5 s (0.5 × 10), not the stale 0 (persist).
    expect(c.decayS).toBeCloseTo(5);
  });

  it('STEADY-STATE: knob change then gate fires before the next draw() still latches the live params', () => {
    const h = spawnCircles();
    h.setParam('rate', 0);
    // Establish steady state — a draw() that synced the OLD params (default
    // spd 0.4, decay 0) into the sim.
    h.surface.draw(makeFrameCtx(0));

    // Now turn spd + decay up and fire the gate BEFORE the next draw().
    h.setParam('spd', 0.7);
    h.setParam('decay', 0.3);
    fireGate(h);

    const c = lastCircle(h);
    expect(Math.hypot(c.vx, c.vy)).toBeCloseTo(0.7 * 300, 0); // live spd, not stale 0.4
    expect(c.decayS).toBeCloseTo(3); // live decay (0.3 × 10), not stale 0
  });

  it('the gate-spawned circle ACTUALLY fades + is removed over its decay window', () => {
    const h = spawnCircles();
    h.setParam('rate', 0);
    h.setParam('spd', 0.5);
    h.setParam('decay', 0.2); // 2 s decay
    fireGate(h);
    expect(h.read?.('circleCount')).toBe(1);
    expect(h.read?.('decayCount')).toBe(0);
    // Run ~4 s of 60fps frames — well past the 2 s decay window.
    for (let i = 0; i < 250; i++) h.surface.draw(makeFrameCtx(i));
    // The gate-spawned circle faded to alpha 0 + was removed (the bug left it
    // persisting forever with a stale decay of 0).
    expect(h.read?.('decayCount')).toBe(1);
    expect(h.read?.('circleCount')).toBe(0);
  });

  it('the gate-spawned circle ACTUALLY moves across frames', () => {
    const h = spawnCircles();
    h.setParam('rate', 0);
    h.setParam('v', 0); // angle 0 → +x drift (deterministic axis)
    h.setParam('spd', 0.6); // ~180 px/s
    h.setParam('decay', 0); // persist so we can track it
    fireGate(h);
    const c = lastCircle(h);
    const x0 = c.x;
    const y0 = c.y;
    for (let i = 0; i < 30; i++) h.surface.draw(makeFrameCtx(i)); // ~0.5 s
    // Same object reference (persist, no decay) — it MOVED from its spawn point.
    const moved = Math.hypot(c.x - x0, c.y - y0);
    expect(moved).toBeGreaterThan(10);
  });

  it('spd=0 at the gate edge → a STATIC gate-spawned circle (correct, not the bug)', () => {
    const h = spawnCircles();
    h.setParam('rate', 0);
    h.setParam('spd', 0); // static is a valid, intended state
    h.setParam('decay', 0);
    fireGate(h);
    const c = lastCircle(h);
    expect(Math.abs(c.vx)).toBe(0);
    expect(Math.abs(c.vy)).toBe(0);
  });

  it('decay=0 at the gate edge → the gate-spawned circle PERSISTS (correct default)', () => {
    const h = spawnCircles();
    h.setParam('rate', 0);
    h.setParam('spd', 0.5);
    h.setParam('decay', 0); // persist is the correct default
    fireGate(h);
    const c = lastCircle(h);
    expect(c.decayS).toBe(0);
    for (let i = 0; i < 250; i++) h.surface.draw(makeFrameCtx(i)); // ~4 s
    expect(h.read?.('decayCount')).toBe(0);
    expect(h.read?.('circleCount')).toBe(1);
  });

  it('rate-clock-spawned circles still latch the live params (no regression)', () => {
    const h = spawnCircles();
    h.setParam('rate', 1); // clock at the 1/500ms cap
    h.setParam('spd', 0.6);
    h.setParam('decay', 0.5);
    // Drive ~1.5 s of frames so the rate clock spawns a few circles.
    for (let i = 0; i < 95; i++) h.surface.draw(makeFrameCtx(i));
    const cs = h.read?.('circles') as readonly Circle[];
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) {
      expect(Math.hypot(c.vx, c.vy)).toBeCloseTo(0.6 * 300, 0);
      expect(c.decayS).toBeCloseTo(5);
    }
  });
});
