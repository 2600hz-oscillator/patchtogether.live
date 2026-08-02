// packages/web/src/lib/control/push2/push-screen-layout.ts
//
// WHERE everything sits on the Push 2's 960×160 panel — the pure half of the
// renderer. `renderPushCard(view)` turns a PushCardView into a flat list of
// DRAW OPS; a ~40-line executor (push-card-paint.ts) replays them onto a 2D
// context, and the resulting RGBA goes to `sendFrame`.
//
// WHY A DRAW-OP LIST AND NOT A CANVAS: `packages/web/vitest.config.ts` is
// `environment: 'node'` — no DOM, no canvas. Splitting here means every
// geometry decision (bar width, bar ORIGIN, cell count, which strips are blank,
// what the header says) is asserted in a plain unit test with zero browser, and
// the only untested-by-unit code left is "call fillRect / fillText in a loop".
//
// ── THE BAR IS THE PART THAT MUST NOT LIE ─────────────────────────────────
//
// Everything about a bar's POSITION arrives pre-computed on the strip view
// (`frac`, `zeroFrac`, `cells`, `cellIndex`) from push-card-model.ts, which
// derives it through `knobValueToFrac` — the same function KnobConic drives its
// arc from. This file only turns 0..1 into pixels. It must not re-derive a
// position from `value`, and it never sees `min`/`max`/`curve` at all, which is
// the structural reason it CAN'T.
//
// Two pixel rules that carry meaning:
//   · the fill spans [min(frac,zeroFrac), max(frac,zeroFrac)] — so a bipolar
//     param grows out of its ZERO anchor in whichever direction it was turned,
//     and an attenuverter at rest is an empty bar rather than a half-full one;
//   · a non-zero deflection floors at ONE pixel, so the smallest turn you can
//     make is still visible instead of rounding away to nothing.
//
// Geometry is EXACT integers on the 960×160 grid (960/8 = 120 per strip), so
// the strips cannot drift apart at the right-hand edge.

import type { PushCardView, PushStripView } from './push-card-model';

// ── The panel ──────────────────────────────────────────────────────────────

export const PUSH_SCREEN_W = 960;
export const PUSH_SCREEN_H = 160;
/** One strip per display encoder. */
export const STRIP_COUNT = 8;
/** 960 / 8 — exact, so strip 7's right edge is the panel's right edge. */
export const STRIP_W = PUSH_SCREEN_W / STRIP_COUNT; // 120
export const STRIP_PAD_X = 8;
export const STRIP_CONTENT_W = STRIP_W - STRIP_PAD_X * 2; // 104

// ── Vertical bands ─────────────────────────────────────────────────────────

export const HEADER_H = 24;
export const HEADER_RULE_Y = HEADER_H; // 1px rule at y = 24
export const BODY_Y = HEADER_RULE_Y + 1; // 25
export const LABEL_Y = 29;
export const LABEL_H = 24;
export const BAR_Y = 59;
export const BAR_H = 40;
/** Bar TRACK interior (inside the 1px border): x from x0+9, 102 px wide. */
export const BAR_INSET = 1;
export const TRACK_W = STRIP_CONTENT_W - BAR_INSET * 2; // 102
export const PIP_Y = BAR_Y + BAR_H + 1; // 100 — the 6px gutter under the bar
export const PIP_W = 2;
export const PIP_H = 3;
export const VALUE_Y = 105;
export const VALUE_H = 32;
/** Encoder-number band; 143 + 14 = 157 leaves a 3px bottom margin. */
export const FLAG_Y = 143;
export const FLAG_H = 14;

// ── Palette ────────────────────────────────────────────────────────────────

