// packages/web/src/lib/video/modules/textmarquee-layout.ts
//
// TEXTMARQUEE — pure (WebGL-free, DOM-optional) layout + scroll/position math
// for the rich-text marquee video module.
//
// Two responsibilities, kept here so they're trivially unit-testable without a
// WebGL2 context or a real <canvas>:
//
//   1. THE RICH-TEXT MODEL + LAYOUT. A serializable model (`RichTextModel`) of
//      styled paragraphs → runs → per-run style. `layoutModel()` breaks each
//      run into lines on its embedded "\n"s (the editor inserts a hard break
//      per visual line; we do NOT word-wrap — a marquee is a single long ribbon
//      by design, but multi-line is supported for a stacked banner). The line
//      METRICS (per-run width via a measure callback, line height, total block
//      size) are computed purely so the canvas draw is a thin shell that just
//      strokes glyphs at the positions we returned.
//
//   2. THE CV-CALIBRATED POS / SCROLL MATH. Pure functions mapping
//      (knob/CV param values, time, text+screen dimensions) → the draw x/y
//      offset, including marquee WRAP. Calibrated so a bipolar ±1 LFO patched
//      into posX/posY (the repo CV convention — see $lib/audio/cv-scale) sweeps
//      the text ALL THE WAY across: fully off one edge → fully off the other
//      → back, with a margin so the text leaves and re-enters.
//
// The engine module (textmarquee.ts) owns ONLY the GL plumbing + the upload of
// a card-rendered text canvas into a texture; it calls into these helpers for
// every numeric decision. The card (TextmarqueeCard.svelte) drives the editor
// DOM and serializes it into a RichTextModel, then renders that model to an
// offscreen 2D canvas with the SAME layout this file computes.

// ----------------------------------------------------------------------
// Rich-text model — the serializable shape persisted in node.data.richText
// and consumed by the renderer. Deliberately minimal (this is an
// "extremely basic" editor, not a word processor).
// ----------------------------------------------------------------------

/** Paragraph horizontal alignment. */
export type RichAlign = 'left' | 'center' | 'right';

/** One styled run of text within a paragraph. `text` may contain "\n" —
 *  treated as a hard line break by the layout (the editor emits one run per
 *  contiguous style; line breaks live inside the text). */
export interface RichRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Per-character text colour as a CSS hex string ('#rrggbb'). Absent →
   *  inherit the layer foreground (model.fg). */
  color?: string;
}

/** One paragraph: an ordered list of styled runs + an alignment. */
export interface RichParagraph {
  runs: RichRun[];
  align: RichAlign;
}

/** The whole layer model: paragraphs + the layer foreground (default glyph
 *  colour) + background fill + the render font size. */
export interface RichTextModel {
  paragraphs: RichParagraph[];
  /** Default glyph colour for runs without their own `color` ('#rrggbb'). */
  fg: string;
  /** Layer background fill ('#rrggbb'). The renderer fills the text block's
   *  bounding box with this before drawing glyphs. */
  bg: string;
  /** Glyph height in VIDEO PIXELS. The module draws the text texture 1:1 to
   *  screen px, so this directly controls on-screen size. Clamped to
   *  [MIN_FONT_PX, MAX_FONT_PX]; absent → DEFAULT_FONT_PX. */
  fontPx?: number;
}

/** Font-size bounds (video px). MAX is calibrated so a short ~5-char word (e.g.
 *  "BIOME") spans the full width of the video frame in most system fonts: 5 caps
 *  × ~0.6·px ≈ 3·px, so at MAX_FONT_PX=420 that's ~1260px ≥ the 1024-wide
 *  VIDEO_RES frame → the word fills the screen (with margin, and real-font caps
 *  are wider). Verified visually across fonts. */
export const MIN_FONT_PX = 16;
export const DEFAULT_FONT_PX = 64;
export const MAX_FONT_PX = 420;

/** Max total characters across the whole model (a reasonable marquee cap; the
 *  card enforces it on input + coercion truncates a too-long persisted/remote
 *  model so a pasted wall of text can't blow up the texture). */
