// packages/web/src/lib/ui/modules/painter/paint-surface.ts
//
// THE PAINTER INTERACTION SEAM — one write path, two mounts.
//
// ⚠ WHY THIS FILE EXISTS AT ALL. PAINTER's promotion gives the module a SECOND
// drawing surface: `PainterEditorBody.svelte` (the `fullViewBody` a promoted
// module paints its dock faceplate from) beside `PainterCard.svelte` (still
// reachable under `?shell=legacy` while the migration is live). Both accept
// pointer gestures, both replay the SAME Y.Doc op log, and both must produce
// BYTE-IDENTICAL `PaintOp`s for the same drag — otherwise a stroke drawn on the
// face and a stroke drawn on the card are different pictures on every peer, and
// nothing in the tree would notice, because the log is valid either way.
//
// The module-surfaces skill states the rule this file implements: "One-shot
// behavior belongs in one plain TypeScript action seam called by both legacy
// and v2 surfaces." So the GESTURE -> OP arithmetic lives here, in plain TS,
// unit-tested directly (paint-surface.test.ts), and both `.svelte` files are
// markup plus wiring.
//
// ⚠ WHAT IS NOT HERE, DELIBERATELY:
//   * the DRAWING MODEL (op shapes, palette, flood fill, deterministic apply) —
//     that is `$lib/video/modules/painter-draw`, already pure and already
//     unit-tested. This file consumes it and adds nothing to it.
//   * the node-lifetime REPLAY — that is `replayPaintOps` in
//     `$lib/ui/media/extras-producers`, which is what makes a saved rack render
//     your drawing with no surface mounted (#1720). It is RE-EXPORTED here
//     rather than copied, so the surfaces, the node producer and this seam
//     cannot drift into three replays of one log.
//   * anything Svelte. A `.ts` file under `lib/ui/modules/**` is outside the
//     WebGL attest basis (`resolveWebglBasis` step 2 sweeps `**/*.svelte` BY
//     CONTENT for a GL context, and nothing here creates one), so editing this
//     seam never costs a real-GPU re-attest.

import {
  applyVectorOp,
  floodFill,
  hexToRgba,
  type FillOp,
  type PaintOp,
  type ShapeOp,
  type StrokeOp,
  type TextOp,
  type Tool,
} from '$lib/video/modules/painter-draw';
import { replayPaintOps } from '$lib/ui/media/extras-producers';

/** The deterministic full repaint from a committed op log. RE-EXPORTED, never
 *  re-implemented — see the header. */
export { replayPaintOps };

/**
 * The toolbar roster, in MS-Paint order: the freehand three, the two samplers,
 * the three shapes, then text.
 *
 * ⚠ SHARED DATA, NOT A CONVENTION. The card and the body each render a button
 * per entry with `data-testid={`painter-tool-${id}`}` / `painter-face-tool-${id}`,
 * so a tool added here appears on BOTH surfaces and a tool added to one only is
 * not expressible.
 */
export const PAINT_TOOLS: readonly { id: Tool; label: string; glyph: string }[] = [
  { id: 'pencil', label: 'Pencil', glyph: '✏️' },
  { id: 'brush', label: 'Brush', glyph: '🖌️' },
  { id: 'eraser', label: 'Eraser', glyph: '🧽' },
  { id: 'fill', label: 'Fill', glyph: '🪣' },
  { id: 'eyedropper', label: 'Pick', glyph: '💧' },
  { id: 'line', label: 'Line', glyph: '╱' },
  { id: 'rect', label: 'Rect', glyph: '▭' },
  { id: 'ellipse', label: 'Ellipse', glyph: '◯' },
  { id: 'text', label: 'Text', glyph: 'A' },
];

/**
 * The LOCAL, per-collaborator tool state both surfaces hold.
 *
 * ⚠ IT IS LOCAL BY DESIGN AND MUST STAY THAT WAY. Only the DRAWING syncs
 * (`node.data.ops`). Moving the active tool or the foreground colour onto the
 * graph would paint another peer's tool out from under them mid-stroke, which
 * is a multiplayer regression rather than a promotion — the reason none of
 * these is a face cell.
 */
export interface PaintToolState {
  tool: Tool;
  /** Strokes, text, flood fill, and every shape OUTLINE. */
  fg: string;
  /** The eraser's colour and a filled shape's interior — set by RIGHT-CLICKING
   *  a swatch, which is the only way to change it on either surface. */
  bg: string;
  brush: number;
  /** rect / ellipse: filled with `bg` vs outline only. */
  fillShapes: boolean;
  /** The TEXT tool's stamp string. */
  text: string;
}

/** What a pointer-down does with this tool. The branch both surfaces walk, so
 *  neither can grow a fourth behaviour the other lacks. */
export type PaintGestureKind = 'pick' | 'fill' | 'text' | 'stroke' | 'shape';

export function gestureKindFor(tool: Tool): PaintGestureKind {
  if (tool === 'eyedropper') return 'pick';
  if (tool === 'fill') return 'fill';
  if (tool === 'text') return 'text';
  if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') return 'stroke';
  return 'shape';
}

/** The `StrokeOp.tool` a UI tool maps to. */
export function strokeToolOf(tool: Tool): StrokeOp['tool'] {
  return tool === 'eraser' ? 'eraser' : tool === 'brush' ? 'brush' : 'pencil';
}