export const COL_BG = '#000000';
export const COL_RULE = '#303030';
export const COL_DIVIDER = '#202020';
export const COL_TRACK_BORDER = '#4A4A4A';
export const COL_TRACK_BG = '#141414';
export const COL_TRACK_BORDER_EMPTY = '#242424';
export const COL_FILL = '#E8E8E8';
export const COL_ZERO_MARK = '#6A6A6A';
export const COL_PIP = '#5A5A5A';
export const COL_LABEL = '#B8BCC4';
export const COL_VALUE = '#FFFFFF';
export const COL_MUTED = '#9AA0A6';
export const COL_FLAG = '#5A5A5A';
export const COL_CELL_OFF = '#2E2E2E';
/** Lane accent when the view carries no lane colour (no lane / dawless rack). */
export const COL_LANE_FALLBACK = '#6F7488';

// ── The op vocabulary ──────────────────────────────────────────────────────

/** A filled axis-aligned rectangle. */
export interface PushRectOp {
  op: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

/** A run of text. `y` is the text's VERTICAL CENTRE (the executor sets
 *  `textBaseline = 'middle'`), so a band's ops can be positioned from the band
 *  rather than from font metrics that differ per platform. `maxW` is a HARD
 *  limit handed to `fillText`, on top of the pure character budget already
 *  applied to `text` — belt and braces, since a squashed name is still legible
 *  where an overflowing one bleeds into the next strip. */
export interface PushTextOp {
  op: 'text';
  x: number;
  y: number;
  text: string;
  fill: string;
  px: number;
  weight: 'normal' | 'bold';
  align: 'left' | 'center' | 'right';
  maxW: number;
}

export type PushDrawOp = PushRectOp | PushTextOp;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Left edge of strip `i` (0-based). */
export function stripX(i: number): number {
  return STRIP_W * i;
}
/** Horizontal centre of strip `i`. */
export function stripCenterX(i: number): number {
  return STRIP_W * i + STRIP_W / 2;
}
/** Left edge of strip `i`'s bar TRACK INTERIOR — where frac 0 lands. */
export function trackX0(i: number): number {
  return STRIP_W * i + STRIP_PAD_X + BAR_INSET;
}

/**
 * Average glyph advance as a fraction of font size, for the pure character
 * budget. 0.6 is the classic monospace-ish figure and deliberately CONSERVATIVE
 * for the proportional UI font: over-trimming a long name by a character is
 * invisible, while under-trimming bleeds into the neighbouring strip.
 */
const GLYPH_ADVANCE = 0.6;

/** Trim `text` to what fits `maxW` at `px`, appending '…' when it had to cut.
 *  PURE — no font metrics, hence testable and platform-stable. */
export function truncateToWidth(text: string, px: number, maxW: number): string {
  const budget = Math.floor(maxW / (px * GLYPH_ADVANCE));
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  if (budget === 1) return '…';
  return text.slice(0, budget - 1) + '…';
}

function text(
  x: number,
  y: number,
  s: string,
  fill: string,
  px: number,
  align: PushTextOp['align'],
  maxW: number,
  weight: PushTextOp['weight'] = 'normal',
): PushTextOp {
  return { op: 'text', x, y, text: truncateToWidth(s, px, maxW), fill, px, weight, align, maxW };
}

function rect(x: number, y: number, w: number, h: number, fill: string): PushRectOp {
  return { op: 'rect', x, y, w, h, fill };
}

// ── The header ─────────────────────────────────────────────────────────────

const SWATCH_W = 4;
const HEADER_MID = HEADER_H / 2;
const TITLE_X = 76;
const TITLE_MAX_W = 620;
const SUBTITLE_X = 704;
const SUBTITLE_MAX_W = 180;
const COUNTER_X = PUSH_SCREEN_W - 8;

/** Lane swatch + "CH n" + title + category + "i/N". Always drawn, including on
 *  the empty states — the header is how you know which lane you are on even
 *  when there is nothing in it. */
export function renderHeader(view: PushCardView): PushDrawOp[] {
  const accent = view.laneHex ?? COL_LANE_FALLBACK;
  const ops: PushDrawOp[] = [
    rect(0, 0, SWATCH_W, HEADER_H, accent),
    rect(0, HEADER_RULE_Y, PUSH_SCREEN_W, 1, COL_RULE),
  ];
  ops.push(
    text(12, HEADER_MID, view.lane === null ? 'CH —' : `CH ${view.lane}`, accent, 12, 'left', 56, 'bold'),
  );
  if (view.title) {
    ops.push(text(TITLE_X, HEADER_MID, view.title, COL_VALUE, 14, 'left', TITLE_MAX_W, 'bold'));
  }
  if (view.subtitle) {
    ops.push(text(SUBTITLE_X, HEADER_MID, view.subtitle, COL_MUTED, 11, 'left', SUBTITLE_MAX_W));
  }
  if (view.index !== null && view.count !== null && view.count > 0) {
    ops.push(text(COUNTER_X, HEADER_MID, `${view.index}/${view.count}`, COL_MUTED, 12, 'right', 72));
  }
  return ops;
}

// ── One strip ──────────────────────────────────────────────────────────────

/** Human text for a card that has nothing to draw. */
export const EMPTY_MESSAGES: Record<NonNullable<PushCardView['empty']>, string> = {
  'no-lane': 'this lane has no channel column — add modules to a channel to see their push cards',
  'no-modules': 'no modules in this lane yet',
  'no-controls': 'this module has no turnable controls',
};

/**
 * The bar fill for a CONTINUOUS param: a span from the bar's ORIGIN
 * (`zeroFrac`) to its value, floored at 1px so the smallest turn is visible.
 * Split out because this is the one calculation the whole feature rests on.
 */
export function barFillSpan(strip: PushStripView, x0: number): { x: number; w: number } {
  const lo = Math.min(strip.frac, strip.zeroFrac);
  const hi = Math.max(strip.frac, strip.zeroFrac);
  const px0 = x0 + Math.round(lo * TRACK_W);
  const px1 = x0 + Math.round(hi * TRACK_W);
  const w = Math.max(px1 - px0, strip.frac === strip.zeroFrac ? 0 : 1);
  return { x: px0, w };
}

/** The cell rects of a DISCRETE param — one per state, evenly divided across
 *  the track with a 1px gap, so a 3-state MODE cannot read as a sweep. */
export function cellRects(cells: number, x0: number): { x: number; w: number }[] {
  const out: { x: number; w: number }[] = [];
  for (let i = 0; i < cells; i++) {
    const a = x0 + Math.round((i * TRACK_W) / cells);
    const b = x0 + Math.round(((i + 1) * TRACK_W) / cells);
    out.push({ x: a, w: Math.max(1, b - a - 1) });
  }
  return out;
}

function renderStrip(strip: PushStripView, i: number): PushDrawOp[] {
  const ops: PushDrawOp[] = [];
  const cx = stripCenterX(i);
  const bx = stripX(i) + STRIP_PAD_X;
  const tx0 = trackX0(i);

  // The encoder number is drawn for EVERY strip, including blank ones: the
  // physical encoders are always there, so a numbered blank says "this knob
  // does nothing here" instead of leaving you guessing which knob is which.
  ops.push(text(cx, FLAG_Y + FLAG_H / 2, String(strip.encoder), COL_FLAG, 9, 'center', STRIP_CONTENT_W));

  if (strip.kind !== 'param') {
    // A deliberately blank slot — the COMMON case (9 of the 17 curated modules
    // have fewer than 8 controls). A hollow, dimmer track keeps the row's rhythm
    // so the eye can still count strips, without implying a value of zero.
    ops.push(rect(bx, BAR_Y, STRIP_CONTENT_W, 1, COL_TRACK_BORDER_EMPTY));
    ops.push(rect(bx, BAR_Y + BAR_H - 1, STRIP_CONTENT_W, 1, COL_TRACK_BORDER_EMPTY));
    return ops;
  }

  ops.push(text(cx, LABEL_Y + LABEL_H / 2, strip.label, COL_LABEL, 11, 'center', STRIP_CONTENT_W));

  // Track: 1px border box, dark interior.
  ops.push(rect(bx, BAR_Y, STRIP_CONTENT_W, BAR_H, COL_TRACK_BORDER));
  ops.push(rect(tx0, BAR_Y + BAR_INSET, TRACK_W, BAR_H - BAR_INSET * 2, COL_TRACK_BG));

  const innerY = BAR_Y + BAR_INSET;
  const innerH = BAR_H - BAR_INSET * 2;

  if (strip.cells !== null) {
    const rects = cellRects(strip.cells, tx0);
    for (let c = 0; c < rects.length; c++) {
      const lit = strip.cellStyle === 'select' ? c === strip.cellIndex : c <= strip.cellIndex;
      ops.push(rect(rects[c].x, innerY, rects[c].w, innerH, lit ? COL_FILL : COL_CELL_OFF));
    }
  } else {
    const span = barFillSpan(strip, tx0);
    if (span.w > 0) ops.push(rect(span.x, innerY, span.w, innerH, COL_FILL));
    if (strip.bipolar) {
      // The zero anchor stays visible at rest, so an empty bipolar bar reads as
      // "centred", not as "at minimum".
      ops.push(rect(tx0 + Math.round(strip.zeroFrac * TRACK_W), innerY, 1, innerH, COL_ZERO_MARK));
    }
  }

  for (const p of strip.pips) {
    ops.push(rect(tx0 + Math.round(p * TRACK_W) - Math.floor(PIP_W / 2), PIP_Y, PIP_W, PIP_H, COL_PIP));
  }

  ops.push(text(cx, VALUE_Y + VALUE_H / 2, strip.valueText, COL_VALUE, 18, 'center', STRIP_CONTENT_W));
  return ops;
}

// ── The whole card ─────────────────────────────────────────────────────────

/**
 * Every op needed to paint one push card, back to front: background, header,
 * strip dividers, then the eight strips left to right.
 *
 * On an EMPTY card (no lane column, an empty lane, or a module with no turnable
 * controls) the strips are replaced by one centred sentence — the header still
 * tells you where you are.
 */
export function renderPushCard(view: PushCardView): PushDrawOp[] {
  const ops: PushDrawOp[] = [rect(0, 0, PUSH_SCREEN_W, PUSH_SCREEN_H, COL_BG)];
  ops.push(...renderHeader(view));

  if (view.empty) {
    ops.push(
      text(
        PUSH_SCREEN_W / 2,
        BODY_Y + (PUSH_SCREEN_H - BODY_Y) / 2,
        EMPTY_MESSAGES[view.empty],
        COL_MUTED,
        16,
        'center',
        PUSH_SCREEN_W - 48,
      ),
    );
    return ops;
  }

  for (let i = 1; i < STRIP_COUNT; i++) {
    ops.push(rect(stripX(i), BODY_Y, 1, PUSH_SCREEN_H - BODY_Y, COL_DIVIDER));
  }
  for (let i = 0; i < STRIP_COUNT; i++) {
    const strip = view.strips[i];
    if (strip) ops.push(...renderStrip(strip, i));
  }
  return ops;
}

/**
 * A cheap value-identity string for a rendered card. The display pump repaints
 * only when this changes, so a static card costs one comparison per scheduler
 * tick instead of a 320 KB pack + a USB transfer. Derived from the OPS, not
 * from the view, so anything that would change a pixel changes the signature —
 * including a change this file makes for a reason the view does not name.
 */
export function pushCardSignature(ops: readonly PushDrawOp[]): string {
  const parts: string[] = [];
  for (const o of ops) {
    parts.push(
      o.op === 'rect'
        ? `r${o.x},${o.y},${o.w},${o.h},${o.fill}`
        : `t${o.x},${o.y},${o.px},${o.weight},${o.align},${o.fill},${o.text}`,
    );
  }
  return parts.join('|');
}
