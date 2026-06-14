// packages/web/src/lib/ui/modules/vfpga-floorplan-draw.ts
//
// The Canvas2D RENDERER for the vfpga fabric floorplan (P5). Pure draw routine:
// given a floorplan MODEL (from buildFloorplan) + a 2D context + pixel size, it
// paints the tile grid + the routing nets, with lit nets highlighted. NO DOM
// queries, NO GL — Canvas2D only (so it stays out of the webgl-attest basis).
//
// Deterministic: same model + same size → same pixels (the focused VRT relies
// on this). Colours are passed in (resolved from CSS vars by the component) so
// the diagram tracks the active theme's cable palette.

import { TILE_TYPE_META, type FloorplanNetKind, type VfpgaFloorplan } from './vfpga-floorplan';

/** Theme colours the renderer needs (resolved from CSS vars by the caller, with
 *  sensible fallbacks so a headless/jsdom draw still works). */
export interface FloorplanColors {
  bg: string;
  grid: string;
  tileStroke: string;
  text: string;
  video: string;
  cv: string;
  gate: string;
  /** Dim colour for an UNLIT net. */
  dim: string;
}

export const DEFAULT_FLOORPLAN_COLORS: FloorplanColors = {
  bg: '#0a0d12',
  grid: 'rgba(255,255,255,0.06)',
  tileStroke: 'rgba(255,255,255,0.22)',
  text: '#cdd6e4',
  video: '#f472b6',
  cv: '#34d399',
  gate: '#f87171',
  dim: 'rgba(150,165,190,0.28)',
};

function netColor(kind: FloorplanNetKind, lit: boolean, c: FloorplanColors): string {
  if (!lit) return c.dim;
  switch (kind) {
    case 'cv':
      return c.cv;
    case 'gate':
      return c.gate;
    case 'feedback':
      return '#fbbf24'; // amber — the clocked recirculation edge stands out
    case 'video':
    default:
      return c.video;
  }
}

/** Draw the floorplan onto `ctx` filling a `w × h` box. The grid is laid out so
 *  every placed tile gets an equal cell; nets are drawn as curved wires from the
 *  source tile's right edge to the destination tile's left edge (a feedback
 *  `:prev` edge is dashed). Returns nothing; the caller owns the canvas. */
export function drawFloorplan(
  ctx: CanvasRenderingContext2D,
  fp: VfpgaFloorplan,
  w: number,
  h: number,
  colors: FloorplanColors = DEFAULT_FLOORPLAN_COLORS,
): void {
  const c = colors;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);

  if (!fp.hasFabric || fp.tiles.length === 0) {
    ctx.fillStyle = c.text;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('no fabric map', w / 2, h / 2);
    return;
  }

  const pad = 8;
  const cols = Math.max(1, fp.cols);
  const rows = Math.max(1, fp.rows);
  const cellW = (w - pad * 2) / cols;
  const cellH = (h - pad * 2) / rows;
  // tile box inside its cell (leave a gutter for wires)
  const tileW = Math.max(18, cellW * 0.7);
  const tileH = Math.max(14, Math.min(cellH * 0.62, 34));

  const cellCenter = (row: number, col: number) => ({
    x: pad + col * cellW + cellW / 2,
    y: pad + row * cellH + cellH / 2,
  });
  const tileById = new Map(fp.tiles.map((t) => [t.id, t] as const));

  // ── faint grid ──
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  for (let r = 0; r <= rows; r++) {
    const y = pad + r * cellH;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }
  for (let col = 0; col <= cols; col++) {
    const x = pad + col * cellW;
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, h - pad);
    ctx.stroke();
  }

  // ── nets (under the tiles), lit last so they sit on top ──
  const drawNet = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    kind: FloorplanNetKind,
    lit: boolean,
    dashed: boolean,
  ) => {
    ctx.strokeStyle = netColor(kind, lit, c);
    ctx.lineWidth = lit ? 1.6 : 1;
    ctx.globalAlpha = lit ? 1 : 0.7;
    ctx.setLineDash(dashed ? [3, 3] : []);
    const sx = from.x + tileW / 2;
    const ex = to.x - tileW / 2;
    const mx = (sx + ex) / 2;
    ctx.beginPath();
    ctx.moveTo(sx, from.y);
    ctx.bezierCurveTo(mx, from.y, mx, to.y, ex, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };

  // draw unlit first, then lit, so lit wires read clearly on top.
  const ordered = [...fp.nets].sort((a, b) => Number(a.lit) - Number(b.lit));
  for (const net of ordered) {
    const ft = tileById.get(net.fromTile);
    const tt = tileById.get(net.toTile);
    if (!ft || !tt) continue;
    drawNet(cellCenter(ft.row, ft.col), cellCenter(tt.row, tt.col), net.kind, net.lit, net.isPrev);
  }

  // ── tiles ──
  ctx.font = '8px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of fp.tiles) {
    const { x, y } = cellCenter(t.row, t.col);
    const x0 = x - tileW / 2;
    const y0 = y - tileH / 2;
    const meta = TILE_TYPE_META[t.type];
    // fill
    ctx.fillStyle = meta.color;
    ctx.globalAlpha = t.type === 'iob_in' || t.type === 'iob_out' ? 0.45 : 0.85;
    roundRect(ctx, x0, y0, tileW, tileH, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    // stroke (output tile gets a bright ring)
    ctx.strokeStyle = t.isOutput ? '#ffffff' : c.tileStroke;
    ctx.lineWidth = t.isOutput ? 1.6 : 1;
    roundRect(ctx, x0, y0, tileW, tileH, 3);
    ctx.stroke();
    // label
    ctx.fillStyle = '#0b0f15';
    ctx.fillText(clip(t.label, tileW), x, y);
  }
}

/** Truncate a label to fit `maxW` px (rough; 8px monospace ≈ 4.8px/char). */
function clip(label: string, maxW: number): string {
  const maxChars = Math.max(2, Math.floor(maxW / 4.8) - 1);
  return label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
