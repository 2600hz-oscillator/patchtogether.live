// packages/web/src/lib/video/modules/circles-sim.ts
//
// CIRCLES — pure, WebGL-free particle simulation + output-derivation math.
//
// Split out from the module def (circles.ts) so the entire stateful sim —
// seeded spawn, velocity integration, center-point bounce, per-circle
// latched d/v/spd, the internal rate clock, the max-circle cull — and the
// per-output derivation (overlap count → overlap / combine-hue / mapped
// mask, plus the contour ring test) are testable WITHOUT a WebGL2 context
// or a canvas. circles.ts owns ONLY the GL plumbing (4 FBOs + the 2D
// canvas paint + texture upload); every numeric decision lives here.
//
// Determinism: spawn position comes from a seeded mulberry32 PRNG (shared
// rack PRNG, byte-identical across engines), NEVER Math.random(). A fixed
// default seed + deterministic frame-stepping make the VRT / per-port /
// behavioral sweeps reproducible. Construct a CirclesSim with an explicit
// seed in tests and call step(dt) to advance frame-by-frame.

import { mulberry32 } from '$lib/sync/prng';

// ---------------------------------------------------------------------------
// Constants — the field, the param ranges, and the safety cap.
// ---------------------------------------------------------------------------

/** The square render field, in pixels. Matches the spec's "1024-px field".
 *  The video engine's FBO is 1024×768 (4:3); we sim + render the circles in
 *  a 1024×1024 logical field and the GL upload aspect-fits it like every
 *  other source (the 2D scene canvas is square; the fullscreen quad samples
 *  it). Keeping the sim square means the bounce math is symmetric. */
export const CIRCLES_FIELD = 1024;

/** Circle DIAMETER range (px). `d` knob/CV 0..1 → [MIN, MAX]. */
export const D_MIN = 5;
export const D_MAX = 90;

/** SPEED range (px/s). `spd` knob/CV 0..1 → [0, MAX]. 300  px/s crosses the
 *  1024 field in ~3.4 s. */
export const SPD_MAX = 300;

/** The internal rate clock is capped at 1 spawn per this many ms. At rate=1
 *  (max) the clock fires every 500 ms. */
export const RATE_MIN_INTERVAL_MS = 500;

/** Above rate≈0 the clock engages; we map the rate knob to a spawn interval
 *  that starts slow and tightens toward the 500 ms cap. RATE_SLOW_INTERVAL_MS
 *  is the interval at the smallest engaged rate (just above 0). */
export const RATE_SLOW_INTERVAL_MS = 4000;

/** Below this rate value the internal clock is OFF (gate-only spawning). */
export const RATE_ENGAGE_THRESHOLD = 0.001;

/** Max simultaneous circles. Circles bounce forever (never leave the field)
 *  so under continuous spawning they accumulate unbounded; we cap the active
 *  list and cull the OLDEST when a spawn would exceed it, keeping per-frame
 *  cost bounded. 200 keeps the "ripples in a pond" contour look dense while
 *  the per-pixel count buffer stays cheap. */
export const MAX_CIRCLES = 200;

// ---------------------------------------------------------------------------
// Param mapping — knob/CV 0..1 (clamped) → physical units.
// ---------------------------------------------------------------------------

/** Clamp a 0..1 knob/CV value. CV can arrive slightly out of range. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** `d` 0..1 → diameter px in [D_MIN, D_MAX]. */
export function mapDiameter(d01: number): number {
  return D_MIN + clamp01(d01) * (D_MAX - D_MIN);
}

/** `v` 0..1 → vector angle in [0, 2π). Full range reaches every angle. */
export function mapAngle(v01: number): number {
  return clamp01(v01) * Math.PI * 2;
}

/** `spd` 0..1 → speed px/s in [0, SPD_MAX]. */
export function mapSpeed(spd01: number): number {
  return clamp01(spd01) * SPD_MAX;
}

/**
 * `rate` 0..1 → internal-clock spawn interval in ms, or null when the clock
 * is OFF (rate at/below the engage threshold → spawn ONLY on gate events).
 *
 * The engaged range maps the rate up-curve to an interval that interpolates
 * from RATE_SLOW_INTERVAL_MS (slow) down to RATE_MIN_INTERVAL_MS (the
 * "1 circle / 500 ms" cap) at rate=1. The interval can never go below the
 * cap, so the spawn rate is hard-limited regardless of knob/curve.
 */
export function mapRateIntervalMs(rate01: number): number | null {
  const r = clamp01(rate01);
  if (r <= RATE_ENGAGE_THRESHOLD) return null;
  const interval = RATE_SLOW_INTERVAL_MS + r * (RATE_MIN_INTERVAL_MS - RATE_SLOW_INTERVAL_MS);
  return Math.max(RATE_MIN_INTERVAL_MS, interval);
}

