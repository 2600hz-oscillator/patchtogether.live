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

import type { FoxyFieldRow } from './foxy-map';

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
