// packages/web/src/lib/video/modules/spirographs-math.ts
//
// SPIROGRAPHS — pure, GPU-free curve + motion math. This is the deterministic
// correctness core: the parametric hypotrochoid / epitrochoid point functions,
// the "how many revolutions until the figure closes" derivation, and the
// bounding-box constrain/reflect that keeps each spiro's FIXED-radius circle
// fully inside the frame (rolling/bouncing off the perimeter like a real
// spirograph constrained to the page).
//
// NO canvas, NO GL, NO state beyond what's passed in. Every function here is
// a pure function — unit-tested in spirographs.test.ts. The Canvas2D renderer
// (spirographs-draw.ts) and the GL-texture module (spirographs.ts) consume
// these; the draw layer is the only place pixels happen.
//
// THE CLASSIC SPIROGRAPH CURVES (a pen at offset p in a rolling circle of
// radius r that rolls without slipping on/in a fixed circle of radius R):
//
//   • HYPOTROCHOID (rolling circle INSIDE the fixed one):
//       x = (R − r) cos t + p cos(((R − r) / r) t)
//       y = (R − r) sin t − p sin(((R − r) / r) t)
//   • EPITROCHOID (rolling circle OUTSIDE the fixed one):
//       x = (R + r) cos t − p cos(((R + r) / r) t)
//       y = (R + r) sin t − p sin(((R + r) / r) t)
//
// These produce curves in "spiro space" centred on the origin; the renderer
// then applies rotation, scale, and the per-spiro center offset.

/** Which family of trochoid a spiro draws. `inside` (hypotrochoid) vs
 *  `outside` (epitrochoid). The module's `inside` param is a 0/1 toggle that
 *  maps to this. */
export type SpiroKind = 'inside' | 'outside';

/** A 2D point in spiro space (origin-centred, units of the radii). */
export interface Pt {
  x: number;
  y: number;
}

/**
 * Hypotrochoid point at parameter `t` (rolling circle INSIDE the fixed one).
 *   x = (R − r) cos t + p cos(k t),  y = (R − r) sin t − p sin(k t),  k=(R−r)/r
 * Pure. `r` of 0 is degenerate (division by zero) — callers clamp r away from
 * 0 before calling; we guard it here too so a stray 0 yields a finite point.
 */
export function hypotrochoid(R: number, r: number, p: number, t: number): Pt {
  const rr = r === 0 ? 1e-6 : r;
  const d = R - rr;
  const k = d / rr;
  return {
    x: d * Math.cos(t) + p * Math.cos(k * t),
    y: d * Math.sin(t) - p * Math.sin(k * t),
  };
}

/**
 * Epitrochoid point at parameter `t` (rolling circle OUTSIDE the fixed one).
 *   x = (R + r) cos t − p cos(k t),  y = (R + r) sin t − p sin(k t),  k=(R+r)/r
 * Pure. Same r=0 guard as hypotrochoid.
 */
export function epitrochoid(R: number, r: number, p: number, t: number): Pt {
  const rr = r === 0 ? 1e-6 : r;
  const d = R + rr;
  const k = d / rr;
  return {
    x: d * Math.cos(t) - p * Math.cos(k * t),
    y: d * Math.sin(t) - p * Math.sin(k * t),
  };
}

/** Dispatch the right trochoid by kind. */
export function spiroPoint(
  kind: SpiroKind,
  R: number,
  r: number,
  p: number,
  t: number,
): Pt {
  return kind === 'inside'
    ? hypotrochoid(R, r, p, t)
    : epitrochoid(R, r, p, t);
}

// ── Greatest-common-divisor helpers (for revolutions-to-close) ──────────────

