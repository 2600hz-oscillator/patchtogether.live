// packages/web/src/lib/video/modules/peakstate-draw.ts
//
// PEAKSTATE — pure (CV-free, DOM-free, GL-free) drawing logic for the
// animated mandala generator. Inspired by florianjs/Mandala-JS — a
// canvas2D mirror-arm kaleidoscope. The pen traces a slow Lissajous-with-
// jitter path through the centred unit disc; each new sample is appended
// to a ring buffer, and every arm of the mandala redraws the WHOLE trail
// rotated by `(2π / complexity) * arm` plus a per-arm reflection for the
// classic mirror-kaleidoscope feel.
//
// Factored out of peakstate.ts so the pen + ring-buffer + render-arm
// math can be unit-tested without WebGL. The module factory calls the
// same functions to drive the on-card canvas + each output canvas.
//
// Conventions:
//   - Pen coords live in `[-0.5, 0.5]` (centred unit disc). The renderer
//     maps that to pixel space via the canvas's centre + a scale.
//   - Time `t` is in seconds and is advanced by `dt * speed` per frame.
//     `t = 0` is the deterministic baseline (tests pin to that).
//   - All math uses plain `Math.sin/cos` — no PRNG, no Date.now() — so
//     the same `t` produces the same pen coordinate on every run.
//
// Ring buffer: a Float32Array of (x,y) pairs. We use a circular write
// cursor + a `length` field that grows to `capacity` then stays pinned;
// readers walk `length` samples starting from the OLDEST entry so the
// trail keeps the chronological order (newest segment on top of older
// strokes on a 2D canvas's per-frame translucent overlay).

/** Number of past pen samples retained for the mandala trail. ~600 at
 *  60fps = ~10s of motion visible. Larger ring → longer comet trail,
 *  more GPU work; 600 keeps the per-frame work bounded. */
export const PEN_TRAIL_CAPACITY = 600;

export interface PenSample {
  x: number;
  y: number;
}

/** Closed-form pen trajectory: two coupled sin/cos with different
 *  periods, plus a slow jitter term inside the second arm so the path
 *  isn't a clean periodic Lissajous (we want a "drifting bloom" feel).
 *  Range: x,y ∈ [-0.5, 0.5] always (every term is bounded by ≤ 0.5).
 *
 *  Deterministic: same `t` → same `(x,y)`. The tests rely on this.
 */
export function penAtTime(t: number): PenSample {
  const x = 0.5 * Math.cos(t * 0.7);
  const y = 0.5 * Math.sin(t * 1.3 + 0.4 * Math.cos(t * 0.3));
  return { x, y };
}

/** Fixed-capacity ring buffer of pen samples. `length` is the number of
 *  currently-stored entries (≤ capacity); `cursor` is the write index
 *  (where the NEXT push lands). Allocated up front so the per-frame
 *  push() never allocates.
 */
export class PenRing {
  readonly capacity: number;
  /** Interleaved (x, y) pairs — Float32Array so the underlying memory
   *  is one stable typed buffer (cheap to scan + cheap to GC). */
  readonly buf: Float32Array;
  length = 0;
  cursor = 0;

  constructor(capacity = PEN_TRAIL_CAPACITY) {
    this.capacity = capacity;
    this.buf = new Float32Array(capacity * 2);
  }

  push(x: number, y: number): void {
    const i = this.cursor * 2;
    this.buf[i] = x;
    this.buf[i + 1] = y;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.length < this.capacity) this.length++;
  }

  /** Reset for deterministic seeding (used by tests + the VRT seed path). */
  reset(): void {
    this.length = 0;
    this.cursor = 0;
    for (let i = 0; i < this.buf.length; i++) this.buf[i] = 0;
  }

  /** Visit each sample in chronological order (oldest → newest). The
   *  callback receives an `i` index (0 = oldest) and the (x, y) pair. */
  forEachChronological(cb: (i: number, x: number, y: number) => void): void {
    if (this.length === 0) return;
    const start = this.length < this.capacity ? 0 : this.cursor;
    for (let n = 0; n < this.length; n++) {
      const idx = (start + n) % this.capacity;
      const x = this.buf[idx * 2]!;
      const y = this.buf[idx * 2 + 1]!;
      cb(n, x, y);
    }
  }
}

/** Pen-pump state for a single PEAKSTATE instance. Tracks the wall-clock
 *  time so successive `advance()` calls accumulate into `t` correctly. */
export interface PenState {
  /** Current "engine time" — seconds * speed. The pen reads `penAtTime(t)`. */
  t: number;
  ring: PenRing;
}

export function makePenState(): PenState {
  return { t: 0, ring: new PenRing() };
}

/** Advance the pen by `dt` seconds at `speedMul`. Pushes one new sample
 *  onto the ring buffer. Idempotent w.r.t. ring-buffer reset (tests can
 *  reset then re-advance to verify determinism). */
