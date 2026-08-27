// packages/web/src/lib/audio/modules/score-layout.ts
//
// WHERE A NOTE IS DRAWN — the staff's pixel geometry, as pure functions.
//
// ⚠ THIS EXISTS SO THE TWO RENDERERS CANNOT DISAGREE. `ScoreCard.svelte` and
// the faceplate's `ScoreStaffPanel.svelte` both draw the same document, and
// both must map a pointer to the same (bar, tick, step) that they map that cell
// back to a pixel with. Re-typing `BAR_W` in the second renderer would let a
// click land one bar away from where the notehead paints, on one surface only —
// the same drift the scheduler-grid note in `score-data.ts` is about, one layer
// up. Every constant here has exactly one home.
//
// The GRID itself (TICKS_PER_BAR, quantizeTick, canPlace, staffStepToMidi) is
// NOT re-derived here; it is imported from `score-data.ts`, which is the module
// the ENGINE reads. This file is only about pixels.

import { BARS_PER_ROW, BARS_PER_PAGE, ROWS_PER_PAGE, TICKS_PER_BAR } from './score-data';

/**
 * The staff's drawing width in SVG user units.
 *
 * ⚠ IT IS A COLLISION FLOOR, NOT A TASTE NUMBER, and the arithmetic is the
 * whole argument for the faceplate's width. `TICK_PX` is 3.375, so a sixteenth
 * (3 ticks) puts adjacent noteheads 10.1 px apart against an 18 px notehead
 * glyph — already overlapping at 720. Take 20 % off and a sixteenth run is
 * 8.1 px apart, which is not "tight", it is unreadable. The alternative that
 * would be narrower is fewer bars per row, and 2 bars × 8 rows is 694 px TALL,
 * which overflows the dock's own `min(60vh, 680px)` fold.
 */
export const SCORE_WIDTH = 720;
export const ROW_LEFT_PAD = 60; // clef + key-signature gutter
export const ROW_RIGHT_PAD = 12;
export const ROW_INNER_W = SCORE_WIDTH - ROW_LEFT_PAD - ROW_RIGHT_PAD;
export const BAR_W = ROW_INNER_W / BARS_PER_ROW;
export const TICK_PX = BAR_W / TICKS_PER_BAR;

export const STAFF_LINE_GAP = 8; // px between adjacent staff lines
export const STAFF_STEP_PX = STAFF_LINE_GAP / 2; // 4 px per staff step
export const ROW_HEIGHT = 80;
export const ROW_TOP_PAD = 18;
export const STAFF_LINES = 5;

export const SCORE_HEIGHT = ROW_TOP_PAD + ROWS_PER_PAGE * ROW_HEIGHT + 36;

/** Y of the top staff line for the i-th row on the visible page. */
export function rowTopLineY(rowIdx: number): number {
  return ROW_TOP_PAD + rowIdx * ROW_HEIGHT;
}

/** Page index for an absolute bar. */
export function pageOf(bar: number): number {
  return Math.floor(bar / BARS_PER_PAGE);
}

/** Row index (0..ROWS_PER_PAGE-1) within the bar's page. */
export function rowOf(bar: number): number {
  const local = bar - pageOf(bar) * BARS_PER_PAGE;
  return Math.floor(local / BARS_PER_ROW);
}

/** Local bar within its row (0..BARS_PER_ROW-1). */
export function rowLocalBar(bar: number): number {
  const local = bar - pageOf(bar) * BARS_PER_PAGE;
  return local % BARS_PER_ROW;
}

export function topLineY(bar: number): number {
  return rowTopLineY(rowOf(bar));
}

export function barLeftX(bar: number): number {
  return ROW_LEFT_PAD + rowLocalBar(bar) * BAR_W;
}

export function noteX(bar: number, tick: number): number {
  return barLeftX(bar) + tick * TICK_PX + 6;
}

export function noteY(bar: number, staffStep: number): number {
  return topLineY(bar) + staffStep * STAFF_STEP_PX;
}

export function dynamicYForBar(bar: number): number {
  return topLineY(bar) + (STAFF_LINES - 1) * STAFF_LINE_GAP + 18;
}

/** Pixel y → a row index on the current page. */
export function yToRowIdx(py: number): number {
  const r = Math.floor((py - ROW_TOP_PAD + ROW_HEIGHT * 0.6) / ROW_HEIGHT);
  return Math.max(0, Math.min(ROWS_PER_PAGE - 1, r));
}

export function yToStep(rowIdx: number, py: number): number {
  return Math.round((py - rowTopLineY(rowIdx)) / STAFF_STEP_PX);
}

export interface ScoreCell {
  bar: number;
  tick: number;
  step: number;
}

/**
 * SVG-space (px, py) → (bar, tick, step) on `currentPage`, or null when the
 * point is outside the staff's drawable area or past the last allocated bar.
 *
 * ⚠ TAKES SVG USER UNITS, NOT CLIENT COORDINATES. The client→user conversion
 * needs a `getBoundingClientRect`, which is a DOM read and belongs in the
 * component; keeping it out of here is what makes this function testable in the
 * node lane, where the placement/playback drift would actually be caught.
 */
export function cellAt(px: number, py: number, currentPage: number, totalPages: number): ScoreCell | null {
  const rowIdx = yToRowIdx(py);
  const step = yToStep(rowIdx, py);
  if (px < ROW_LEFT_PAD || px > ROW_LEFT_PAD + ROW_INNER_W + 4) return null;
  const localBar = Math.min(
    BARS_PER_ROW - 1,
    Math.max(0, Math.floor((px - ROW_LEFT_PAD) / BAR_W)),
  );
  const bar = currentPage * BARS_PER_PAGE + rowIdx * BARS_PER_ROW + localBar;
  if (bar >= totalPages * BARS_PER_PAGE) return null;
  const xInBar = px - barLeftX(bar) - 6;
  const rawTick = Math.max(0, Math.min(TICKS_PER_BAR - 1, Math.round(xInBar / TICK_PX)));
  return { bar, tick: rawTick, step };
}

/** Client coordinates → score cell, given the element the staff is drawn in. */
export function cellFromClient(
  el: SVGSVGElement,
  clientX: number,
  clientY: number,
  currentPage: number,
  totalPages: number,
): ScoreCell | null {
  const rect = el.getBoundingClientRect();
  const px = ((clientX - rect.left) / rect.width) * SCORE_WIDTH;
  const py = ((clientY - rect.top) / rect.height) * SCORE_HEIGHT;
  return cellAt(px, py, currentPage, totalPages);
}
