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
import type { PushLegendRow, PushLegendView } from './push-legend-model';
import type { PushElectraView } from './push-electra-model';

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
/** Lane accent when the view carries no lane colour (no lane). */
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

/**
 * Break `text` into at most `maxLines` lines that each fit `maxW` at `px`,
 * splitting on SPACES only (a legend label is words, never a hyphenated run).
 * The last line is truncated with '…' if the words ran out of room, so a long
 * label degrades instead of vanishing.
 *
 * Same pure character budget as `truncateToWidth` — no font metrics, so the
 * result is identical on every platform and asserted without a canvas. A word
 * that is itself wider than the line is hard-cut rather than dropped.
 */
export function wrapToWidth(
  text: string,
  px: number,
  maxW: number,
  maxLines: number,
): string[] {
  const budget = Math.floor(maxW / (px * GLYPH_ADVANCE));
  if (budget <= 0 || maxLines <= 0) return [];
  const words = text.split(' ').filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (next.length <= budget) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    if (lines.length === maxLines) {
      // Out of lines with words still to place — re-fold the remainder onto the
      // last line so truncation SAYS there was more, rather than dropping it.
      const rest = [lines[maxLines - 1], ...words.slice(i)].join(' ');
      lines[maxLines - 1] = truncateToWidth(rest, px, maxW);
      return lines;
    }
    cur = truncateToWidth(words[i], px, maxW); // a single over-long word is hard-cut
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
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
 *  the track with a 1px gap, so a 3-state MODE cannot read as a sweep.
 *  `trackW` defaults to a strip's track; the ElectraControl-mode ROW selector
 *  reuses this with its own (wider) track so the two cell rows round identically
 *  instead of growing a second rounding rule. */
export function cellRects(cells: number, x0: number, trackW: number = TRACK_W): { x: number; w: number }[] {
  const out: { x: number; w: number }[] = [];
  for (let i = 0; i < cells; i++) {
    const a = x0 + Math.round((i * trackW) / cells);
    const b = x0 + Math.round(((i + 1) * trackW) / cells);
    out.push({ x: a, w: Math.max(1, b - a - 1) });
  }
  return out;
}

/** Every op for ONE encoder strip. Exported so ELECTRA CONTROL MODE paints its
 *  six knobs through the SAME function the push card does — a second strip
 *  renderer would be a second chance for the bar to lie. */
export function renderStrip(strip: PushStripView, i: number): PushDrawOp[] {
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

// ── LEGEND MODE ────────────────────────────────────────────────────────────
//
// The held-button overlay: a banner plus TWO rows of 8 cells, one cell per
// physical button. Same op vocabulary, same signature function, same 960-wide
// exact-integer geometry as the card — so the display pump, the dirty check and
// the DOM preview all work on it unchanged.
//
// The BOTTOM row sits directly above the 8 function buttons under the screen, so
// cell i is physically over button i: the spatial mapping IS the documentation.
// The TOP row documents the 8 scene buttons beside the grid, left→right =
// top→bottom (the codebase's own scene-index order).

/** Banner height — view name + SHIFT indicator. */
export const LEGEND_BANNER_H = 18;
/** 1px rule under the banner. */
export const LEGEND_BANNER_RULE_Y = LEGEND_BANNER_H; // 18
/** First row's top edge. */
export const LEGEND_ROW_A_Y = LEGEND_BANNER_RULE_Y + 1; // 19
/** Each row's height — (160 − 19 − 1) / 2 = 70, exact, so the rows can't drift. */
export const LEGEND_ROW_H = (PUSH_SCREEN_H - LEGEND_ROW_A_Y - 1) / 2; // 70
/** 1px rule between the rows. */
export const LEGEND_ROW_RULE_Y = LEGEND_ROW_A_Y + LEGEND_ROW_H; // 89
/** Second row's top edge. */
export const LEGEND_ROW_B_Y = LEGEND_ROW_RULE_Y + 1; // 90
/** Horizontal padding inside a cell. */
export const LEGEND_CELL_PAD_X = 6;
/** Usable label width in a cell: 120 − 12 = 108. */
export const LEGEND_CELL_W = STRIP_W - LEGEND_CELL_PAD_X * 2; // 108
/** Label size. 15 px over a 108 px cell is ~12 characters per line — every
 *  shipped legend fits one or two lines, verified by the layout spec. */
export const LEGEND_LABEL_PX = 15;
export const LEGEND_LABEL_LINE_H = 18;
export const LEGEND_MAX_LINES = 2;
/** Position tag ('S1' / '1') size — small, so it reads as a marker not a word. */
export const LEGEND_TAG_PX = 9;

export const COL_LEGEND_BG = '#000000';
export const COL_LEGEND_LABEL = '#FFFFFF';
export const COL_LEGEND_TAG = '#6A6A6A';
export const COL_LEGEND_CAPTION = '#9AA0A6';
/** SHIFT layer accent — the banner pill + the tags, so the layer you are on is
 *  readable from across a room without reading a word of it. */
export const COL_LEGEND_SHIFT = '#F2B441';
/** An UNBOUND cell's placeholder: dim, and drawn as a dash rather than left
 *  blank, so "this button does nothing here" is an ANSWER and not a gap. */
export const COL_LEGEND_UNBOUND = '#3A3A3A';
export const LEGEND_UNBOUND_MARK = '—';

/** Y centre of line `n` of a `lines`-line label block inside a row. */
export function legendLabelY(rowY: number, lines: number, n: number): number {
  const blockH = lines * LEGEND_LABEL_LINE_H;
  const top = rowY + (LEGEND_ROW_H - blockH) / 2 + 4; // +4 clears the tag band
  return top + n * LEGEND_LABEL_LINE_H + LEGEND_LABEL_LINE_H / 2;
}

/** Every op for one legend row of 8 cells. */
export function renderLegendRow(row: PushLegendRow, rowY: number, shift: boolean): PushDrawOp[] {
  const ops: PushDrawOp[] = [];
  for (let i = 1; i < STRIP_COUNT; i++) {
    ops.push(rect(stripX(i), rowY, 1, LEGEND_ROW_H, COL_DIVIDER));
  }
  for (const c of row.cells) {
    const cx = stripCenterX(c.index);
    ops.push(
      text(cx, rowY + 9, c.tag, shift ? COL_LEGEND_SHIFT : COL_LEGEND_TAG, LEGEND_TAG_PX, 'center', LEGEND_CELL_W),
    );
    if (!c.bound) {
      ops.push(
        text(cx, rowY + LEGEND_ROW_H / 2 + 4, LEGEND_UNBOUND_MARK, COL_LEGEND_UNBOUND, LEGEND_LABEL_PX, 'center', LEGEND_CELL_W),
      );
      continue;
    }
    const lines = wrapToWidth(c.label, LEGEND_LABEL_PX, LEGEND_CELL_W, LEGEND_MAX_LINES);
    for (let n = 0; n < lines.length; n++) {
      ops.push(
        text(
          cx,
          legendLabelY(rowY, lines.length, n),
          lines[n],
          COL_LEGEND_LABEL,
          LEGEND_LABEL_PX,
          'center',
          LEGEND_CELL_W,
          'bold',
        ),
      );
    }
  }
  return ops;
}

/**
 * Every op needed to paint LEGEND MODE. The SCENE row is drawn on TOP and the
 * FUNCTION row on the BOTTOM — the bottom row must sit directly above the
 * physical buttons it names, which is the whole spatial argument for the layout.
 */
export function renderPushLegend(v: PushLegendView): PushDrawOp[] {
  const ops: PushDrawOp[] = [rect(0, 0, PUSH_SCREEN_W, PUSH_SCREEN_H, COL_LEGEND_BG)];
  const mid = LEGEND_BANNER_H / 2;
  ops.push(text(8, mid, 'LEGEND', COL_LEGEND_LABEL, 11, 'left', 70, 'bold'));
  ops.push(text(64, mid, v.context, COL_LEGEND_CAPTION, 11, 'left', 120, 'bold'));
  ops.push(text(196, mid, v.scene.caption, COL_LEGEND_CAPTION, 10, 'left', 300));
  // The note and the function caption share one band — a note only appears in
  // the exceptional "nothing is bound" state, and it is the more useful of the
  // two there, so it REPLACES the caption rather than overlapping it.
  ops.push(
    v.note
      ? text(520, mid, v.note, COL_LEGEND_UNBOUND, 9, 'left', 320)
      : text(520, mid, v.function.caption, COL_LEGEND_CAPTION, 10, 'left', 320),
  );
  if (v.shift) {
    ops.push(text(PUSH_SCREEN_W - 8, mid, 'SHIFT', COL_LEGEND_SHIFT, 11, 'right', 80, 'bold'));
  }
  ops.push(rect(0, LEGEND_BANNER_RULE_Y, PUSH_SCREEN_W, 1, COL_RULE));
  ops.push(...renderLegendRow(v.scene, LEGEND_ROW_A_Y, v.shift));
  ops.push(rect(0, LEGEND_ROW_RULE_Y, PUSH_SCREEN_W, 1, COL_RULE));
  ops.push(...renderLegendRow(v.function, LEGEND_ROW_B_Y, v.shift));
  return ops;
}

// ── ELECTRA CONTROL MODE ───────────────────────────────────────────────────
//
// The latched third display mode: SIX encoder strips (identical to the card's,
// drawn by the same `renderStrip`) plus a ROW PANEL spanning the space above
// encoders 7 and 8 — the two the mode leaves inert.
//
// Geometry stays on the same exact-integer 960/8 grid, so the six strips line up
// with the six physical encoders under them and the panel starts exactly at the
// 7th encoder's left edge. Nothing about a strip is re-derived here; only the
// panel is new.

/** First strip index the ROW panel covers (0-based) — encoder 7. */
export const ELECTRA_PANEL_STRIP = 6;
/** The panel's left edge — exactly encoder 7's strip boundary (720). */
export const ELECTRA_PANEL_X = STRIP_W * ELECTRA_PANEL_STRIP; // 720
/** Two strips wide (240), i.e. the whole space above encoders 7 and 8. */
export const ELECTRA_PANEL_W = STRIP_W * 2; // 240
/** Horizontal centre of the panel (840). */
export const ELECTRA_PANEL_CX = ELECTRA_PANEL_X + ELECTRA_PANEL_W / 2; // 840
/** Vertical centre of the big row NUMBER. */
export const ELECTRA_ROW_NUM_Y = 84;
export const ELECTRA_ROW_NUM_PX = 44;
/** The 1-of-6 selector row: top edge + height. */
export const ELECTRA_SEL_Y = 118;
export const ELECTRA_SEL_H = 10;
/** Inset of the selector track inside the panel, per side. */
export const ELECTRA_SEL_PAD_X = 26;
/** Selector track width — 240 − 52 = 188. */
export const ELECTRA_SEL_W = ELECTRA_PANEL_W - ELECTRA_SEL_PAD_X * 2; // 188

/** ELECTRA CONTROL MODE accent — distinct from any lane hue, so a glance at the
 *  header stripe says "this is not a push card" before a word is read. */
export const COL_ELECTRA_ACCENT = '#7FC4D8';

/** The mode's empty state — a real answer, not a blank screen. */
export const ELECTRA_EMPTY_MESSAGE =
  'no ELECTRA CONTROL in this rack — add one and assign controls to its 6×6 grid';

/**
 * The header band, in the card's geometry so the two modes sit at the same
 * height: accent swatch, the mode name, the surface's name, its bank, and the
 * row counter where the card prints its module counter.
 */
export function renderElectraHeader(v: PushElectraView): PushDrawOp[] {
  const ops: PushDrawOp[] = [
    rect(0, 0, SWATCH_W, HEADER_H, COL_ELECTRA_ACCENT),
    rect(0, HEADER_RULE_Y, PUSH_SCREEN_W, 1, COL_RULE),
    text(12, HEADER_MID, 'ELECTRA', COL_ELECTRA_ACCENT, 12, 'left', 60, 'bold'),
  ];
  if (v.surfaceName) {
    ops.push(text(TITLE_X, HEADER_MID, v.surfaceName, COL_VALUE, 14, 'left', TITLE_MAX_W, 'bold'));
  }
  if (v.bank) {
    ops.push(text(SUBTITLE_X, HEADER_MID, `BANK ${v.bank}`, COL_MUTED, 11, 'left', SUBTITLE_MAX_W));
  }
  ops.push(text(COUNTER_X, HEADER_MID, `${v.row}/${v.rowCount}`, COL_MUTED, 12, 'right', 72));
  return ops;
}

/**
 * The ROW panel over encoders 7 and 8: the word ROW, the row number set large
 * enough to read from behind a keyboard, a 1-of-6 selector so the position is
 * legible without reading the digit, and the two encoder numbers in the flag
 * band — drawn in the same dim colour a blank card strip uses, which is how the
 * screen SAYS those two knobs do nothing here instead of leaving a gap.
 */
export function renderElectraRowPanel(v: PushElectraView): PushDrawOp[] {
  const ops: PushDrawOp[] = [
    text(ELECTRA_PANEL_CX, LABEL_Y + LABEL_H / 2, 'ROW', COL_LABEL, 11, 'center', ELECTRA_PANEL_W - 16),
    text(
      ELECTRA_PANEL_CX,
      ELECTRA_ROW_NUM_Y,
      String(v.row),
      COL_VALUE,
      ELECTRA_ROW_NUM_PX,
      'center',
      ELECTRA_PANEL_W - 16,
      'bold',
    ),
  ];
  const selX0 = ELECTRA_PANEL_X + ELECTRA_SEL_PAD_X;
  const cells = cellRects(v.rowCount, selX0, ELECTRA_SEL_W);
  for (let i = 0; i < cells.length; i++) {
    // 'select' semantics, exactly like a named discrete param: ONLY the current
    // cell lights, because "3 of 6 lit" would read as a quantity.
    ops.push(rect(cells[i].x, ELECTRA_SEL_Y, cells[i].w, ELECTRA_SEL_H, i === v.row - 1 ? COL_FILL : COL_CELL_OFF));
  }
  for (let i = 0; i < 2; i++) {
    const strip = ELECTRA_PANEL_STRIP + i;
    ops.push(
      text(stripCenterX(strip), FLAG_Y + FLAG_H / 2, String(strip + 1), COL_FLAG, 9, 'center', STRIP_CONTENT_W),
    );
  }
  return ops;
}

/**
 * Every op needed to paint ELECTRA CONTROL MODE, back to front: background,
 * header, dividers, the six strips, the divider that opens the panel, the panel.
 *
 * On the empty state (no ElectraControl node in the rack) the body is one centred
 * sentence, exactly as the card does — the header still says which mode you are
 * in and which row you are on.
 */
export function renderPushElectra(v: PushElectraView): PushDrawOp[] {
  const ops: PushDrawOp[] = [rect(0, 0, PUSH_SCREEN_W, PUSH_SCREEN_H, COL_BG)];
  ops.push(...renderElectraHeader(v));

  if (v.empty) {
    ops.push(
      text(
        PUSH_SCREEN_W / 2,
        BODY_Y + (PUSH_SCREEN_H - BODY_Y) / 2,
        ELECTRA_EMPTY_MESSAGE,
        COL_MUTED,
        16,
        'center',
        PUSH_SCREEN_W - 48,
      ),
    );
    return ops;
  }

  // Dividers between the six strips, plus the one that separates them from the
  // panel — so the inert pair reads as a single block, not as two dead strips.
  for (let i = 1; i <= ELECTRA_PANEL_STRIP; i++) {
    ops.push(rect(stripX(i), BODY_Y, 1, PUSH_SCREEN_H - BODY_Y, COL_DIVIDER));
  }
  for (let i = 0; i < ELECTRA_PANEL_STRIP; i++) {
    const strip = v.strips[i];
    if (strip) ops.push(...renderStrip(strip, i));
  }
  ops.push(...renderElectraRowPanel(v));
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
