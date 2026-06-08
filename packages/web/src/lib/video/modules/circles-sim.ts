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

/** Circle DIAMETER range (px). `d` knob/CV 0..1 → [MIN, MAX]. MAX is 270 px
 *  (3× the original 90) so circles can grow large enough to dominate the
 *  1024-px field. */
export const D_MIN = 5;
export const D_MAX = 270;

/** SPEED range (px/s). `spd` knob/CV 0..1 → [0, MAX]. 300  px/s crosses the
 *  1024 field in ~3.4 s. */
export const SPD_MAX = 300;

/** DECAY range (seconds). `decay` knob/CV 0..1 → [0, MAX]. 0 s = NO decay
 *  (the circle persists until the FIFO cap culls it — the static-field use
 *  case); up to 10 s means the circle fades (alpha 1 → 0) and is removed over
 *  that many seconds after spawn. */
export const DECAY_MAX_S = 10;

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
 *  the per-pixel count buffer stays cheap. It also BOUNDS the COLLIDE mode's
 *  O(n²) pairwise check: 200² ≈ 20k distance tests/frame (the inner half is
 *  ~10k) — cheap enough to run inline without spatial hashing. */
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

/** `decay` 0..1 → fade-out duration in seconds in [0, DECAY_MAX_S].
 *  0 = no decay (persist until the FIFO cap culls). */
export function mapDecay(decay01: number): number {
  return clamp01(decay01) * DECAY_MAX_S;
}

/**
 * A circle's fade alpha in [0,1] from its age + LATCHED decay duration (both
 * seconds). `decayS <= 0` → no decay (always 1, the persist case). Otherwise a
 * linear ramp: alpha = 1 at spawn, 0 once age ≥ decayS. The circle is removed
 * when this hits 0; the four outputs scale their contribution by it while alive
 * (a fading disc adds less to the overlap COUNT / draws a lighter contour).
 */
export function alphaFor(ageS: number, decayS: number): number {
  if (decayS <= 0) return 1;
  const a = 1 - ageS / decayS;
  return a < 0 ? 0 : a > 1 ? 1 : a;
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
  /** Velocity px/s. LATCHED at spawn (cos/sin of the spawn angle × the spawn
   *  speed); integration reads ONLY this stored velocity, so a later `spd`/`v`
   *  knob change affects NEW circles only — never this one. */
  vx: number;
  vy: number;
  /** LATCHED diameter px (snapshot of `d` at spawn). */
  diameter: number;
  /** LATCHED decay duration in SECONDS (snapshot of `decay` at spawn).
   *  0 = no decay (persist until FIFO-culled). Optional so plain test discs
   *  (and any legacy {x,y,vx,vy,diameter}) remain valid; the sim always sets it
   *  + treats an absent value as 0 (persist). */
  decayS?: number;
  /** Seconds since this circle spawned (advanced by step). Optional; absent = 0. */
  ageS?: number;
  /** Current alpha in [0,1]: 1 while alive, ramping to 0 over `decayS` seconds.
   *  Always 1 when decayS===0. All four outputs scale their contribution by
   *  this (a fading circle counts less toward overlap / draws a lighter ring).
   *  Recomputed each step from ageS/decayS. Optional; absent = 1 (alive). */
  alpha?: number;
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
  /** 0..1 — fade-out duration (0 / omitted = persist, no decay). */
  decay?: number;
  /** LIVE GLOBAL inter-circle collision mode (NOT latched per circle). When
   *  truthy, every pair of circles that overlaps (center distance ≤ r1+r2)
   *  this frame does an equal-mass ELASTIC bounce; when falsy (the default,
   *  unpatched / gate LOW) circles pass through each other. Toggled live each
   *  frame from the COLLIDE gate. */
  collide?: boolean;
}

// ---------------------------------------------------------------------------
// Inter-circle ELASTIC collision (the COLLIDE gate mode).
// ---------------------------------------------------------------------------

/**
 * EDGE-based pair test: two circles collide when the distance between their
 * CENTERS is ≤ (r1 + r2) — i.e. their painted DISCS touch/overlap. This is the
 * key difference from the existing WALL bounce, which is purely center-based
 * (the center crossing the wall). Returns true when the two discs intersect.
 */
export function circlesCollide(a: Circle, b: Circle): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rsum = (a.diameter + b.diameter) * 0.5;
  return dx * dx + dy * dy <= rsum * rsum;
}

/**
 * Resolve ONE elastic collision between an overlapping pair IN PLACE.
 *
 * Equal-mass elastic collision: along the center-to-center NORMAL, the two
 * circles exchange the velocity component projected onto that normal; the
 * tangential components are untouched. (For equal masses this is the standard
 * result — the normal-velocity components swap.) Each circle therefore keeps
 * its independent latched SPEED magnitude as far as elastic physics allows
 * (a head-on pair simply swaps velocities; a glancing pair exchanges only the
 * normal share).
 *
 * We also POSITIONALLY SEPARATE the pair by half the overlap each along the
 * normal so they don't stick/re-trigger every frame. Coincident centers (a
 * zero normal) are nudged apart along +x deterministically (no RNG) so the
 * math never divides by zero.
 *
 * Returns true if a collision was resolved (the discs overlapped), else false.
 */