// ---------------------------------------------------------------------------
// Circle state.
// ---------------------------------------------------------------------------

export interface Circle {
  /** Center x in [0, CIRCLES_FIELD]. */
  x: number;
  /** Center y in [0, CIRCLES_FIELD]. */
  y: number;
  /** Velocity px/s. */
  vx: number;
  vy: number;
  /** LATCHED diameter px (snapshot of `d` at spawn). */
  diameter: number;
}

/** Per-frame param snapshot the sim reads when it spawns. These are the
 *  module's live knob+CV values; each spawned circle LATCHES them, so later
 *  changes affect only NEW circles. */
export interface CirclesSpawnParams {
  /** 0..1 — circle diameter. */
  d: number;
  /** 0..1 — spawn vector angle. */
  v: number;
  /** 0..1 — speed. */
  spd: number;
  /** 0..1 — internal-clock rate (0 = gate-only). */
  rate: number;
}

// ---------------------------------------------------------------------------
// The simulation.
// ---------------------------------------------------------------------------

export class CirclesSim {
  /** Active circles, oldest first (so cull-oldest = shift()). */
  readonly circles: Circle[] = [];

  /** Live spawn params (the module pushes knob/CV changes here each frame). */
  private params: CirclesSpawnParams = { d: 0.5, v: 0, spd: 0.5, rate: 0 };

  /** Seeded PRNG — drives spawn position ONLY. Deterministic per seed. */
  private rng: () => number;

  /** Accumulator (ms) for the internal rate clock. */
  private rateAccumMs = 0;

  /** Total circles ever spawned (monotonic; for tests/telemetry). */
  spawnCount = 0;

  /** Total circles culled by the cap (monotonic; for tests/telemetry). */
  cullCount = 0;

  constructor(seed = 0x0c1c1e5) {
    this.rng = mulberry32(seed | 0);
  }

  /** Replace the live spawn params (called by the module each frame from the
   *  current knob+CV values). Does NOT retro-affect already-spawned circles. */
  setParams(p: CirclesSpawnParams): void {
    this.params = p;
  }

  /**
   * Spawn ONE circle at a seeded-random position in the field, moving in the
   * current `v` direction at the current `spd`, latching the current `d`.
   * Enforces the max-circle cap by culling the oldest first.
   *
   * `spd=0` → a static circle (vx=vy=0) scattered at the random position.
   */
  spawn(): Circle {
    const diameter = mapDiameter(this.params.d);
    const angle = mapAngle(this.params.v);
    const speed = mapSpeed(this.params.spd);
    const c: Circle = {
      x: this.rng() * CIRCLES_FIELD,
      y: this.rng() * CIRCLES_FIELD,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      diameter,
    };
    // Cull-oldest BEFORE pushing so the list never exceeds the cap.
    while (this.circles.length >= MAX_CIRCLES) {
      this.circles.shift();
      this.cullCount++;
    }
    this.circles.push(c);
    this.spawnCount++;
    return c;
  }

  /**
   * Spawn a circle on a gate event. Returns the new circle. The module owns
   * the edge-detector hysteresis (plex-select.gateEdge) and calls this ONLY
   * on a detected LOW→HIGH rising edge.
   */
  spawnFromGate(): Circle {
    return this.spawn();
  }

  /**
   * Advance the sim by `dtMs` milliseconds:
   *   1. Run the internal rate clock (rate>0): accumulate time, spawn each
   *      time the (capped) interval elapses. rate=0 → no internal spawns.
   *   2. Integrate every circle's position; bounce when its CENTER crosses a
   *      wall (reflect the matching velocity component, clamp center into the
   *      field). No edge/radius collision math — the spec is explicit: the
   *      CENTER bounces, the visible disc may briefly overhang the wall.
   *
   * Returns the number of circles spawned by the internal clock this step.
   */
  step(dtMs: number): number {
    const dt = Math.max(0, dtMs);
    let clockSpawns = 0;

    // 1. Internal rate clock.
    const interval = mapRateIntervalMs(this.params.rate);
    if (interval == null) {
      // Clock off — don't let the accumulator build up so that turning the
      // knob up doesn't dump a backlog of instant spawns.
      this.rateAccumMs = 0;
    } else {
      this.rateAccumMs += dt;
      // Guard against a huge dt (tab-backgrounded) dumping hundreds of
      // spawns: cap to one spawn per step beyond the first few.
      let guard = 0;
      while (this.rateAccumMs >= interval && guard < 8) {
        this.rateAccumMs -= interval;
        this.spawn();
        clockSpawns++;
        guard++;
      }
      // If we bailed on the guard, drop the remaining backlog.
      if (this.rateAccumMs >= interval) this.rateAccumMs = 0;
    }

    // 2. Integrate + center-bounce.
    const dts = dt / 1000;
    for (const c of this.circles) {
      c.x += c.vx * dts;
      c.y += c.vy * dts;
      if (c.x < 0) { c.x = 0; c.vx = -c.vx; }
      else if (c.x > CIRCLES_FIELD) { c.x = CIRCLES_FIELD; c.vx = -c.vx; }
      if (c.y < 0) { c.y = 0; c.vy = -c.vy; }
      else if (c.y > CIRCLES_FIELD) { c.y = CIRCLES_FIELD; c.vy = -c.vy; }
    }

    return clockSpawns;
  }