/** The `ShapeOp.tool` a UI tool maps to. */
export function shapeToolOf(tool: Tool): ShapeOp['tool'] {
  return tool === 'line' ? 'line' : tool === 'rect' ? 'rect' : 'ellipse';
}

/** The ERASER paints the BACKGROUND colour; everything else paints the
 *  foreground. (MS-Paint's model, and the reason right-click-a-swatch is
 *  load-bearing rather than decorative.) */
export function strokeColorFor(s: PaintToolState): string {
  return s.tool === 'eraser' ? s.bg : s.fg;
}

/** PENCIL is a hard 1px line whatever SIZE says; brush and eraser take SIZE. */
export function strokeSizeFor(s: PaintToolState): number {
  return s.tool === 'pencil' ? 1 : s.brush;
}

/** The stamped glyph height for a TEXT op, derived from SIZE. Floors at 12 px
 *  so the smallest brush still stamps something legible at engine resolution. */
export function textStampSize(brush: number): number {
  return Math.max(12, brush * 6);
}

export function strokeOpFor(s: PaintToolState, points: readonly number[]): StrokeOp {
  return {
    kind: 'stroke',
    tool: strokeToolOf(s.tool),
    color: strokeColorFor(s),
    size: strokeSizeFor(s),
    points: [...points],
  };
}

export function shapeOpFor(
  s: PaintToolState,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): ShapeOp {
  return {
    kind: 'shape',
    tool: shapeToolOf(s.tool),
    color: s.fg,
    size: s.brush,
    // ⚠ A LINE HAS NO INTERIOR. `fillShapes` must not reach it, or the FILL
    // toggle would silently change what a line op serialises to.
    fill: s.tool !== 'line' && s.fillShapes ? s.bg : null,
    x0,
    y0,
    x1,
    y1,
  };
}

export function fillOpFor(s: PaintToolState, x: number, y: number): FillOp {
  return { kind: 'fill', color: s.fg, x, y };
}

/** The TEXT op for a stamp at (x, y), or `null` when there is nothing to stamp
 *  — an empty string must not commit an op that draws nothing but still counts
 *  against UNDO and `MAX_OPS`. */
export function textOpFor(s: PaintToolState, x: number, y: number): TextOp | null {
  if (s.text.length === 0) return null;
  return {
    kind: 'text',
    color: s.fg,
    size: textStampSize(s.brush),
    x,
    y,
    font: 'sans-serif',
    text: s.text,
  };
}

/** The element rect a pointer is mapped through. Structural so the unit tests
 *  can hand in a plain object — no DOM in the web package's node-env vitest. */
export interface CanvasRectLike {
  readonly width: number;
  readonly height: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/**
 * Pointer CLIENT coordinates -> ENGINE-canvas coordinates.
 *
 * ⚠ IT SCALES BY THE ELEMENT'S OWN RECT, and that is a correctness property
 * rather than a nicety. Both surfaces show a 1024x768 buffer scaled DOWN to fit
 * (the card into its tier, the body into the faceplate width), and the two
 * scale factors differ. A gesture mapped through the wrong rect commits an op
 * whose coordinates are right on the surface that drew it and wrong on every
 * other peer — the skifree defect class, where the bundle took its rect from a
 * detached canvas and the cursor received raw viewport coordinates.
 *
 * A zero-sized rect (a canvas that has not been laid out yet) maps to the
 * origin rather than to NaN, so a pointer event that arrives before layout
 * cannot poison the op log.
 */
export function pointerToCanvas(
  canvas: CanvasRectLike,
  clientX: number,
  clientY: number,
): [number, number] {
  const r = canvas.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return [0, 0];
  return [
    (clientX - r.left) * (canvas.width / r.width),
    (clientY - r.top) * (canvas.height / r.height),
  ];
}

/** The 2D-context subset this seam needs beyond `painter-draw`'s `Ctx2D` — the
 *  raster half (flood fill and the eyedropper both read pixels back). */
export type PaintCtx2D = CanvasRenderingContext2D;

/**
 * Draw ONE op onto a live context, including the two `painter-draw` leaves to
 * the caller because they need image data (`fill`) or are not generated yet
 * (`snapshot`).
 *
 * ⚠ `getImageData` CAN THROW and the throw must never escape. On a tainted or
 * headless context the honest outcome is to skip that op and keep the rest of
 * the replay — a paint surface that dies on one flood fill loses the whole
 * picture.
 */
export function applyOpToCanvas(
  ctx: PaintCtx2D,
  op: PaintOp,
  width: number,
  height: number,
): void {
  if (op.kind === 'fill') {
    try {
      const img = ctx.getImageData(0, 0, width, height);
      floodFill(img, op.x, op.y, hexToRgba(op.color));
      ctx.putImageData(img, 0, 0);
    } catch {
      /* tainted / headless context — skip this op, keep the rest */
    }
    return;
  }
  if (op.kind === 'snapshot') return; // raster checkpoints are not generated yet
  applyVectorOp(ctx, op);
}

/** The EYEDROPPER: the `#rrggbb` under (x, y), or `null` when the pixel cannot
 *  be read. Never throws — a failed sample leaves the foreground alone. */
export function pickColorAt(ctx: PaintCtx2D, x: number, y: number): string | null {
  try {
    const px = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    return `#${[px[0], px[1], px[2]]
      .map((n) => (n ?? 0).toString(16).padStart(2, '0'))
      .join('')}`;
  } catch {
    return null;
  }
}
