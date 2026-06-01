// packages/web/src/lib/ui/modules/synesthesia-draw.ts
//
// 10-bar green→red VU meters for SYNESTHESIA. One call renders the 4 band
// meters for a copy side by side. Each meter is 10 stacked segments: 1–6 green,
// 7–8 amber, 9–10 red; unlit segments are the same hue at low alpha so the
// scale reads even when quiet. Pure 2D-canvas — deterministic for VRT.

const SEGMENTS = 10;
const SEG_GAP = 2;
const COL_GAP = 6;

const ON = ['#22c55e', '#eab308', '#ef4444']; // green / amber / red
const OFF = ['rgba(34,197,94,0.16)', 'rgba(234,179,8,0.16)', 'rgba(239,68,68,0.16)'];

/** Colour zone for segment index i (0 = bottom): green ≤5, amber 6–7, red 8–9. */
function zone(i: number): number {
  if (i >= 8) return 2;
  if (i >= 6) return 1;
  return 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function drawColumn(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  w: number,
  h: number,
  level: number,
): void {
  const lit = Math.round(clamp01(level) * SEGMENTS);
  const segH = (h - SEG_GAP * (SEGMENTS - 1)) / SEGMENTS;
  for (let i = 0; i < SEGMENTS; i++) {
    const y = h - (i + 1) * segH - i * SEG_GAP;
    const z = zone(i);
    ctx.fillStyle = i < lit ? ON[z]! : OFF[z]!;
    ctx.fillRect(x, y, w, segH);
  }
}

/**
 * Draw the 4 band VU meters for one copy into a canvas of size w×h.
 * `levels` is 4 values in 0..1 (band 1 → leftmost column).
 */
export function drawVuMeters(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  levels: number[],
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h);
  const cols = 4;
  const colW = (w - COL_GAP * (cols - 1)) / cols;
  for (let c = 0; c < cols; c++) {
    drawColumn(ctx, c * (colW + COL_GAP), colW, h, levels[c] ?? 0);
  }
}
