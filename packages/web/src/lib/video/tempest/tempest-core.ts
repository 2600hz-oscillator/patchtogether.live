// packages/web/src/lib/video/tempest/tempest-core.ts
//
// TEMPEST geometry core (module P0) — the pure, GL-free heart of the playfield.
//
// Models the classic Tempest "well": a tube of N lanes whose OUTER rim (nearest
// the player) and centre vanishing point define a perspective tunnel. Everything
// here is deterministic + side-effect-free so it unit-tests without WebGL and
// renders identically for VRT. The renderer (P1) consumes these vertices; enemy /
// game logic (P2+) builds on the lane + depth model.
//
// Conventions:
//   • Coordinates are normalized clip-ish space, origin = tube centre (the far
//     vanishing point), rim ≈ unit extent. The renderer scales to the viewport.
//   • A LANE is one tube segment. A closed tube (circle/square/star) has N lanes
//     around a loop; lane i spans rim vertices i..i+1 (mod N).
//   • Player rim position + enemy lateral position are a CONTINUOUS lane coordinate
//     in [0, lanes) with wrap — matching the original's rotary-spinner control, so
//     a CV / gamepad-joystick axis drives it directly.
//   • DEPTH z ∈ [0,1]: 0 = far (centre/pit, where enemies spawn), 1 = rim (near
//     the player). Perspective is faked with easeOutQuad so motion accelerates
//     toward the rim, like the arcade.

export interface Vec2 {
  x: number;
  y: number;
}

/** Built-in tube cross-sections (a subset of the arcade's 8; more in P6). All
 *  are CLOSED loops of `lanes` rim vertices, centred at the origin, extent ≈ 1. */
export type TubeShape = 'circle' | 'square' | 'star';
export const TUBE_SHAPES: readonly TubeShape[] = ['circle', 'square', 'star'] as const;

/** Default lane count (the arcade used up to 16). */
export const DEFAULT_LANES = 16;
/** How far the pit (far end) sits from the centre as a fraction of the rim, so the
 *  tube has visible depth rather than collapsing to a point. */
export const PIT_SCALE = 0.12;

/** Perspective easing: f∈[0,1] → [0,1], accelerating toward 1 (the rim). Identical
 *  to the arcade's `1-(f-1)²`. easeOutQuad(0)=0, easeOutQuad(1)=1. */
