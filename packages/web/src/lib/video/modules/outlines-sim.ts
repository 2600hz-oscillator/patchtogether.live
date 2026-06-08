// packages/web/src/lib/video/modules/outlines-sim.ts
//
// OUTLINES — pure, WebGL-free particle simulation + output-derivation math.
//
// Split out from the module def (outlines.ts) so the entire stateful sim —
// seeded spawn, velocity integration, center-point bounce, per-shape latched
// d/v/spd/decay/SHAPE, the internal rate clock, the live-global ROTATION, the
// max-shape cull — and the per-output derivation (overlap count → overlap /
// combine-hue / mapped mask, plus the contour ring test) are testable WITHOUT
// a WebGL2 context or a canvas. outlines.ts owns ONLY the GL plumbing (4 FBOs
// + the 2D canvas paint + texture upload); every numeric decision lives here.
//
// (Was CIRCLES — renamed OUTLINES when the SHAPE selector landed: a shape can
// now be a CIRCLE *or* a regular N-gon — triangle / square / pentagon /
// hexagon / octagon — inscribed in the same diameter (circumradius = d/2),
// plus a live-global ROTATION that spins every shape coherently. The legacy
// circle is shape index 0.)
//
// Determinism: spawn position + each shape's initial rotation angle come from a
// seeded mulberry32 PRNG (shared rack PRNG, byte-identical across engines),
// NEVER Math.random(). A fixed default seed + deterministic frame-stepping make
// the VRT / per-port / behavioral sweeps reproducible. Construct an OutlinesSim
// with an explicit seed in tests and call step(dt) to advance frame-by-frame.

import { mulberry32 } from '$lib/sync/prng';

// ---------------------------------------------------------------------------
// Constants — the field, the param ranges, and the safety cap.
// ---------------------------------------------------------------------------

/** The square render field, in pixels. Matches the spec's "1024-px field".
 *  The video engine's FBO is 1024×768 (4:3); we sim + render the shapes in
 *  a 1024×1024 logical field and the GL upload aspect-fits it like every
 *  other source (the 2D scene canvas is square; the fullscreen quad samples
 *  it). Keeping the sim square means the bounce math is symmetric. */
export const OUTLINES_FIELD = 1024;

/** Shape DIAMETER range (px). `d` knob/CV 0..1 → [MIN, MAX]. MAX is 270 px
 *  (3× the original 90) so shapes can grow large enough to dominate the
 *  1024-px field. For polygons this is the CIRCUMDIAMETER (every vertex lies
 *  on the circle of radius d/2). */
export const D_MIN = 5;
export const D_MAX = 270;

/** SPEED range (px/s). `spd` knob/CV 0..1 → [0, MAX]. 300  px/s crosses the
 *  1024 field in ~3.4 s. */
export const SPD_MAX = 300;

/** DECAY range (seconds). `decay` knob/CV 0..1 → [0, MAX]. 0 s = NO decay
 *  (the shape persists until the FIFO cap culls it — the static-field use
 *  case); up to 10 s means the shape fades (alpha 1 → 0) and is removed over
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

/** Max simultaneous shapes. Shapes bounce forever (never leave the field)
 *  so under continuous spawning they accumulate unbounded; we cap the active
 *  list and cull the OLDEST when a spawn would exceed it, keeping per-frame
 *  cost bounded. 200 keeps the "ripples in a pond" contour look dense while
 *  the per-pixel count buffer stays cheap. It also BOUNDS the COLLIDE mode's
 *  O(n²) pairwise check: 200² ≈ 20k distance tests/frame (the inner half is
 *  ~10k) — cheap enough to run inline without spatial hashing. */
export const MAX_CIRCLES = 200;

// ---------------------------------------------------------------------------
// SHAPE — a discrete selector over [circle, triangle, square, pentagon,
// hexagon, octagon]. Each non-circle shape is a REGULAR polygon inscribed in
// the diameter (every vertex on the circle of radius d/2 — circumradius = d/2),
// so the bounding-circle collision radius (d/2) is valid unchanged. Index 0 is
// the legacy CIRCLE (smooth — treated specially everywhere as the disc path).
// ---------------------------------------------------------------------------