export function advancePen(state: PenState, dt: number, speedMul: number): void {
  state.t += Math.max(0, dt) * Math.max(0, speedMul);
  const { x, y } = penAtTime(state.t);
  state.ring.push(x, y);
}

// ---------------------------------------------------------------------------
// 2D canvas rendering — used by mono_out (white pen) + rgb_out (HSL cycling)
// + by the 3D output's "fat-line fake-3D" v1 path (renders the same mandala
// onto an OffscreenCanvas with a perspective tilt + Y-mirror for the bowl).
// ---------------------------------------------------------------------------

/** RGB triple in 0..255. */
export interface Rgb { r: number; g: number; b: number; }

/** HSL→RGB (h in [0,360), s/l in [0,1]). Standard formula; small + fast,
 *  no allocations in the hot path. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hh = ((h % 360) + 360) % 360 / 60;
  const xv = c * (1 - Math.abs((hh % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hh < 1)      { r1 = c; g1 = xv; }
  else if (hh < 2) { r1 = xv; g1 = c; }
  else if (hh < 3) { g1 = c; b1 = xv; }
  else if (hh < 4) { g1 = xv; b1 = c; }
  else if (hh < 5) { r1 = xv; b1 = c; }
  else             { r1 = c; b1 = xv; }
  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/** Hue at time `t` for the colour-cycling RGB output.
 *
 *   hue = (t * color_speed * 60) mod 360
 *
 * `color_speed = 1` → full 360° in 6s; `color_speed = 2` → twice as fast
 * (the test that verifies "twice the rotation over the same window" pins
 * exactly that ratio).
 */
export function hueAtTime(t: number, colorSpeed: number): number {
  return ((t * colorSpeed * 60) % 360 + 360) % 360;
}

export interface RenderOpts {
  /** Number of mirror arms around the centre. Integer; coerced. */
  complexity: number;
  /** Stroke colour. Use `null` to skip drawing (e.g. clear-only). */
  color: Rgb | null;
  /** Alpha (0..1) for the per-frame translucent black overlay that
   *  decays the trail. */
  decayAlpha: number;
  /** Drawing scale (pixels per unit). Defaults to min(w, h) * 0.45 so
   *  the unit disc fits with padding. */
  scale?: number;
}

/** Minimal 2D-context surface — typed against the union of OffscreenCanvas
 *  + HTMLCanvasElement contexts so the same draw fn works in tests
 *  (jsdom canvas), in workers (OffscreenCanvas), and in the engine. */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
}

/** Total number of line SEGMENTS the mandala-render below will emit for
 *  a given ring length + complexity. Useful for the test that asserts
 *  "complexity = 4 → 4× the segments of complexity = 1". One segment
 *  per (arm × mirror × adjacent-sample-pair). */
export function expectedSegmentCount(ringLength: number, complexity: number): number {
  if (ringLength < 2) return 0;
  // 2 polylines per arm (the arm itself + its mirrored twin) → 2 *
  // complexity polylines, each with (ringLength - 1) segments.
  return 2 * Math.max(1, Math.round(complexity)) * (ringLength - 1);
}

/** Draw one frame of the mandala into a 2D context.
 *
 *  Steps:
 *    1. Translucent black overlay (decayAlpha) — the comet-trail fade.
 *    2. For each of `complexity` arms: rotate the canvas by
 *       `(2π / complexity) * arm`, then draw the trail polyline twice —
 *       once unmirrored, once mirrored about the arm axis (the Y
 *       coordinate is negated, the X is kept). Skipping mirror would
 *       give us N rotated copies; adding it gives the 2N-fold kaleidoscope.
 */
