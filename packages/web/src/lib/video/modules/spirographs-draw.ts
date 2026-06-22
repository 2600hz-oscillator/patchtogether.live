// packages/web/src/lib/video/modules/spirographs-draw.ts
//
// SPIROGRAPHS — Canvas2D renderer. Strokes the sampled trochoid polylines with
// a real, visible line width (the THICKNESS control) onto a 2D canvas, which
// spirographs.ts uploads as a GL texture. Canvas2D (not GLSL) is the right tool
// here: spirographs are thousands-of-point polylines with a genuine line-width
// control + round joins/caps — exactly what the 2D stroke pipeline does well,
// and the same Canvas2D→texture path SHAPEGEN / TEXTMARQUEE use.
//
// Two render entry points share the polyline sampling (sampleSpiro):
//   • drawColorScene — each spiro stroked in ITS chroma hue, composited on black.
//   • drawMonoScene  — every spiro stroked WHITE on black (the mono-video matte).
//
// All math (the curve points, the bounce-constrained center) is done in the
// pure spirographs-math layer; this file is purely "given resolved per-spiro
// params + a center, stroke the points".

import { sampleSpiro, type SpiroParams } from './spirographs-math';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A fully-resolved spiro ready to draw: its curve params + screen center +
 *  stroke thickness (px) + chroma hue (0..1). */
export interface ResolvedSpiro extends SpiroParams {
  /** Stroke width in pixels (the THICKNESS control, already mapped). */
  thickness: number;
  /** Hue in [0,1] for the colour pass (the chroma colorwheel). */
  hue: number;
}

/** hue (0..1) → an HSL css colour at full saturation, mid-high lightness. */
export function hueToHsl(hue: number, sat = 95, light = 58): string {
  const h = ((hue % 1) + 1) % 1;
  return `hsl(${(h * 360).toFixed(1)}, ${sat}%, ${light}%)`;
}

/** Stroke one spiro's polyline. Shared by both passes; the caller sets
 *  strokeStyle/lineWidth first. */
function strokePolyline(ctx: Ctx2D, sp: ResolvedSpiro, samplesPerRev: number): void {
  const pts = sampleSpiro(sp, samplesPerRev);
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i]!.x, pts[i]!.y);
  }
  ctx.stroke();
}

/** Common stroke setup — round joins/caps so a thick line reads as a smooth
 *  continuous curve rather than mitred segments. */
function setupStroke(ctx: Ctx2D, sp: ResolvedSpiro): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(0.5, sp.thickness);
}

/**
 * COLOR pass — each spiro stroked in its chroma hue, composited (lighter) on a
 * black background so overlapping curves add toward white. This is the
 * full-colour OUT.
 */
export function drawColorScene(
  ctx: Ctx2D,
  spiros: readonly ResolvedSpiro[],
  w: number,
  h: number,
  samplesPerRev = 240,
): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  // Additive compositing so overlapping coloured curves brighten where they
  // cross (the classic glowing-spirograph look) rather than the later spiro
  // simply painting over the earlier.
  ctx.globalCompositeOperation = 'lighter';
  for (const sp of spiros) {
    setupStroke(ctx, sp);
    ctx.strokeStyle = hueToHsl(sp.hue);
    strokePolyline(ctx, sp, samplesPerRev);
  }
  ctx.restore();
}

/**
 * MONO pass — every spiro stroked WHITE on black. This is the white-on-black
 * MONO OUT (a clean matte for keying / downstream luma effects). No additive
 * blend needed (white over white is white).
 */
export function drawMonoScene(
  ctx: Ctx2D,
  spiros: readonly ResolvedSpiro[],
  w: number,
  h: number,
  samplesPerRev = 240,
): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#ffffff';
  for (const sp of spiros) {
    setupStroke(ctx, sp);
    strokePolyline(ctx, sp, samplesPerRev);
  }
}