/** Sides per shape index. Index 0 = circle (0 sides → the smooth-disc path).
 *  1=triangle(3) 2=square(4) 3=pentagon(5) 4=hexagon(6) 5=octagon(8). */
export const SHAPE_SIDES: readonly number[] = [0, 3, 4, 5, 6, 8];

/** Number of selectable shapes. */
export const SHAPE_COUNT = SHAPE_SIDES.length;

/** Map a shape index (clamped to 0..SHAPE_COUNT-1, rounded) → its side count. */
export function sidesForShape(shape: number): number {
  const i = shape < 0 ? 0 : shape >= SHAPE_COUNT ? SHAPE_COUNT - 1 : Math.round(shape);
  return SHAPE_SIDES[i]!;
}

/** Is this a smooth circle (index 0 → sides 0)? */
export function isCircleShape(shape: number): boolean {
  return sidesForShape(shape) === 0;
}

/** `shape` 0..1 (knob/CV) → a discrete shape INDEX in [0, SHAPE_COUNT-1].
 *  Quantises the continuous knob into the N equal buckets so a CV ramp steps
 *  cleanly through circle → triangle → … → octagon. */
export function mapShape(shape01: number): number {
  const s = clamp01(shape01);
  // N buckets: floor(s × N) clamped to the last bucket at exactly 1.0.
  return Math.min(SHAPE_COUNT - 1, Math.floor(s * SHAPE_COUNT));
}

// ---------------------------------------------------------------------------
// ROTATION — a LIVE GLOBAL angular velocity (NOT spawn-latched). Bipolar: the
// knob/CV center (0.5) = 0 rad/s (no spin), left extreme (0) = fast CCW, right
// extreme (1) = fast CW. Every live shape shares one global rotation angle that
// advances by this velocity each step, so the WHOLE field spins coherently.
// ---------------------------------------------------------------------------

/** Max spin speed at either extreme, rad/s. ~2 full turns/s at the extremes —
 *  fast but legible at 60fps. */
export const ROT_MAX_RAD_S = Math.PI * 2 * 2;

/** Default rotation knob = center (no spin). */
export const ROT_CENTER = 0.5;

/** `rotation` 0..1 (knob/CV) → angular velocity in rad/s, BIPOLAR around the
 *  0.5 center. center → 0; >0.5 → positive (CW in screen space, y-down);
 *  <0.5 → negative (CCW). Linear in each half so the extremes hit ±ROT_MAX. */
export function mapAngularVel(rot01: number): number {
  const r = clamp01(rot01);
  // Remap [0,1] → [-1,1] (center 0.5 → 0), scale by the max.
  return (r - ROT_CENTER) * 2 * ROT_MAX_RAD_S;
}

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
 * A shape's fade alpha in [0,1] from its age + LATCHED decay duration (both
 * seconds). `decayS <= 0` → no decay (always 1, the persist case). Otherwise a
 * linear ramp: alpha = 1 at spawn, 0 once age ≥ decayS. The shape is removed
 * when this hits 0; the four outputs scale their contribution by it while alive
 * (a fading shape adds less to the overlap COUNT / draws a lighter contour).
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
 * "1 shape / 500 ms" cap) at rate=1. The interval can never go below the
 * cap, so the spawn rate is hard-limited regardless of knob/curve.
 */
export function mapRateIntervalMs(rate01: number): number | null {
  const r = clamp01(rate01);
  if (r <= RATE_ENGAGE_THRESHOLD) return null;
  const interval = RATE_SLOW_INTERVAL_MS + r * (RATE_MIN_INTERVAL_MS - RATE_SLOW_INTERVAL_MS);
  return Math.max(RATE_MIN_INTERVAL_MS, interval);
}

// ---------------------------------------------------------------------------
// Shape state.
// ---------------------------------------------------------------------------