  /** Active circle count. */
  get count(): number {
    return this.circles.length;
  }
}

// ---------------------------------------------------------------------------
// Output-derivation math — pure functions over the circle list + a sample
// point. circles.ts renders these per-pixel on the 2D scene canvases; the
// unit suite asserts them point-wise without a canvas.
// ---------------------------------------------------------------------------

/** How many circles cover the point (px,py)? A circle covers the point when
 *  the point is within its RADIUS of its center (filled disc). */
export function overlapCountAt(circles: readonly Circle[], px: number, py: number): number {
  let n = 0;
  for (const c of circles) {
    const r = c.diameter * 0.5;
    const dx = px - c.x;
    const dy = py - c.y;
    if (dx * dx + dy * dy <= r * r) n++;
  }
  return n;
}

/** `overlap` output: white where ≥1 circle covers the pixel, else black. */
export function overlapValueAt(circles: readonly Circle[], px: number, py: number): number {
  return overlapCountAt(circles, px, py) >= 1 ? 1 : 0;
}

/** Ring line-width for a circle's contour: 10% of its diameter, min 2 px. */
export function ringWidth(diameter: number): number {
  return Math.max(2, diameter * 0.1);
}

/** `contour` output: 1 where the point lies on ANY circle's outline ring
 *  (radial distance within [r − lw, r] of a center), else 0. Outlines only —
 *  many circles produce "ripples in a pond". */
export function contourValueAt(circles: readonly Circle[], px: number, py: number): number {
  for (const c of circles) {
    const r = c.diameter * 0.5;
    const lw = ringWidth(c.diameter);
    const dx = px - c.x;
    const dy = py - c.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= r && dist >= r - lw) return 1;
  }
  return 0;
}

/**
 * `combine` hue-ramp: overlap COUNT → a hue (0..1, i.e. a fraction of the
 * colour wheel). 1 overlap = the first hue; 2,3,4… cycle through the
 * spectrum. We step the hue by the golden-angle fraction (≈0.618) per
 * additional overlap so adjacent counts are maximally distinct on the wheel
 * (no two low counts share a near-identical hue). Count 0 → hue is undefined
 * (the pixel is black; brightness 0).
 */
export const HUE_STEP = 0.61803398875; // golden ratio conjugate

export function combineHueAt(count: number): number {
  if (count < 1) return 0;
  // count 1 → 0, count 2 → 0.618, count 3 → 0.236, … (mod 1).
  return ((count - 1) * HUE_STEP) % 1;
}

/** Brightness rises with stack depth, saturating toward 1. */
export function combineBrightnessAt(count: number): number {
  if (count < 1) return 0;
  return Math.min(1, 0.45 + 0.18 * (count - 1));
}

/** Saturation rises with stack depth, saturating toward 1. */
export function combineSaturationAt(count: number): number {
  if (count < 1) return 0;
  return Math.min(1, 0.55 + 0.15 * (count - 1));
}

/**
 * HSV → RGB, all components in 0..1. Used to colorize the `combine` output
 * from (hue, sat, val). Standard piecewise conversion.
 */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/** `combine` RGB at a point: colorize the overlap count via the hue ramp.
 *  Black (0,0,0) where count is 0. */
export function combineRgbAt(circles: readonly Circle[], px: number, py: number): [number, number, number] {
  const count = overlapCountAt(circles, px, py);
  if (count < 1) return [0, 0, 0];
  return hsvToRgb(combineHueAt(count), combineSaturationAt(count), combineBrightnessAt(count));
}

/** `mapped` mask at a point: 1 where ≥2 circles overlap (show the video
 *  input there), else 0 (black). The module multiplies the video-input
 *  texture by this mask in the shader. */
export function mappedMaskAt(circles: readonly Circle[], px: number, py: number): number {
  return overlapCountAt(circles, px, py) >= 2 ? 1 : 0;
}
