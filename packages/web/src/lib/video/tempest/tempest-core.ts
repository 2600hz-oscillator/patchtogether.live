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