export interface Circle {
  /** Center x in [0, OUTLINES_FIELD]. */
  x: number;
  /** Center y in [0, OUTLINES_FIELD]. */
  y: number;
  /** Velocity px/s. LATCHED at spawn (cos/sin of the spawn angle × the spawn
   *  speed); integration reads ONLY this stored velocity, so a later `spd`/`v`
   *  knob change affects NEW shapes only — never this one. */
  vx: number;
  vy: number;
  /** LATCHED diameter px (snapshot of `d` at spawn). For a polygon this is the
   *  CIRCUMDIAMETER — every vertex lies on the circle of radius diameter/2. */
  diameter: number;
  /** LATCHED decay duration in SECONDS (snapshot of `decay` at spawn).
   *  0 = no decay (persist until FIFO-culled). Optional so plain test discs
   *  (and any legacy {x,y,vx,vy,diameter}) remain valid; the sim always sets it
   *  + treats an absent value as 0 (persist). */
  decayS?: number;
  /** Seconds since this shape spawned (advanced by step). Optional; absent = 0. */
  ageS?: number;
  /** Current alpha in [0,1]: 1 while alive, ramping to 0 over `decayS` seconds.
   *  Always 1 when decayS===0. All four outputs scale their contribution by
   *  this (a fading shape counts less toward overlap / draws a lighter ring).
   *  Recomputed each step from ageS/decayS. Optional; absent = 1 (alive). */
  alpha?: number;
  /** LATCHED shape INDEX (snapshot of `shape` at spawn). 0 = circle; 1..5 =
   *  triangle/square/pentagon/hexagon/octagon. Optional; absent = 0 (circle),
   *  so legacy {x,y,vx,vy,diameter} discs degrade to the smooth disc. */
  shape?: number;
  /** LATCHED side count for the shape (0 = circle). Cached from `shape` at spawn
   *  so the per-pixel derivation doesn't re-derive it each sample. Optional;
   *  absent → derived from `shape`. */
  sides?: number;
  /** DETERMINISTIC per-shape initial rotation angle (radians), seeded at spawn
   *  from the RNG so a field of polygons isn't all axis-aligned. The rendered /
   *  derived angle is baseAngle + the live-global rotation accumulator. A circle
   *  is rotation-invariant, so this is irrelevant for shape 0. Optional;
   *  absent = 0. */
  baseAngle?: number;
}

/** Per-frame param snapshot the sim reads when it spawns. These are the
 *  module's live knob+CV values; each spawned shape LATCHES the per-shape ones
 *  (d/v/spd/decay/SHAPE), so later changes affect only NEW shapes. ROTATION is
 *  a LIVE GLOBAL (not latched) read every frame. */
export interface CirclesSpawnParams {
  /** 0..1 — shape diameter. */
  d: number;
  /** 0..1 — spawn vector angle. */
  v: number;
  /** 0..1 — speed. */
  spd: number;
  /** 0..1 — internal-clock rate (0 = gate-only). */
  rate: number;
  /** 0..1 — fade-out duration (0 / omitted = persist, no decay). */
  decay?: number;
  /** 0..1 — SHAPE selector (quantised to a discrete index at spawn). Latched
   *  per shape like d/v/spd/decay. Omitted = circle (index 0). */
  shape?: number;
  /** 0..1 — ROTATION (bipolar around 0.5). A LIVE GLOBAL angular velocity (NOT
   *  latched per shape): every live shape shares one rotation angle advanced by
   *  mapAngularVel(rotation) each frame. center (0.5) = no spin. Omitted = no
   *  spin (treated as center). */
  rotation?: number;
  /** LIVE GLOBAL inter-shape collision mode (NOT latched per shape). When
   *  truthy, every pair of shapes whose bounding circles overlap (center
   *  distance ≤ r1+r2) this frame does an equal-mass ELASTIC bounce; when falsy
   *  (the default, unpatched / gate LOW) shapes pass through each other.
   *  Toggled live each frame from the COLLIDE gate. */
  collide?: boolean;
}

// ---------------------------------------------------------------------------
// Inter-shape ELASTIC collision (the COLLIDE gate mode). The bounding-circle
// radius is diameter/2 = the CIRCUMRADIUS for every shape (circle or N-gon),
// which fully contains the shape, so this disc test is a valid (slightly
// conservative — it fires when the circumcircles touch, just before polygon
// edges necessarily do) collision for all shapes with ZERO change.
// ---------------------------------------------------------------------------