export const MAX_CHARS = 240;

/** Clamp a possibly-untrusted font size to [MIN_FONT_PX, MAX_FONT_PX], rounded;
 *  non-finite → DEFAULT_FONT_PX. */
export function clampFontPx(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FONT_PX;
  return Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, Math.round(n)));
}

/** A sane empty model (one empty left-aligned paragraph, white on black). */
export function emptyRichTextModel(): RichTextModel {
  return {
    paragraphs: [{ runs: [{ text: '' }], align: 'left' }],
    fg: '#ffffff',
    bg: '#000000',
    fontPx: DEFAULT_FONT_PX,
  };
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Normalize a possibly-untrusted hex string to '#rrggbb' lowercase, or a
 *  fallback when it isn't a valid 6-digit hex (guards persisted/remote data). */
export function normalizeHex(value: unknown, fallback: string): string {
  if (typeof value === 'string' && HEX6.test(value)) return value.toLowerCase();
  return fallback;
}

/** Coerce arbitrary (persisted / remote) data into a valid RichTextModel.
 *  Drops malformed runs/paragraphs rather than throwing — a peer or an old
 *  save must never crash the renderer. */
export function coerceRichTextModel(data: unknown): RichTextModel {
  const empty = emptyRichTextModel();
  if (!data || typeof data !== 'object') return empty;
  const o = data as Record<string, unknown>;
  const fg = normalizeHex(o.fg, empty.fg);
  const bg = normalizeHex(o.bg, empty.bg);
  const rawParas = Array.isArray(o.paragraphs) ? o.paragraphs : [];
  const paragraphs: RichParagraph[] = [];
  for (const rp of rawParas) {
    if (!rp || typeof rp !== 'object') continue;
    const po = rp as Record<string, unknown>;
    const align: RichAlign =
      po.align === 'center' || po.align === 'right' ? po.align : 'left';
    const rawRuns = Array.isArray(po.runs) ? po.runs : [];
    const runs: RichRun[] = [];
    for (const rr of rawRuns) {
      if (!rr || typeof rr !== 'object') continue;
      const ro = rr as Record<string, unknown>;
      if (typeof ro.text !== 'string') continue;
      const run: RichRun = { text: ro.text };
      if (ro.bold === true) run.bold = true;
      if (ro.italic === true) run.italic = true;
      if (ro.underline === true) run.underline = true;
      if (typeof ro.color === 'string' && HEX6.test(ro.color)) {
        run.color = ro.color.toLowerCase();
      }
      runs.push(run);
    }
    if (runs.length === 0) runs.push({ text: '' });
    paragraphs.push({ runs, align });
  }
  if (paragraphs.length === 0) return empty;
  return truncateModelChars({ paragraphs, fg, bg, fontPx: clampFontPx(o.fontPx) }, MAX_CHARS);
}

/** Trim a model to at most `max` total characters (across all runs/paragraphs),
 *  preserving styling on the surviving text + always keeping ≥1 paragraph/run.
 *  Idempotent for an already-short model. Used by coercion + the card on input
 *  so a pasted wall of text can never blow up the rendered texture. */
export function truncateModelChars(model: RichTextModel, max: number): RichTextModel {
  if (modelPlainText(model).length <= max) return model;
  let budget = Math.max(0, max);
  const paragraphs: RichParagraph[] = [];
  for (const p of model.paragraphs) {
    if (budget <= 0) break;
    const runs: RichRun[] = [];
    for (const r of p.runs) {
      if (budget <= 0) break;
      const text = r.text.slice(0, budget);
      budget -= text.length;
      runs.push({ ...r, text });
    }
    paragraphs.push({ runs: runs.length ? runs : [{ text: '' }], align: p.align });
  }
  return { ...model, paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ text: '' }], align: 'left' }] };
}

/** The concatenated plain text of a model (paragraphs joined by "\n"). Handy
 *  for "is the model empty?" checks + tests. */
export function modelPlainText(model: RichTextModel): string {
  return model.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(''))
    .join('\n');
}