/** Euclid GCD on non-negative integers. gcd(0,0)=0; gcd(a,0)=a. */
export function gcdInt(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

/**
 * Number of FULL revolutions of the parameter `t` (i.e. how many times t must
 * sweep 0..2π) for the trochoid figure to CLOSE.
 *
 * A trochoid closes when both the outer angle (t) and the rolling-circle's
 * relative angle complete an integer number of turns simultaneously. For a
 * rational ratio R/r = a/b (lowest terms), the figure closes after exactly
 * `b` revolutions of t (the rolling circle returns to its start AND the pen
 * is back). We compute this from the integer reduction of R:r.
 *
 * For irrational-ish ratios (which never truly close) the rationalisation
 * below produces a large `b`; we CAP it at `maxRevs` so a dense quasi-curve
 * still renders a sane, bounded number of samples (it dense-fills the annulus
 * rather than running forever). The cap is the spec's "sane max".
 *
 *   revolutionsToClose(10, 4) → R:r = 10:4 = 5:2 → 2 revolutions
 *   revolutionsToClose(7, 3)  → 7:3 already lowest terms → 3
 *   revolutionsToClose(6, 2)  → 3:1 → 1
 *   revolutionsToClose(R, r)  with an irrational-looking r → capped at maxRevs
 *
 * `R`,`r` are real (the user's knobs); we quantise to a fine integer grid
 * (×PRECISION) before reducing, so e.g. 2.5:1.0 reduces like 5:2.
 */
export const REVS_PRECISION = 1000;
export const REVS_MAX_DEFAULT = 200;

export function revolutionsToClose(
  R: number,
  r: number,
  maxRevs: number = REVS_MAX_DEFAULT,
): number {
  const rr = Math.abs(r) < 1e-9 ? 1e-9 : Math.abs(r);
  const RR = Math.abs(R);
  // Quantise both onto an integer grid so a rational ratio reduces cleanly and
  // an irrational-ish ratio reduces to a big denominator (→ capped).
  const ai = Math.max(1, Math.round(RR * REVS_PRECISION));
  const bi = Math.max(1, Math.round(rr * REVS_PRECISION));
  const g = gcdInt(ai, bi);
  // After dividing by the GCD, `b` (the reduced rolling-radius numerator) is
  // the revolution count. Clamp to [1, maxRevs].
  const b = bi / (g || 1);
  if (!Number.isFinite(b) || b < 1) return 1;
  return Math.min(maxRevs, Math.max(1, Math.round(b)));
}

/**
 * The pen's maximum reach from the spiro CENTER, in spiro-space units. Used to
 * pick a sample density and (informationally) the curve's bounding extent.
 *   hypotrochoid: |R − r| + |p|
 *   epitrochoid:  |R + r| + |p|
 */
export function curveMaxReach(kind: SpiroKind, R: number, r: number, p: number): number {
  const base = kind === 'inside' ? Math.abs(R - r) : Math.abs(R + r);
  return base + Math.abs(p);
}

// ── Per-spiro moving-center constraint (the bounding-box roll/bounce) ────────
//
// SPEC: each spiro's CENTER drifts independently over time, and the FIXED-radius
// circle (radius R, scaled to screen) must stay FULLY inside the frame at all
// times — when it touches an edge it rolls/bounces (reflects) along the
// perimeter like a real spirograph constrained to the page. Only the
// fixed-circle's center+R is bound-constrained; the drawn CURVE may overflow
// the viewport and clip (that's desired).
//
// We model the center as a point bouncing inside an axis-aligned box inset by
// the (screen-space) fixed radius on every side, with perfectly-elastic
// reflection off each wall. This is a 1-D-per-axis reflection: fold the
// position into [lo, hi] by reflecting across the nearest wall as many times as
// needed (a "triangle wave" of the unconstrained position), and flip the
// velocity sign on each reflection. We do it CLOSED-FORM (no per-frame stepping
// state) so it's deterministic + testable: given a base position, a velocity,
// and elapsed time, return where the center is and which way it's now heading.

export interface CenterState {
  /** Center position (same units as the box — typically normalised [0,1] or px). */
  x: number;
  y: number;
  /** Current velocity DIRECTION/MAGNITUDE after any reflections so far. The
   *  sign encodes the heading; magnitude is preserved (elastic). */
  vx: number;
  vy: number;
}

/**
 * Reflect a scalar `v` into the closed interval [lo, hi] by elastic bouncing,
 * returning the folded position AND whether the heading flipped an ODD number
 * of times (so the caller flips the velocity sign).
 *
 * This is the classic "triangle-wave fold": the unconstrained value is mirrored
 * back into the band across whichever wall it crossed, repeatedly. With
 * span = hi − lo, the period of the bounce is 2·span. We compute the phase
 * within that period and whether we're on the rising or falling leg.
 *
 * Degenerate band (hi ≤ lo) → pin to lo and report no flip (the circle is
 * bigger than the box; it just sits centred — caller decides, here we clamp).
 */
export function reflectIntoBand(
  v: number,
  lo: number,
  hi: number,
): { pos: number; flipped: boolean } {
  const span = hi - lo;
  if (span <= 0) return { pos: lo, flipped: false };
  // Position relative to lo.
  const rel = v - lo;
  const period = 2 * span;
  // Phase in [0, period). JS % can be negative — normalise.
  let phase = rel % period;
  if (phase < 0) phase += period;
  // Position fold (triangle wave): rising leg [0, span] → pos = lo + phase;
  // falling leg (span, period) → pos = lo + (period − phase).
  const pos = phase <= span ? lo + phase : lo + (period - phase);
  // The HEADING flips once per WALL HIT, independent of which leg we land on.
  // Each full `span` of (signed) travel is one wall hit: floor(rel / span).
  // Odd number of hits ⇒ heading reversed. (Works for negative rel too — the
  // floor of a negative quotient counts the low-wall crossings.)
  const wallHits = Math.floor(rel / span);
  const flipped = (((wallHits % 2) + 2) % 2) === 1;
  return { pos, flipped };
}

/**
 * Advance a spiro center by `dt` worth of motion, bouncing the FIXED CIRCLE
 * (screen-space radius `radius`) inside a box [0..boxW] × [0..boxH] so the
 * circle never leaves the frame. Closed-form (no accumulation), so a given
 * (base, velocity, time) is fully deterministic.
 *
 *   - base.{x,y}    : the center's UNCONSTRAINED position at t=0 (the "home").
 *   - base.{vx,vy}  : drift velocity (units per unit time).
 *   - radius        : the fixed circle's screen radius (the inset on every wall).
 *   - boxW, boxH    : frame size in the same units as base/radius.
 *   - t             : elapsed time.
 *
 * Returns the constrained center + the CURRENT heading (velocity with the sign
 * flipped for each wall the axis has bounced off). When the circle is larger
 * than the box on an axis, that axis pins to the box centre (no bounce).
 */
export function advanceCenter(
  base: CenterState,
  radius: number,
  boxW: number,
  boxH: number,
  t: number,
): CenterState {
  const r = Math.max(0, radius);
  const loX = r;
  const hiX = boxW - r;
  const loY = r;
  const hiY = boxH - r;

  // Unconstrained positions.
  const ux = base.x + base.vx * t;
  const uy = base.y + base.vy * t;

  const fx = hiX > loX ? reflectIntoBand(ux, loX, hiX) : { pos: boxW / 2, flipped: false };
  const fy = hiY > loY ? reflectIntoBand(uy, loY, hiY) : { pos: boxH / 2, flipped: false };

  return {
    x: fx.pos,
    y: fy.pos,
    vx: fx.flipped ? -base.vx : base.vx,
    vy: fy.flipped ? -base.vy : base.vy,
  };
}

// ── Full curve sampling (used by the renderer) ──────────────────────────────

/** One spiro's per-instance parameters, in the renderer's coordinate space. */
export interface SpiroParams {
  kind: SpiroKind;
  R: number;
  r: number;
  p: number;
  /** Rotation in radians, applied to the whole figure about its center. */
  rotation: number;
  /** Uniform scale applied to spiro-space coords → screen units. */
  scale: number;
  /** Center in screen space (already bounce-constrained by advanceCenter). */
  cx: number;
  cy: number;
}

/**
 * Sample the closed trochoid as a polyline of screen-space points. The number
 * of revolutions comes from revolutionsToClose; `samplesPerRev` controls the
 * smoothness. Rotation + scale + center are baked in so the renderer just
 * strokes the returned points.
 *
 * Pure + deterministic — the renderer's only job after this is ctx.lineTo over
 * the points with the chosen thickness/colour.
 */
export function sampleSpiro(
  sp: SpiroParams,
  samplesPerRev: number = 240,
  maxRevs: number = REVS_MAX_DEFAULT,
): Pt[] {
  const revs = revolutionsToClose(sp.R, sp.r, maxRevs);
  const total = Math.max(2, Math.round(revs * samplesPerRev));
  const tEnd = revs * 2 * Math.PI;
  const cosR = Math.cos(sp.rotation);
  const sinR = Math.sin(sp.rotation);
  const out: Pt[] = new Array(total + 1);
  for (let i = 0; i <= total; i++) {
    const t = (i / total) * tEnd;
    const pt = spiroPoint(sp.kind, sp.R, sp.r, sp.p, t);
    // Rotate then scale then translate to the screen center.
    const rx = pt.x * cosR - pt.y * sinR;
    const ry = pt.x * sinR + pt.y * cosR;
    out[i] = {
      x: sp.cx + rx * sp.scale,
      y: sp.cy + ry * sp.scale,
    };
  }
  return out;
}