/**
 * EDGE-based pair test: two shapes collide when the distance between their
 * CENTERS is ≤ (r1 + r2) — i.e. their bounding DISCS (circumcircles) touch /
 * overlap. This is the key difference from the existing WALL bounce, which is
 * purely center-based (the center crossing the wall). Returns true when the two
 * bounding discs intersect.
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
 * shapes exchange the velocity component projected onto that normal; the
 * tangential components are untouched. (For equal masses this is the standard
 * result — the normal-velocity components swap.) Each shape therefore keeps
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
  // is applied to each shape's normal-projected velocity.
  const exchange = vb - va;
  a.vx += exchange * ux;
  a.vy += exchange * uy;
  b.vx -= exchange * ux;
  b.vy -= exchange * uy;

  // Positional de-overlap: push each shape half the penetration along the
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
// Regular-polygon geometry — point-in-shape + distance-to-edge, used by BOTH
// the per-pixel output derivation AND (the same math) the 2D canvas paint. A
// regular N-gon is the intersection of N half-planes, one per edge; the edge
// at index k has outward NORMAL n_k = (cos φ_k, sin φ_k) where
// φ_k = angle + 2πk/N + π/N (the edge normals sit HALFWAY between consecutive
// vertices), and the edge plane is { p : p·n_k = apothem }, apothem =
// circumradius·cos(π/N).
//
// A point is inside the polygon iff its projection onto EVERY edge normal is
// ≤ apothem; the polygon "radial distance" (for the contour ring band) is the
// MAX of those projections — it equals `apothem` exactly on an edge, less
// inside, more outside — i.e. a polygon analogue of the circle's |p-center|.
// ---------------------------------------------------------------------------

/** Max projection of the point (lx,ly) — RELATIVE TO THE SHAPE CENTER — onto
 *  the N edge normals of a regular N-gon rotated by `angle`. A point is inside
 *  iff this ≤ apothem; on an edge when == apothem. (Only meaningful for
 *  sides ≥ 3; callers use the disc test for the circle case.) */
function polyRadius(lx: number, ly: number, sides: number, angle: number): number {
  let maxProj = -Infinity;
  const step = (Math.PI * 2) / sides;
  for (let k = 0; k < sides; k++) {
    const phi = angle + step * k + step * 0.5; // edge normal halfway between verts
    const proj = lx * Math.cos(phi) + ly * Math.sin(phi);
    if (proj > maxProj) maxProj = proj;
  }
  return maxProj;
}

/** Apothem (inradius) of a regular N-gon whose circumradius is `circumR`. */
function apothemOf(sides: number, circumR: number): number {
  return circumR * Math.cos(Math.PI / sides);
}

/** Is the point (px,py) inside the shape `c` (rotated by the global `rot` plus
 *  the shape's seeded baseAngle)? Circle (sides 0) → the disc test; polygon →
 *  inside-all-edge-planes. */
export function pointInShape(c: Circle, px: number, py: number, rot = 0): boolean {
  const r = c.diameter * 0.5;
  const dx = px - c.x;
  const dy = py - c.y;
  const sides = c.sides ?? sidesForShape(c.shape ?? 0);
  if (sides < 3) {
    // Circle: |p - center| ≤ r.
    return dx * dx + dy * dy <= r * r;
  }
  const angle = (c.baseAngle ?? 0) + rot;
  const apo = apothemOf(sides, r);
  return polyRadius(dx, dy, sides, angle) <= apo;
}

/** Is the point on the shape's CONTOUR ring band (radial distance in
 *  [edge − lw, edge])? For a circle the "edge" is the radius r; for a polygon
 *  it's the apothem (the perpendicular distance from center to an edge). The
 *  ring band is measured along the polygon's own radial metric (polyRadius),
 *  so the band hugs the straight edges. */
export function pointOnShapeRing(c: Circle, px: number, py: number, lw: number, rot = 0): boolean {
  const r = c.diameter * 0.5;
  const dx = px - c.x;
  const dy = py - c.y;
  const sides = c.sides ?? sidesForShape(c.shape ?? 0);
  if (sides < 3) {
    // Circle ring: dist in [r − lw, r].
    const dist = Math.sqrt(dx * dx + dy * dy);
    return dist <= r && dist >= r - lw;
  }
  const angle = (c.baseAngle ?? 0) + rot;
  const apo = apothemOf(sides, r);
  const pr = polyRadius(dx, dy, sides, angle);
  return pr <= apo && pr >= apo - lw;
}