export function resolveElasticPair(a: Circle, b: Circle): boolean {
  let nx = b.x - a.x;
  let ny = b.y - a.y;
  let dist = Math.sqrt(nx * nx + ny * ny);
  const rsum = (a.diameter + b.diameter) * 0.5;
  if (dist > rsum) return false; // not touching → nothing to do
  if (dist === 0) {
    // Perfectly coincident centers — pick a deterministic +x normal.
    nx = 1;
    ny = 0;
    dist = 0.0001;
  }
  // Unit normal from a → b.
  const ux = nx / dist;
  const uy = ny / dist;

  // Velocity components along the normal.
  const va = a.vx * ux + a.vy * uy;
  const vb = b.vx * ux + b.vy * uy;
  // Equal-mass elastic: swap the normal components. The exchange (vb - va)
  // is applied to each circle's normal-projected velocity.
  const exchange = vb - va;
  a.vx += exchange * ux;
  a.vy += exchange * uy;
  b.vx -= exchange * ux;
  b.vy -= exchange * uy;

  // Positional de-overlap: push each circle half the penetration along the
  // normal so they separate (no sticking / per-frame re-trigger).
  const overlap = rsum - dist;
  if (overlap > 0) {
    const push = overlap * 0.5;
    a.x -= ux * push;
    a.y -= uy * push;
    b.x += ux * push;
    b.y += uy * push;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The simulation.
// ---------------------------------------------------------------------------

export class CirclesSim {
  /** Active circles, oldest first (so cull-oldest = shift()). */
  readonly circles: Circle[] = [];

  /** Live spawn params (the module pushes knob/CV changes here each frame). */
  private params: CirclesSpawnParams = { d: 0.5, v: 0, spd: 0.5, rate: 0, decay: 0, collide: false };

  /** Total pair-collisions resolved (monotonic; for tests/telemetry). */
  collisionCount = 0;

  /** Seeded PRNG — drives spawn position ONLY. Deterministic per seed. */
  private rng: () => number;

  /** Accumulator (ms) for the internal rate clock. */
  private rateAccumMs = 0;

  /** Total circles ever spawned (monotonic; for tests/telemetry). */
  spawnCount = 0;

  /** Total circles culled by the cap (monotonic; for tests/telemetry). */
  cullCount = 0;

  /** Total circles removed by decay (alpha→0) (monotonic; tests/telemetry). */
  decayCount = 0;

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
    const decayS = mapDecay(this.params.decay ?? 0);
    // Latch EVERYTHING at spawn (d, v→angle, spd→velocity, decay). Integration
    // reads only the stored velocity, so a later spd/v change can't retro-affect
    // an existing circle — it moves at its own latched speed for its whole life.
    const c: Circle = {
      x: this.rng() * CIRCLES_FIELD,
      y: this.rng() * CIRCLES_FIELD,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      diameter,
      decayS,
      ageS: 0,
      alpha: 1,
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
   *   2. Integrate every circle's position from its LATCHED velocity (never the
   *      live `spd`), bounce when its CENTER crosses a wall (reflect the
   *      matching velocity component, clamp center into the field). No
   *      edge/radius collision math for the WALL — the CENTER bounces, the
   *      visible disc may briefly overhang the wall. Then age each circle +
   *      recompute its fade alpha from its LATCHED decay.
   *   3. (LIVE COLLIDE mode only — gate HIGH) Resolve inter-circle collisions:
   *      every pair whose DISCS overlap (EDGE detection, center distance ≤
   *      r1+r2 — unlike the center-based wall bounce) does an equal-mass
   *      ELASTIC bounce (swap the velocity components along the center-to-center
   *      normal) and is separated so they don't stick. This is an O(n²)
   *      pairwise pass, bounded by the 200-circle FIFO cap (~10k tests/frame).
   *      Gate LOW / unpatched → skipped entirely (circles pass through).
   *   4. Remove circles whose alpha has hit 0 (fully decayed). decay=0 circles
   *      never decay (they persist until the FIFO cap culls the oldest).
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

    // 2. Integrate + center-bounce + age/decay.
    const dts = dt / 1000;
    for (const c of this.circles) {
      // Position integration reads ONLY c.vx/c.vy (latched at spawn) — never
      // the live `spd` param — so each circle keeps its own independent speed.
      c.x += c.vx * dts;
      c.y += c.vy * dts;
      if (c.x < 0) { c.x = 0; c.vx = -c.vx; }
      else if (c.x > CIRCLES_FIELD) { c.x = CIRCLES_FIELD; c.vx = -c.vx; }
      if (c.y < 0) { c.y = 0; c.vy = -c.vy; }
      else if (c.y > CIRCLES_FIELD) { c.y = CIRCLES_FIELD; c.vy = -c.vy; }
      // Age + recompute fade alpha from the LATCHED decay.
      c.ageS = (c.ageS ?? 0) + dts;
      c.alpha = alphaFor(c.ageS, c.decayS ?? 0);
    }

    // 3. LIVE inter-circle collisions (COLLIDE gate HIGH only). O(n²) over the
    //    FIFO-capped list: each unordered pair whose DISCS overlap (EDGE test,
    //    center distance ≤ r1+r2) does an equal-mass elastic bounce + is
    //    separated. Skipped entirely when the gate is LOW/unpatched, so the
    //    pass-through behaviour (and its zero cost) is the default.
    if (this.params.collide) {
      const cs = this.circles;
      for (let i = 0; i < cs.length; i++) {
        const a = cs[i]!;
        for (let j = i + 1; j < cs.length; j++) {
          if (resolveElasticPair(a, cs[j]!)) this.collisionCount++;
        }
      }
    }

    // 4. Remove fully-decayed circles (alpha hit 0). decayS===0 never decays.
    for (let i = this.circles.length - 1; i >= 0; i--) {
      if ((this.circles[i]!.alpha ?? 1) <= 0) {
        this.circles.splice(i, 1);
        this.decayCount++;
      }
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

/** A circle's fade alpha, defaulting to 1 for plain {x,y,vx,vy,diameter} test
 *  discs that predate the decay fields (so all the derivation math degrades
 *  gracefully when alpha is absent). */
function alphaOf(c: Circle): number {
  return typeof c.alpha === 'number' ? c.alpha : 1;
}

/** How many circles cover the point (px,py)? A circle covers the point when
 *  the point is within its RADIUS of its center (filled disc). Fully-decayed
 *  circles (alpha 0) don't count. */
export function overlapCountAt(circles: readonly Circle[], px: number, py: number): number {
  let n = 0;
  for (const c of circles) {
    if (alphaOf(c) <= 0) continue;
    const r = c.diameter * 0.5;
    const dx = px - c.x;
    const dy = py - c.y;
    if (dx * dx + dy * dy <= r * r) n++;
  }
  return n;
}

/** Summed fade ALPHA of every circle covering the point — the "soft" overlap
 *  weight. A fully-alive disc adds 1; a half-faded one adds 0.5. Used to scale
 *  output INTENSITY by decay so a fading circle contributes less (and a lone
 *  fading circle visibly dims) while `overlapCountAt` still gives the integer
 *  stack depth that drives the hue ramp / the ≥2 mask rule. */
export function overlapAlphaAt(circles: readonly Circle[], px: number, py: number): number {
  let a = 0;
  for (const c of circles) {
    const ca = alphaOf(c);
    if (ca <= 0) continue;
    const r = c.diameter * 0.5;
    const dx = px - c.x;
    const dy = py - c.y;
    if (dx * dx + dy * dy <= r * r) a += ca;
  }
  return a;
}

/** `overlap` output value in [0,1]: the strongest covering circle's alpha
 *  (white where a full circle covers, fading to black as the only covering
 *  circle decays), 0 where nothing covers. */
export function overlapValueAt(circles: readonly Circle[], px: number, py: number): number {
  let best = 0;
  for (const c of circles) {
    const ca = alphaOf(c);
    if (ca <= best) continue;
    const r = c.diameter * 0.5;
    const dx = px - c.x;
    const dy = py - c.y;
    if (dx * dx + dy * dy <= r * r) best = ca;
  }
  return best;
}

/** Ring line-width for a circle's contour: 10% of its diameter, min 2 px. */
export function ringWidth(diameter: number): number {
  return Math.max(2, diameter * 0.1);
}

/** `contour` output value in [0,1]: the strongest (highest-alpha) circle whose
 *  outline ring (radial distance in [r − lw, r]) passes through the point —
 *  rings lighten as their circle decays. 0 off every ring. Outlines only — many
 *  circles produce "ripples in a pond". */
export function contourValueAt(circles: readonly Circle[], px: number, py: number): number {
  let best = 0;
  for (const c of circles) {
    const ca = alphaOf(c);
    if (ca <= best) continue;
    const r = c.diameter * 0.5;
    const lw = ringWidth(c.diameter);
    const dx = px - c.x;
    const dy = py - c.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= r && dist >= r - lw) best = ca;
  }
  return best;
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
  // Hue/sat come from the integer stack depth; brightness is additionally
  // scaled by the soft alpha weight (≤ count) so a fading stack visibly dims.
  const softFrac = Math.min(1, overlapAlphaAt(circles, px, py) / count);
  const [r, g, b] = hsvToRgb(combineHueAt(count), combineSaturationAt(count), combineBrightnessAt(count));
  return [r * softFrac, g * softFrac, b * softFrac];
}

/** `mapped` mask at a point: 1 where ≥2 circles overlap (show the video
 *  input there), else 0 (black). The module multiplies the video-input
 *  texture by this mask in the shader. */
export function mappedMaskAt(circles: readonly Circle[], px: number, py: number): number {
  return overlapCountAt(circles, px, py) >= 2 ? 1 : 0;
}
