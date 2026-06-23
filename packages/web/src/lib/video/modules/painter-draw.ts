// packages/web/src/lib/video/modules/painter-draw.ts
//
// PAINTER — pure drawing core (no DOM, no GL). The card is an MS-Paint-style
// surface; this module holds the SERIALIZABLE op model + the deterministic paint
// logic so it's unit-testable without a canvas/WebGL context and so the same ops
// replay identically on every peer (the Y.Doc-synced source of truth).
//
// The card stores an ordered list of PaintOp in node.data.ops; on mount / remote
// update it replays them onto a 2D canvas via applyOp(); locally it appends one
// op per committed stroke/shape/fill/text. The painted canvas (engine-resolution)
// is uploaded to the PAINTER video module as the single video output.

/** The classic Windows-95 Paint 28-colour palette (2 rows × 14), left→right,
 *  top row then bottom row. Used as the card's swatch grid + the default fg/bg. */
export const WIN95_PALETTE: readonly string[] = [
  // row 1
  '#000000', '#808080', '#800000', '#808000', '#008000', '#008080', '#000080',
  '#800080', '#808040', '#004040', '#0080ff', '#004080', '#8000ff', '#804000',
  // row 2
  '#ffffff', '#c0c0c0', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff',
  '#ff00ff', '#ffff80', '#00ff80', '#80ffff', '#8080ff', '#ff0080', '#ff8040',
] as const;

/** MS-Paint canvas default background = white. A fresh PAINTER node renders this
 *  (non-black) so the per-port output-emit sweep sees a live frame. */
export const PAINT_BG = '#ffffff';

export const DEFAULT_FG = '#000000';
export const MIN_BRUSH = 1;
export const MAX_BRUSH = 48;
export const DEFAULT_BRUSH = 3;

/** Hard cap on persisted ops so a long session can't bloat the Y.Doc unbounded.
 *  When exceeded the card flattens to a raster snapshot op + truncates (see card). */
export const MAX_OPS = 4000;

export type Tool =
  | 'pencil'
  | 'brush'
  | 'eraser'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'fill'
  | 'eyedropper'
  | 'text';

/** Freehand stroke (pencil = hard 1px-ish; brush = round, sized; eraser = paints
 *  the bg colour). points are a flat [x0,y0,x1,y1,…] in canvas (engine) px. */
export interface StrokeOp {
  kind: 'stroke';
  tool: 'pencil' | 'brush' | 'eraser';
  color: string; // for eraser this is the bg colour to paint
  size: number;
  points: number[];
}

/** A two-point shape: line, rectangle, or ellipse. `fill` null = outline only. */
export interface ShapeOp {
  kind: 'shape';
  tool: 'line' | 'rect' | 'ellipse';
  color: string; // outline / line colour
  size: number; // line width
  fill: string | null; // interior fill (rect/ellipse), null = none
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Flood fill from a seed point with a solid colour. */
export interface FillOp {
  kind: 'fill';
  color: string;
  x: number;
  y: number;
}

/** A line of text stamped at (x,y) top-left. */
export interface TextOp {
  kind: 'text';
  color: string;
  size: number; // font px
  x: number;
  y: number;
  text: string;
  font: string; // css font-family
}

/** A full-canvas raster checkpoint (PNG data-URL). Used when the op log is
 *  flattened (MAX_OPS reached, or an explicit "merge"): a snapshot replaces the
 *  prior ops so replay stays bounded. */
export interface SnapshotOp {
  kind: 'snapshot';
  dataUrl: string;
}

export type PaintOp = StrokeOp | ShapeOp | FillOp | TextOp | SnapshotOp;

/** True if `s` looks like a #rrggbb / #rgb hex colour. */
export function isHexColor(s: unknown): s is string {
  return typeof s === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s);
}

/** Parse #rrggbb / #rgb → [r,g,b,255]. Returns black on malformed input. */
export function hexToRgba(hex: string): [number, number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  if (h.length !== 6) return [0, 0, 0, 255];
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

/** Coerce arbitrary node.data.ops (possibly from an older schema / a peer) into a
 *  validated PaintOp[]. Drops anything malformed — never throws. */
export function coerceOps(raw: unknown): PaintOp[] {
  if (!Array.isArray(raw)) return [];
  const out: PaintOp[] = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const op = o as Record<string, unknown>;
    switch (op.kind) {
      case 'stroke':
        if (
          (op.tool === 'pencil' || op.tool === 'brush' || op.tool === 'eraser') &&
          isHexColor(op.color) &&
          typeof op.size === 'number' &&
          Array.isArray(op.points) &&
          op.points.length >= 2 &&
          op.points.every((n) => typeof n === 'number' && Number.isFinite(n))
        ) {
          out.push({ kind: 'stroke', tool: op.tool, color: op.color, size: op.size, points: op.points as number[] });
        }
        break;
      case 'shape':
        if (
          (op.tool === 'line' || op.tool === 'rect' || op.tool === 'ellipse') &&
          isHexColor(op.color) &&
          typeof op.size === 'number' &&
          (op.fill === null || isHexColor(op.fill)) &&
          ['x0', 'y0', 'x1', 'y1'].every((k) => typeof op[k] === 'number')
        ) {
          out.push({
            kind: 'shape', tool: op.tool, color: op.color, size: op.size,
            fill: (op.fill as string | null) ?? null,
            x0: op.x0 as number, y0: op.y0 as number, x1: op.x1 as number, y1: op.y1 as number,
          });
        }
        break;
      case 'fill':
        if (isHexColor(op.color) && typeof op.x === 'number' && typeof op.y === 'number') {
          out.push({ kind: 'fill', color: op.color, x: op.x as number, y: op.y as number });
        }
        break;
      case 'text':
        if (
          isHexColor(op.color) && typeof op.size === 'number' &&
          typeof op.x === 'number' && typeof op.y === 'number' &&
          typeof op.text === 'string' && typeof op.font === 'string'
        ) {
          out.push({ kind: 'text', color: op.color, size: op.size, x: op.x as number, y: op.y as number, text: op.text, font: op.font });
        }
        break;
      case 'snapshot':
        if (typeof op.dataUrl === 'string' && op.dataUrl.startsWith('data:image/')) {
          out.push({ kind: 'snapshot', dataUrl: op.dataUrl });
        }
        break;
    }
  }
  return out;
}