/** The N vertex positions of a polygon shape (absolute field coords), rotated
 *  by the global `rot` + the shape's baseAngle. Used by the 2D canvas paint to
 *  stroke/fill the polygon path. Returns [] for a circle (caller uses arc()). */
export function shapeVertices(c: Circle, rot = 0): Array<[number, number]> {
  const sides = c.sides ?? sidesForShape(c.shape ?? 0);
  if (sides < 3) return [];
  const r = c.diameter * 0.5;
  const angle = (c.baseAngle ?? 0) + rot;
  const step = (Math.PI * 2) / sides;
  const verts: Array<[number, number]> = [];
  for (let k = 0; k < sides; k++) {
    const a = angle + step * k;
    verts.push([c.x + Math.cos(a) * r, c.y + Math.sin(a) * r]);
  }
  return verts;
}

// ---------------------------------------------------------------------------
// The simulation.
// ---------------------------------------------------------------------------

export class OutlinesSim {
  /** Active shapes, oldest first (so cull-oldest = shift()). */
  readonly circles: Circle[] = [];

  /** Live spawn params (the module pushes knob/CV changes here each frame). */
  private params: CirclesSpawnParams = { d: 0.5, v: 0, spd: 0.5, rate: 0, decay: 0, shape: 0, rotation: ROT_CENTER, collide: false };

  /** LIVE GLOBAL rotation angle (radians) — advanced each step by the rotation
   *  param's mapped angular velocity. Shared by EVERY shape (added to each
   *  shape's seeded baseAngle), so the whole field spins coherently. Read by the
   *  module (rotationAngle getter) for the canvas paint + passed to the
   *  derivation helpers so every output reflects the same spin. */
  private globalRot = 0;

  /** Total pair-collisions resolved (monotonic; for tests/telemetry). */
  collisionCount = 0;

  /** Seeded PRNG — drives spawn position + per-shape baseAngle ONLY.
   *  Deterministic per seed. */
  private rng: () => number;

  /** Accumulator (ms) for the internal rate clock. */
  private rateAccumMs = 0;

  /** Total shapes ever spawned (monotonic; for tests/telemetry). */
  spawnCount = 0;

  /** Total shapes culled by the cap (monotonic; for tests/telemetry). */
  cullCount = 0;

  /** Total shapes removed by decay (alpha→0) (monotonic; tests/telemetry). */
  decayCount = 0;

  constructor(seed = 0x0c1c1e5) {
    this.rng = mulberry32(seed | 0);
  }

  /** Replace the live spawn params (called by the module each frame from the
   *  current knob+CV values). Does NOT retro-affect already-spawned shapes
   *  (except ROTATION, which is a live global applied to all). */
  setParams(p: CirclesSpawnParams): void {
    this.params = p;
  }

  /** The current live-global rotation angle (radians). The module reads this to
   *  paint each shape at baseAngle + this; the derivation helpers take it as the
   *  `rot` argument so every output reflects the SAME spin. */
  get rotationAngle(): number {
    return this.globalRot;
  }