// ----------------------------------------------------------------------
// Layout — pure line splitting + metrics.
// ----------------------------------------------------------------------

/** A run placed on a line, with its measured width + x offset within the line. */
export interface PlacedRun {
  run: RichRun;
  /** Text of this run on THIS line (a run can straddle line breaks). */
  text: string;
  /** Measured pixel width of `text` in this run's font. */
  width: number;
  /** x offset of this run's left edge from the line's left edge (px). */
  x: number;
}

/** One laid-out line. */
export interface PlacedLine {
  runs: PlacedRun[];
  /** Total line width (sum of run widths), px. */
  width: number;
  /** Paragraph alignment this line belongs to. */
  align: RichAlign;
}

/** The full laid-out block. */
export interface LayoutResult {
  lines: PlacedLine[];
  /** Widest line, px (the block's content width). */
  width: number;
  /** Total block height (lines * lineHeight), px. */
  height: number;
  /** The line height used (px). */
  lineHeight: number;
}

/** Measure a single run's text width. Injected so the same layout runs against
 *  a real CanvasRenderingContext2D (the renderer) AND a deterministic synthetic
 *  metric (unit tests). The callback must already account for the run's
 *  font/weight/style. */
export type MeasureRun = (text: string, run: RichRun) => number;

/**
 * Lay out a model into lines. Each run's text is split on "\n" into segments;
 * a "\n" ENDS the current line and starts a new one (so a run can contribute
 * to multiple lines). Paragraphs are always separated by a line break. No
 * word-wrap — the marquee is a ribbon; the user controls breaks explicitly.
 *
 * `lineHeight` is the vertical advance per line (px) — typically ~1.25 * the
 * font px size; the caller owns that since it owns the font.
 */
export function layoutModel(
  model: RichTextModel,
  measure: MeasureRun,
  lineHeight: number,
): LayoutResult {
  const lines: PlacedLine[] = [];

  for (const para of model.paragraphs) {
    // Start the paragraph's first line.
    let current: PlacedRun[] = [];
    let cursorX = 0;

    const pushLine = () => {
      lines.push({ runs: current, width: cursorX, align: para.align });
      current = [];
      cursorX = 0;
    };

    for (const run of para.runs) {
      // Split the run text on hard breaks. "a\nb" → ["a", "b"]; "a\n" → ["a", ""].
      const segments = run.text.split('\n');
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si]!;
        if (seg.length > 0) {
          const w = measure(seg, run);
          current.push({ run, text: seg, width: w, x: cursorX });
          cursorX += w;
        }
        // Every segment except the last was terminated by a "\n" → break line.
        if (si < segments.length - 1) pushLine();
      }
    }
    // End the paragraph (flush whatever's pending — even an empty line so a
    // blank paragraph still occupies a row).
    pushLine();
  }

  let maxWidth = 0;
  for (const l of lines) maxWidth = Math.max(maxWidth, l.width);
  return {
    lines,
    width: maxWidth,
    height: lines.length * lineHeight,
    lineHeight,
  };
}

/** The x offset of a line within the block, given the block content width +
 *  the line's alignment. (left → 0; center → centered; right → flush right.) */
export function lineAlignOffset(lineWidth: number, blockWidth: number, align: RichAlign): number {
  if (align === 'center') return (blockWidth - lineWidth) / 2;
  if (align === 'right') return blockWidth - lineWidth;
  return 0;
}