/** A minimal 2D-context surface — the subset applyOp needs. Both
 *  CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D satisfy it. */
export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | 'strokeStyle' | 'fillStyle' | 'lineWidth' | 'lineCap' | 'lineJoin' | 'font'
  | 'textBaseline' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'fill'
  | 'rect' | 'ellipse' | 'fillRect' | 'fillText' | 'closePath'
>;

/** Draw one op onto a 2D context. Pure w.r.t. inputs (deterministic given the
 *  op); snapshot/fill are handled by the card (need image data) — applyOp draws
 *  the VECTOR ops (stroke/shape/text). Returns false for ops it can't draw here. */
export function applyVectorOp(ctx: Ctx2D, op: PaintOp): boolean {
  switch (op.kind) {
    case 'stroke': {
      const pts = op.points;
      if (pts.length < 2) return true;
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.tool === 'pencil' ? Math.max(1, op.size) : op.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0]!, pts[1]!);
      if (pts.length === 2) {
        // single point → a dot: tiny line to itself so lineCap renders it
        ctx.lineTo(pts[0]! + 0.01, pts[1]!);
      } else {
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
      }
      ctx.stroke();
      return true;
    }
    case 'shape': {
      const { x0, y0, x1, y1 } = op;
      if (op.tool === 'line') {
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.size;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        return true;
      }
      const x = Math.min(x0, x1);
      const y = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      if (op.tool === 'rect') {
        if (op.fill) { ctx.fillStyle = op.fill; ctx.fillRect(x, y, w, h); }
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.size;
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.stroke();
        return true;
      }
      // ellipse
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (op.fill) {
        ctx.fillStyle = op.fill;
        ctx.beginPath();
        ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.size;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      return true;
    }
    case 'text': {
      ctx.fillStyle = op.color;
      ctx.font = `${op.size}px ${op.font}`;
      ctx.textBaseline = 'top';
      ctx.fillText(op.text, op.x, op.y);
      return true;
    }
    default:
      return false; // fill / snapshot handled by the card (need image data)
  }
}

/** A raw RGBA bitmap (the subset of ImageData we mutate) — lets flood fill be
 *  unit-tested with a plain Uint8ClampedArray, no canvas. */
export interface RgbaBitmap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 4-connected scanline flood fill from (sx,sy) to `target` RGBA, replacing the
 *  contiguous region of the seed's original colour. Mutates `img.data` in place.
 *  Pure + deterministic → unit-testable without a canvas. Returns the number of
 *  pixels filled. No-op if the seed is already the target colour. */
export function floodFill(
  img: RgbaBitmap,
  sx: number,
  sy: number,
  target: [number, number, number, number],
): number {
  const { data, width: w, height: h } = img;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return 0;
  const at = (x: number, y: number) => (y * w + x) * 4;
  const seed = at(x0, y0);
  const sr = data[seed]!, sg = data[seed + 1]!, sb = data[seed + 2]!, sa = data[seed + 3]!;
  const [tr, tg, tb, ta] = target;
  if (sr === tr && sg === tg && sb === tb && sa === ta) return 0; // already filled
  const matches = (i: number) =>
    data[i] === sr && data[i + 1] === sg && data[i + 2] === sb && data[i + 3] === sa;
  const paint = (i: number) => { data[i] = tr; data[i + 1] = tg; data[i + 2] = tb; data[i + 3] = ta; };

  let filled = 0;
  const stack: number[] = [x0, y0];
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    // walk left to the run start, then paint the WHOLE run left→right (painting
    // from `x` would leave the run's left half unfilled).
    let xl = x;
    while (xl > 0 && matches(at(xl - 1, y))) xl--;
    let xr = xl;
    while (xr < w && matches(at(xr, y))) {
      paint(at(xr, y));
      filled++;
      // seed the rows above + below for each painted column
      if (y > 0 && matches(at(xr, y - 1))) stack.push(xr, y - 1);
      if (y < h - 1 && matches(at(xr, y + 1))) stack.push(xr, y + 1);
      xr++;
    }
  }
  return filled;
}