  /**
   * Spawn ONE shape at a seeded-random position in the field, moving in the
   * current `v` direction at the current `spd`, latching the current `d`,
   * `decay` and `shape`, with a seeded initial rotation `baseAngle`.
   * Enforces the max-shape cap by culling the oldest first.
   *
   * `spd=0` → a static shape (vx=vy=0) scattered at the random position.
   */
  spawn(): Circle {
    const diameter = mapDiameter(this.params.d);
    const angle = mapAngle(this.params.v);
    const speed = mapSpeed(this.params.spd);
    const decayS = mapDecay(this.params.decay ?? 0);
    const shape = mapShape(this.params.shape ?? 0);
    const sides = sidesForShape(shape);
    // Latch EVERYTHING per-shape at spawn (d, v→angle, spd→velocity, decay,
    // SHAPE). Integration reads only the stored velocity, so a later spd/v/shape
    // change can't retro-affect an existing shape — it keeps its own latched
    // properties for its whole life. NOTE: x, y AND baseAngle each consume one
    // rng() draw, in that fixed order, so the seeded sequence is deterministic.
    const x = this.rng() * OUTLINES_FIELD;
    const y = this.rng() * OUTLINES_FIELD;
    const baseAngle = this.rng() * Math.PI * 2;
    const c: Circle = {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      diameter,
      decayS,
      ageS: 0,
      alpha: 1,
      shape,
      sides,
      baseAngle,
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
   * Spawn a shape on a gate event. Returns the new shape. The module owns
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
   *   2. Advance the LIVE GLOBAL rotation angle by the rotation param's mapped
   *      angular velocity × dt (bipolar; center = no spin). Shared by every
   *      shape so the whole field spins coherently — reflected in the rendered
   *      geometry AND every output via the derivation helpers' `rot` arg.
   *   3. Integrate every shape's position from its LATCHED velocity (never the
   *      live `spd`), bounce when its CENTER crosses a wall (reflect the
   *      matching velocity component, clamp center into the field). No
   *      edge/radius collision math for the WALL — the CENTER bounces, the
   *      visible shape may briefly overhang the wall. Then age each shape +
   *      recompute its fade alpha from its LATCHED decay.
   *   4. (LIVE COLLIDE mode only — gate HIGH) Resolve inter-shape collisions:
   *      every pair whose bounding DISCS overlap (EDGE detection, center
   *      distance ≤ r1+r2) does an equal-mass ELASTIC bounce + is separated.
   *      Gate LOW / unpatched → skipped entirely (shapes pass through).
   *   5. Remove shapes whose alpha has hit 0 (fully decayed). decay=0 shapes
   *      never decay (they persist until the FIFO cap culls the oldest).
   *
   * Returns the number of shapes spawned by the internal clock this step.
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

    const dts = dt / 1000;

    // 2. LIVE GLOBAL rotation: advance the shared angle by the bipolar angular
    //    velocity (center = 0 → no change). Wrap into (-2π, 2π) so it can't grow
    //    unbounded over a long session (cos/sin are periodic, but a finite
    //    accumulator keeps it numerically clean).
    const av = mapAngularVel(this.params.rotation ?? ROT_CENTER);
    if (av !== 0) {
      this.globalRot += av * dts;
      const TWO_PI = Math.PI * 2;
      if (this.globalRot >= TWO_PI || this.globalRot <= -TWO_PI) {
        this.globalRot %= TWO_PI;
      }
    }

    // 3. Integrate + center-bounce + age/decay.
    for (const c of this.circles) {
      // Position integration reads ONLY c.vx/c.vy (latched at spawn) — never
      // the live `spd` param — so each shape keeps its own independent speed.
      c.x += c.vx * dts;
      c.y += c.vy * dts;
      if (c.x < 0) { c.x = 0; c.vx = -c.vx; }
      else if (c.x > OUTLINES_FIELD) { c.x = OUTLINES_FIELD; c.vx = -c.vx; }
      if (c.y < 0) { c.y = 0; c.vy = -c.vy; }
      else if (c.y > OUTLINES_FIELD) { c.y = OUTLINES_FIELD; c.vy = -c.vy; }
      // Age + recompute fade alpha from the LATCHED decay.
      c.ageS = (c.ageS ?? 0) + dts;
      c.alpha = alphaFor(c.ageS, c.decayS ?? 0);
    }

    // 4. LIVE inter-shape collisions (COLLIDE gate HIGH only). O(n²) over the
    //    FIFO-capped list: each unordered pair whose bounding DISCS overlap
    //    (EDGE test, center distance ≤ r1+r2) does an equal-mass elastic bounce
    //    + is separated. Skipped entirely when the gate is LOW/unpatched, so the
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

    // 5. Remove fully-decayed shapes (alpha hit 0). decayS===0 never decays.
    for (let i = this.circles.length - 1; i >= 0; i--) {
      if ((this.circles[i]!.alpha ?? 1) <= 0) {
        this.circles.splice(i, 1);
        this.decayCount++;
      }
    }

    return clockSpawns;
  }

  /** Active shape count. */
  get count(): number {
    return this.circles.length;
  }
}

/** Back-compat alias for the pre-rename class name (was CIRCLES). New code uses
 *  `OutlinesSim`; this keeps any straggling `CirclesSim` import resolving. */
export { OutlinesSim as CirclesSim };