// ----------------------------------------------------------------------
// CV-calibrated POSITION + SCROLL math.
// ----------------------------------------------------------------------
//
// Param convention (matches the engine + cv-scale.ts):
//   * posX / posY are LINEAR knobs in [0, 1], default 0.5 (centred). A bipolar
//     ±1 CV is summed via scaleCv(linear): effective = clamp(knob + cv*0.5, 0, 1).
//     So with the default centred knob, cv=-1 → 0, cv=+1 → 1, cv=0 → 0.5.
//   * scrollX / scrollY are LINEAR knobs in [0, 1], default 0.5 (BIPOLAR speed:
//     0.5 = static; <0.5 scrolls one way, >0.5 the other). A bipolar ±1 CV
//     sweeps the full speed range.
//
// THE FULL-RANGE CALIBRATION (the prompt's key requirement):
//   posX maps [0,1] → screen-x such that:
//     posX = 0   → text FULLY OFF the LEFT  (its right edge at screen x = 0)
//     posX = 1   → text FULLY OFF the RIGHT (its left edge at screen x = W)
//     posX = 0.5 → text CENTRED
//   i.e.  drawX = -textWidth + posX * (W + textWidth)
//   So a default-centred ±1 LFO drives posX across [0,1] and the text travels
//   from fully off-left, through centred, to fully off-right, and back — a full
//   sweep WITH margin (the text wholly leaves + re-enters each side).

/** Map a normalized posX in [0,1] to the text block's draw-x (its LEFT edge, px).
 *  posX=0 → block fully off the left (right edge at 0); posX=1 → block fully off
 *  the right (left edge at screenW); posX=0.5 → centred. */
export function posToDrawX(posX: number, textWidth: number, screenW: number): number {
  const p = clamp01(posX);
  return -textWidth + p * (screenW + textWidth);
}

/** Map a normalized posY in [0,1] to the text block's draw-y (its TOP edge, px).
 *  posY=0 → block fully off the top; posY=1 → block fully off the bottom;
 *  posY=0.5 → centred. (Screen y grows downward, matching the 2D canvas.) */
export function posToDrawY(posY: number, textHeight: number, screenH: number): number {
  const p = clamp01(posY);
  return -textHeight + p * (screenH + textHeight);
}

/** Max marquee speed in screens-per-second at full knob deflection. ~0.6 of a
 *  screen/sec is a relaxed 90s-screensaver crawl at the knob extreme. */
export const MAX_SCREENS_PER_SEC = 0.6;

/**
 * Marquee SCROLL offset along one axis, in px, at time `t` (seconds).
 *
 * `speedKnob` is the bipolar speed param in [0,1] (0.5 = static). It maps to a
 * signed velocity in SCREENS-PER-SECOND (so the cadence reads the same at any
 * resolution): vel = (speedKnob-0.5)*2 * MAX_SCREENS_PER_SEC * span. The raw
 * offset is vel*t; we WRAP it modulo (span + textSize) so the text re-enters
 * from the opposite edge once it has fully left — a continuous ribbon.
 *
 * Returns a wrapped offset recentred to [-period/2, period/2) (so static = 0
 * offset = wherever posX/posY placed it, and the wrap is symmetric around the
 * anchor).
 */
export function scrollOffset(
  speedKnob: number,
  t: number,
  span: number,
  textSize: number,
): number {
  const vel = (clamp01(speedKnob) - 0.5) * 2 * MAX_SCREENS_PER_SEC * span;
  if (vel === 0) return 0;
  const period = span + textSize; // distance to fully cross + clear the screen
  if (period <= 0) return 0;
  const raw = vel * t;
  // Wrap into [0, period), then recentre to [-period/2, period/2) so the
  // marquee enters/exits symmetrically around the posX/posY anchor.
  let m = raw % period;
  if (m < 0) m += period;
  return m - period / 2;
}

/**
 * Combine position + scroll into the final draw offset for one axis. The text
 * block's top-left is placed at (drawX, drawY) on the screen canvas.
 *
 * @returns { x, y } the block's top-left, px (canvas/top-left origin).
 */
export function computeDrawOffset(args: {
  posX: number;
  posY: number;
  scrollX: number;
  scrollY: number;
  time: number;
  textWidth: number;
  textHeight: number;
  screenW: number;
  screenH: number;
}): { x: number; y: number } {
  const baseX = posToDrawX(args.posX, args.textWidth, args.screenW);
  const baseY = posToDrawY(args.posY, args.textHeight, args.screenH);
  const sx = scrollOffset(args.scrollX, args.time, args.screenW, args.textWidth);
  const sy = scrollOffset(args.scrollY, args.time, args.screenH, args.textHeight);
  return { x: baseX + sx, y: baseY + sy };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