export function drawMandalaFrame(
  ctx: Ctx2D,
  width: number,
  height: number,
  ring: PenRing,
  opts: RenderOpts,
): void {
  // 1. Per-frame translucent overlay — decays the previous frame's trail
  //    without fully clearing, giving the comet/burnaway feel.
  ctx.fillStyle = `rgba(0, 0, 0, ${opts.decayAlpha})`;
  ctx.fillRect(0, 0, width, height);

  if (ring.length < 2 || !opts.color) return;

  const cx = width / 2;
  const cy = height / 2;
  const scale = opts.scale ?? Math.min(width, height) * 0.45;
  const arms = Math.max(1, Math.round(opts.complexity));
  const angleStep = (Math.PI * 2) / arms;

  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgb(${opts.color.r}, ${opts.color.g}, ${opts.color.b})`;
  ctx.globalAlpha = 1;

  // Walk the chronological samples once, but emit 2N polylines (each arm
  // and its mirror) by stamping the points into per-arm scratch arrays.
  // This is one O(N) ring walk + 2N O(N) line strokes — bounded.
  const len = ring.length;
  const startIdx = ring.length < ring.capacity ? 0 : ring.cursor;
  for (let arm = 0; arm < arms; arm++) {
    const angle = angleStep * arm;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    // Arm polyline (no mirror).
    ctx.beginPath();
    for (let n = 0; n < len; n++) {
      const idx = (startIdx + n) % ring.capacity;
      const x = ring.buf[idx * 2]! * scale;
      const y = ring.buf[idx * 2 + 1]! * scale;
      if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Mirror polyline (reflect about the arm axis = X axis after the
    // rotate, i.e. flip the Y coordinate).
    ctx.beginPath();
    for (let n = 0; n < len; n++) {
      const idx = (startIdx + n) % ring.capacity;
      const x = ring.buf[idx * 2]! * scale;
      const y = -ring.buf[idx * 2 + 1]! * scale;
      if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// 3D "fake tube" output — fat-line v1 path per the spec.
// ---------------------------------------------------------------------------
//
// The user wants the third output to "render as 3D tubes". A real
// tube-cross-section fragment shader is heavy and brittle. v1 path:
//   - Render the same mandala onto a 2D canvas with a TILTED transform
//     (a ~15° pitch — the canvas's Y axis is compressed vertically) and
//     rotated about the centre by `speed * 0.3 * elapsed`.
//   - Stroke width is bumped to read as "thick tubes" + a per-stroke
//     gradient (radial within each arm) cheats the lighting feel.
//   - A SECOND copy mirrored vertically below the horizon line gives the
//     "3D bowl" reading the spec calls out as the acceptable v1 path.
//
// This is enough screen-space depth cueing that the viewer reads the
// kaleidoscope as a rotating sculpture; the real-tube shader is a
// future-PR upgrade.

/** Tube-output draw. Same algorithm as drawMandalaFrame, but draws the
 *  mandala TWICE (once upright, once Y-flipped + dimmed) onto a canvas
 *  whose centre transform has been tilted by `pitchRad` and rotated by
 *  `rotationRad`. Reading: a rotating sculpture sitting on a horizon.
 */
export function drawMandalaTubeFrame(
  ctx: Ctx2D,
  width: number,
  height: number,
  ring: PenRing,
  opts: RenderOpts,
  pitchRad: number,
  rotationRad: number,
): void {
  ctx.fillStyle = `rgba(0, 0, 0, ${opts.decayAlpha})`;
  ctx.fillRect(0, 0, width, height);

  if (ring.length < 2 || !opts.color) return;

  const cx = width / 2;
  const cy = height / 2;
  const scale = opts.scale ?? Math.min(width, height) * 0.4;
  const arms = Math.max(1, Math.round(opts.complexity));
  const angleStep = (Math.PI * 2) / arms;

  // Pitch compression on Y: cos(pitch). 15° → ~0.97 (subtle); we
  // exaggerate for readability — clamp(cos(pitch), 0.3, 1.0). The Y axis
  // is squashed → the rotated sculpture reads as receding into depth.
  const yPitch = Math.max(0.3, Math.min(1.0, Math.cos(pitchRad)));

  // Slightly thicker line + reduced alpha for the "bowl" twin so the
  // top half reads as primary.
  const baseWidth = 2.2;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgb(${opts.color.r}, ${opts.color.g}, ${opts.color.b})`;

  const len = ring.length;
  const startIdx = ring.length < ring.capacity ? 0 : ring.cursor;

  // Upright copy first (full alpha), then bowl twin (Y-flipped + dim).
  // Each copy walks every arm × mirror.
  for (let pass = 0; pass < 2; pass++) {
    const yMirror = pass === 0 ? 1 : -1;
    ctx.globalAlpha = pass === 0 ? 1.0 : 0.45;
    ctx.lineWidth = pass === 0 ? baseWidth : baseWidth * 0.85;

    for (let arm = 0; arm < arms; arm++) {
      const angle = angleStep * arm + rotationRad;
      ctx.save();
      ctx.translate(cx, cy);
      // Apply pitch compression THEN per-arm rotation. The rotation
      // happens in the "tilted" plane, so the mandala reads as a
      // sculpture spinning around a vertical (post-tilt) axis.
      ctx.scale(1, yPitch);
      ctx.rotate(angle);
      // Arm polyline.
      ctx.beginPath();
      for (let n = 0; n < len; n++) {
        const idx = (startIdx + n) % ring.capacity;
        const x = ring.buf[idx * 2]! * scale;
        const y = ring.buf[idx * 2 + 1]! * scale * yMirror;
        if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // Mirror polyline within the arm.
      ctx.beginPath();
      for (let n = 0; n < len; n++) {
        const idx = (startIdx + n) % ring.capacity;
        const x = ring.buf[idx * 2]! * scale;
        const y = -ring.buf[idx * 2 + 1]! * scale * yMirror;
        if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}
