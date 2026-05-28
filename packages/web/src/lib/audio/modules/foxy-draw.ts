// packages/web/src/lib/audio/modules/foxy-draw.ts
//
// FOXY canvas-draw helpers for the two small preview windows on the card:
//
//   1. drawFoxyXyz() — the simplified RUTTETRA "XYZ" window. Strokes each
//      field scanline as a polyline whose vertical position is the
//      luma-displaced height (the heightmap look). Additive-ish bright
//      lines on black, matching the authentic RUTTETRA's phosphor character
//      but rendered on a 2D canvas (no GL inside the audio node).
//
// The RASTERIZE preview reuses RasterPainter.blitTo() directly (rasterize-
// draw.ts), and the animated wavetable display reuses drawWave3D/
// drawWaveScope from wavecel-draw.ts — so only the XYZ window needs its own
// draw routine here.

import type { FoxyBox, FoxyFieldRow } from './foxy-map';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const BG = '#05070b';
const LINE = (a: number): string => `rgba(120,220,255,${a.toFixed(3)})`;

/**
 * Render the simplified XYZ height field. `field` is rows of per-column
 * displaced Y in [0,1] (y-down field space). We stroke every Nth row (to
 * keep the small window legible + cheap) as a horizontal scanline that bows
 * by the luma displacement.
 */
export function drawFoxyXyz(
  ctx: Ctx2D,
  field: FoxyFieldRow[],
  w: number,
  h: number,
  rowStride = 4,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  if (!field || field.length === 0) return;

  const rows = field.length;
  const margin = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const drawW = w - margin * 2;
  const drawH = h - margin * 2;

  for (let r = 0; r < rows; r += rowStride) {
    const row = field[r]!;
    const cols = row.y.length;
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const x = margin + (cols > 1 ? c / (cols - 1) : 0) * drawW;
      // Field Y is y-down in [0,1]; map directly into the draw area.
      const yv = Math.max(0, Math.min(1, row.y[c] ?? 0.5));
      const y = margin + yv * drawH;
      if (c === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Front rows (higher r) brighter for a depth cue.
    const depth = rows > 1 ? r / (rows - 1) : 0;
    ctx.strokeStyle = LINE(0.18 + 0.6 * depth);
    ctx.lineWidth = Math.max(0.5, Math.min(w, h) / 160);
    ctx.stroke();
  }
}

/**
 * Render the "Box" 3D heightfield: raster A is the surface terrain (its luma
 * shades each scanline), raster B's luminosity is the VERTICAL HEIGHT that
 * lifts that surface into 3D. Drawn as an isometric-ish stack of scanlines —
 * back rows are pushed up + drawn first, each row's Y is offset by its B
 * height, and stroke brightness comes from A's base. So you can SEE B's relief
 * (the bumps) over A's pattern, which is exactly what feeds the XYZ stage.
 */
export function drawFoxyBox(
  ctx: Ctx2D,
  box: FoxyBox | null,
  w: number,
  h: number,
  rowStride = 6,
  colStride = 2,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  if (!box || box.size === 0) return;

  const size = box.size;
  const margin = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const drawW = w - margin * 2;
  const drawH = h - margin * 2;
  // Vertical budget: depth-skew (rows recede up the canvas) + height lift
  // (B's luma raises the surface). The two share drawH.
  const liftMax = drawH * 0.42;
  const surfaceH = drawH - liftMax; // span the back→front rows sweep through

  // Back-to-front (small r = far) so nearer scanlines overdraw farther ones.
  for (let r = 0; r < size; r += rowStride) {
    const v0 = size > 1 ? r / (size - 1) : 0;
    // Back rows pushed right for an isometric skew.
    const skewX = (1 - v0) * (drawW * 0.12);
    // Row baseline marches DOWN the canvas as v0 → 1 (front rows lower).
    const rowBaseY = margin + liftMax + v0 * surfaceH;
    ctx.beginPath();
    let started = false;
    let meanShade = 0;
    let n = 0;
    for (let c = 0; c < size; c += colStride) {
      const h0 = size > 1 ? c / (size - 1) : 0;
      const o = r * size + c;
      const heightB = box.height[o] ?? 0;
      const baseA = box.base[o] ?? 0;
      meanShade += baseA; n++;
      const x = margin + skewX + h0 * (drawW - skewX);
      // B's luma lifts the point UP (smaller y) — the headline 3D relief.
      const y = rowBaseY - heightB * liftMax;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    const shade = n > 0 ? meanShade / n : 0;
    const depth = 0.25 + 0.75 * v0;
    // Stroke brightness blends A's terrain shade with the depth cue.
    ctx.strokeStyle = LINE(Math.max(0.05, Math.min(1, (0.15 + 0.85 * shade) * depth)));
    ctx.lineWidth = Math.max(0.5, Math.min(w, h) / 150);
    ctx.stroke();
  }
}