export function easeOutQuad(f: number): number {
  const c = clamp01(f);
  return 1 - (1 - c) * (1 - c);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Wrap any real lane coordinate into [0, lanes). */
export function wrapLane(lane: number, lanes: number): number {
  const m = lane % lanes;
  return m < 0 ? m + lanes : m;
}

/** Map a continuous control value (CV / joystick, 0..1, wrapping) to a lane
 *  coordinate in [0, lanes). cv=0 → lane 0; cv=1 wraps back to 0. */
export function cvToLane(cv: number, lanes: number = DEFAULT_LANES): number {
  return wrapLane(cv * lanes, lanes);
}

/** Signed shortest angular distance from lane `from` to lane `to` around the loop,
 *  in (-lanes/2, lanes/2] — the direction + amount the claw should travel. */
export function shortestLaneDelta(from: number, to: number, lanes: number): number {
  let d = (to - from) % lanes;
  if (d < -lanes / 2) d += lanes;
  if (d > lanes / 2) d -= lanes;
  return d;
}

/** The `lanes` rim vertices of a tube shape (closed loop), centred at origin,
 *  extent ≈ 1. Optional per-lane `radii` (length `lanes`) scale each vertex's
 *  distance from centre — this is the AUDIO-BREATHING hook (P4): pass band
 *  magnitudes to pulse the tube. Without radii, the canonical shape is returned. */
export function rimVertices(shape: TubeShape, lanes: number = DEFAULT_LANES, radii?: readonly number[]): Vec2[] {
  const out: Vec2[] = new Array(lanes);
  for (let i = 0; i < lanes; i++) {
    const t = i / lanes; // 0..1 around the loop
    const base = shapePoint(shape, t);
    const r = radii && radii.length === lanes ? radii[i]! : 1;
    out[i] = { x: base.x * r, y: base.y * r };
  }
  return out;
}

/** Unit cross-section point at loop parameter t∈[0,1) for a given shape. */
function shapePoint(shape: TubeShape, t: number): Vec2 {
  const a = t * Math.PI * 2 - Math.PI / 2; // start at top, go clockwise
  switch (shape) {
    case 'circle':
      return { x: Math.cos(a), y: Math.sin(a) };
    case 'star': {
      // 8-point star: alternate full/inner radius.
      const points = 8;
      const phase = (t * points) % 1;
      const r = phase < 0.5 ? 1 : 0.5;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    }
    case 'square': {
      // Map the angle onto the unit square perimeter (Chebyshev normalize).
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      const m = Math.max(Math.abs(cx), Math.abs(cy)) || 1;
      return { x: cx / m, y: cy / m };
    }
  }
}

/** Linear interpolate the rim at a CONTINUOUS lane coordinate (for the claw / an
 *  enemy mid-lane). Wraps around the loop. */
export function rimAt(rim: readonly Vec2[], lane: number): Vec2 {
  const n = rim.length;
  const l = wrapLane(lane, n);
  const i = Math.floor(l);
  const f = l - i;
  const a = rim[i]!;
  const b = rim[(i + 1) % n]!;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Project a point at (continuous `lane`, depth `z`) into screen space: the rim
 *  vertex scaled toward the pit by the perspective curve. z=1 → on the rim; z=0 →
 *  at the pit (PIT_SCALE of the rim). This is the single mapping the renderer uses
 *  for the claw, enemies, projectiles, and the tube walls. */
export function projectToScreen(
  rim: readonly Vec2[],
  lane: number,
  z: number,
  pitScale: number = PIT_SCALE,
): Vec2 {
  const p = rimAt(rim, lane);
  const s = pitScale + (1 - pitScale) * easeOutQuad(z);
  return { x: p.x * s, y: p.y * s };
}

/** Scale a point radially from the tube centre (origin). k>1 pushes it OUTSIDE
 *  the rim (toward the player), k<1 pulls it toward the centre. */
export function scaleRadial(p: Vec2, k: number): Vec2 {
  return { x: p.x * k, y: p.y * k };
}

/** One claw line segment in normalized tube space (origin-centred, extent ≈ 1) —
 *  the same space `projectToScreen` returns, so the renderer aspect-fits + glows
 *  it exactly like the tube lines. */
export interface ClawSeg {
  a: Vec2;
  b: Vec2;
}

/** Tunable CLAW geometry. All fields default (see CLAW_DEFAULTS) and exist so the
 *  owner can refine the ship's silhouette from a preview without touching math. */
export interface ClawSpec {
  /** Radial scale of the prong tips past the rim (1 = on the rim, >1 = outside,
   *  toward the player — the "splay outward past the rim"). */
  out?: number;
  /** How far the prong tips fan past their lane boundary, in LANE units. */
  widen?: number;
  /** Depth z the body blades reach INTO the tube (1 = rim, 0 = pit). */
  bodyDepth?: number;
  /** Lane inset of the open mouth from each lane boundary, in LANE units (the gap
   *  between the two blade tips = the claw's open end facing into the tube). */
  mouthInset?: number;
}

export const CLAW_DEFAULTS: Required<ClawSpec> = {
  out: 1.08,
  widen: 0.18,
  bodyDepth: 0.5,
  mouthInset: 0.28,
};

/** Build the player CLAW spanning the near-rim lane the CV selects, as a list of
 *  line segments in normalized tube space. A recognisable Tempest claw/blaster:
 *
 *      tipL          tipR        ← two outer prongs, splayed OUTWARD past the rim
 *        \            /              (toward the player)
 *       cornerL====cornerR        ← back bar across the rim (the closed back)
 *         \          /
 *          inL  ..  inR           ← two body blades into the tube, OPEN mouth
 *                                    between them (the firing end, faces the pit)
 *
 *  `lane` is the CONTINUOUS rim coordinate (cvToLane); the claw snaps to the
 *  integer lane segment [li, li+1] it sits in, so it tracks the rim CV. Pure +
 *  GL-free so it unit-tests; the renderer expands each segment into a glow quad. */
export function buildClawSegments(
  rim: readonly Vec2[],
  lane: number,
  lanes: number = rim.length,
  spec: ClawSpec = {},
): ClawSeg[] {
  const { out, widen, bodyDepth, mouthInset } = { ...CLAW_DEFAULTS, ...spec };
  const li = Math.floor(wrapLane(lane, lanes));
  const ri = li + 1;
  // Rim corners at the lane boundaries (z=1 → exactly on the rim).
  const cornerL = projectToScreen(rim, li, 1);
  const cornerR = projectToScreen(rim, ri, 1);
  // Prong tips: a touch past each boundary in lane AND radially outside the rim.
  const tipL = scaleRadial(rimAt(rim, li - widen), out);
  const tipR = scaleRadial(rimAt(rim, ri + widen), out);
  // Body blades reaching into the tube; the gap between inL/inR is the open mouth.
  const inL = projectToScreen(rim, li + mouthInset, bodyDepth);
  const inR = projectToScreen(rim, ri - mouthInset, bodyDepth);
  return [
    { a: cornerL, b: tipL }, // left outer prong (splays outward, past the rim)
    { a: cornerR, b: tipR }, // right outer prong
    { a: cornerL, b: cornerR }, // back bar across the rim (closed back)
    { a: cornerL, b: inL }, // left body blade into the tube
    { a: cornerR, b: inR }, // right body blade into the tube
  ];
}

/** Audio-breathing hook (P4): turn analyser band magnitudes (0..~1) into per-lane
 *  rim radii. `base` is the resting radius; `depth` how far bands push it. One
 *  band per lane; fewer/more bands are resampled by nearest index. */
export function bandsToRadii(
  bands: ArrayLike<number>,
  lanes: number = DEFAULT_LANES,
  base = 1,
  depth = 0.4,
): number[] {
  const out: number[] = new Array(lanes);
  for (let i = 0; i < lanes; i++) {
    const bi = bands.length ? Math.min(bands.length - 1, Math.floor((i / lanes) * bands.length)) : 0;
    const b = bands.length ? clamp01(bands[bi]!) : 0;
    out[i] = base + b * depth;
  }
  return out;
}