// ---------------------------------------------------------------------------
// Output-derivation math — pure functions over the shape list + a sample
// point + the live-global rotation angle. outlines.ts renders these per-pixel
// on the 2D scene canvases (passing the sim's rotationAngle); the unit suite
// asserts them point-wise without a canvas. Passing `rot` makes EVERY output
// (overlap / contour / combine / mapped) reflect the same spin as the rendered
// geometry.
// ---------------------------------------------------------------------------

/** A shape's fade alpha, defaulting to 1 for plain {x,y,vx,vy,diameter} test
 *  discs that predate the decay fields (so all the derivation math degrades
 *  gracefully when alpha is absent). */
function alphaOf(c: Circle): number {
  return typeof c.alpha === 'number' ? c.alpha : 1;
}

/** How many shapes cover the point (px,py)? A shape covers the point when the
 *  point is inside it (disc for a circle, polygon for an N-gon, rotated by the
 *  live-global `rot` + the shape's baseAngle). Fully-decayed shapes (alpha 0)
 *  don't count. */
export function overlapCountAt(circles: readonly Circle[], px: number, py: number, rot = 0): number {
  let n = 0;
  for (const c of circles) {
    if (alphaOf(c) <= 0) continue;
    if (pointInShape(c, px, py, rot)) n++;
  }
  return n;
}

/** Summed fade ALPHA of every shape covering the point — the "soft" overlap
 *  weight. A fully-alive shape adds 1; a half-faded one adds 0.5. Used to scale
 *  output INTENSITY by decay so a fading shape contributes less (and a lone
 *  fading shape visibly dims) while `overlapCountAt` still gives the integer
 *  stack depth that drives the hue ramp / the ≥2 mask rule. */
export function overlapAlphaAt(circles: readonly Circle[], px: number, py: number, rot = 0): number {
  let a = 0;
  for (const c of circles) {
    const ca = alphaOf(c);
    if (ca <= 0) continue;
    if (pointInShape(c, px, py, rot)) a += ca;
  }
  return a;
}

/** `overlap` output value in [0,1]: the strongest covering shape's alpha
 *  (white where a full shape covers, fading to black as the only covering
 *  shape decays), 0 where nothing covers. */
export function overlapValueAt(circles: readonly Circle[], px: number, py: number, rot = 0): number {
  let best = 0;
  for (const c of circles) {
    const ca = alphaOf(c);
    if (ca <= best) continue;
    if (pointInShape(c, px, py, rot)) best = ca;
  }
  return best;
}

/** Ring line-width for a shape's contour: 10% of its diameter, min 2 px. */
export function ringWidth(diameter: number): number {
  return Math.max(2, diameter * 0.1);
}

/** `contour` output value in [0,1]: the strongest (highest-alpha) shape whose
 *  outline ring (the band just inside the edge) passes through the point —
 *  rings lighten as their shape decays. 0 off every ring. Outlines only — many
 *  shapes produce "ripples in a pond". */
export function contourValueAt(circles: readonly Circle[], px: number, py: number, rot = 0): number {
  let best = 0;
  for (const c of circles) {
    const ca = alphaOf(c);
    if (ca <= best) continue;
    const lw = ringWidth(c.diameter);
    if (pointOnShapeRing(c, px, py, lw, rot)) best = ca;
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
export function combineRgbAt(circles: readonly Circle[], px: number, py: number, rot = 0): [number, number, number] {
  const count = overlapCountAt(circles, px, py, rot);
  if (count < 1) return [0, 0, 0];
  // Hue/sat come from the integer stack depth; brightness is additionally
  // scaled by the soft alpha weight (≤ count) so a fading stack visibly dims.
  const softFrac = Math.min(1, overlapAlphaAt(circles, px, py, rot) / count);
  const [r, g, b] = hsvToRgb(combineHueAt(count), combineSaturationAt(count), combineBrightnessAt(count));
  return [r * softFrac, g * softFrac, b * softFrac];
}

/** `mapped` mask at a point: 1 where ≥2 shapes overlap (show the video
 *  input there), else 0 (black). The module multiplies the video-input
 *  texture by this mask in the shader. */
export function mappedMaskAt(circles: readonly Circle[], px: number, py: number, rot = 0): number {
  return overlapCountAt(circles, px, py, rot) >= 2 ? 1 : 0;
}
