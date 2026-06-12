// packages/web/src/lib/graph/control-surface-layout.ts
//
// CONTROL SURFACE — pure layout geometry.
//
// The surface renders its proxied controls grouped into per-source-module
// boxes. Two layout modes:
//
//   LOCKED (the normal display state) — boxes flow in a wrap layout
//     (`display:flex; flex-wrap:wrap`) and the card grows to fit them
//     (`width: max-content`). No absolute positioning, so nothing can be
//     clipped: every group + every knob is laid out by the browser. The pure
//     helpers here only need to estimate a sensible group box size for tests.
//
//   UNLOCKED (drag-to-rearrange) — boxes are absolutely positioned at their
//     saved `data.layout[moduleId]` (or a default tile). Absolute children do
//     NOT expand their parent, so the `.cs-canvas` must be sized EXPLICITLY
//     from the box positions, else boxes past the first row/column fall
//     outside the (previously fixed-height) canvas and get clipped — which was
//     the "can't add more than ~2 controls" bug. `unlockedCanvasSize()` below
//     computes that bounding size so the canvas (and the card) grow to contain
//     every box.
//
// DETERMINISTIC GRID (the resize bug fix): the constants below are NOT
// estimates — they describe the EXACT grid the card's CSS lays out, so
// `groupBoxHeight()` computes the box's TRUE rendered height and the card /
// canvas always contains its content. The previous geometry assumed
// `KNOBS_PER_ROW = 3` in a 168px box, but each rendered knob cell (the dial +
// its "CC n" MIDI badge + the ✎ rename button) is far wider than 168/3 ≈ 56px,
// so the CSS `flex-wrap` actually wrapped at 2 per row — the lib under-budgeted
// the rows and a 5-knob group spilled below the card frame. We now pin a fixed
// 2-column CSS grid (`grid-template-columns: repeat(2, KNOB_CELL_W)` +
// `grid-auto-rows: KNOB_ROW_H`) so the wrap point can't drift with label width,
// and these constants mirror that grid 1:1. See ControlSurfaceCard.svelte's CSS
// — every constant here has a comment pointing at the rule it tracks.
//
// Pure + DOM-free so the geometry is unit-testable in the node env (the web
// package's vitest runs in `node`, no jsdom).

import type { BindingGroup } from '$lib/graph/control-surface';

// ── KNOB CELL GRID (mirrors `.cs-group-body` + `.cs-knob` in the card CSS) ──
// Each knob cell stacks: a COLOUR STRIPE (the source module's passthrough
// control colour), a DIAL SLOT (the 36px dial + room for its overhanging
// "CC n" MIDI badge), then the (ellipsized) param-name LABEL row, then the ✎
// rename-button row. The button row is reserved even when LOCKED (button
// hidden) so the box height doesn't jump on lock/unlock.
/** Width of one knob cell (px) — `.cs-knob` width + the grid column. */
export const KNOB_CELL_W = 76;
/** Knobs per row — the FIXED grid column count (`repeat(2, …)`). */
export const KNOBS_PER_ROW = 2;
/** Height of one knob-grid row (px) — `grid-auto-rows` on `.cs-group-body`:
 *  colour-stripe(4) + stripe-gap(2) + dial-slot(48) + label(16) +
 *  rename-button(20) + internal slack(4). */
export const KNOB_ROW_H = 94;
/** Gap between cells in the grid, both axes (px) — `.cs-group-body` `gap`. */
export const KNOB_GRID_GAP = 8;

// ── GROUP BOX (mirrors `.cs-group` in the card CSS) ──
/** `.cs-group` horizontal padding+border budget: 1px border ×2 + 6px L + 6px R. */
const BOX_PAD_X = 2 + 12;
/** `.cs-group` vertical padding+border budget: 1px border ×2 + 4px top + 6px bottom. */
const BOX_PAD_Y = 2 + 10;
/** `.cs-group-label` line + bottom margin (px). */
const LABEL_H = 18;

/**
 * Group box width (px). Wide enough for KNOBS_PER_ROW cells across plus the
 * inter-cell gaps and the box's own padding/border — derived from the grid so
 * the lib and CSS can't drift apart.
 */
export const BOX_W =
  BOX_PAD_X + KNOBS_PER_ROW * KNOB_CELL_W + (KNOBS_PER_ROW - 1) * KNOB_GRID_GAP;
/** Horizontal/vertical gap between tiled boxes (px). */
export const GAP = 12;
/** Canvas inset of the first box (px). */
export const ORIGIN = 10;

/** Estimated rendered height (px) of a group box holding `knobCount` knobs. */
export function groupBoxHeight(knobCount: number): number {
  const rows = Math.max(1, Math.ceil(Math.max(0, knobCount) / KNOBS_PER_ROW));
  // rows of cells + the (rows-1) row gaps between them.
  const gridH = rows * KNOB_ROW_H + (rows - 1) * KNOB_GRID_GAP;
  return BOX_PAD_Y + LABEL_H + gridH;
}

export interface Pos {
  x: number;
  y: number;
}

/**
 * Default tile position for the group at `index` when it has no saved layout:
 * rows of 2 boxes, top-left origin. (Matches the historical defaultPos.)
 */
export function defaultPos(index: number): Pos {
  const col = index % 2;
  const row = Math.floor(index / 2);
  // Use a generous, knob-count-agnostic row pitch for the default tile so a
  // fresh surface doesn't overlap; the unlocked canvas size is computed from
  // the ACTUAL per-box height below, so a tall box still gets room. The pitch
  // covers a 2-row box (the common case) + the inter-box gap.
  const rowPitch = groupBoxHeight(4) + GAP;
  return { x: ORIGIN + col * (BOX_W + GAP), y: ORIGIN + row * rowPitch };
}

/** Resolve a group's position: saved layout wins, else the default tile. */
export function posFor(
  layout: Record<string, Pos> | undefined,
  moduleId: string,
  index: number,
): Pos {
  return layout?.[moduleId] ?? defaultPos(index);
}

export interface CanvasSize {
  width: number;
  height: number;
}

/**
 * Bounding size of the `.cs-canvas` in the UNLOCKED (absolute) layout, derived
 * from every group's resolved position + its rendered box size, so the canvas
 * grows to CONTAIN all boxes (nothing clipped) plus an ORIGIN-sized margin.
 *
 * Returns at least the single-box footprint so an empty/one-group surface keeps
 * a sane minimum.
 */
export function unlockedCanvasSize(
  groups: Array<{ moduleId: string; knobCount: number }>,
  layout: Record<string, Pos> | undefined,
): CanvasSize {
  let maxRight = BOX_W + ORIGIN;
  let maxBottom = groupBoxHeight(1) + ORIGIN;
  groups.forEach((g, i) => {
    const pos = posFor(layout, g.moduleId, i);
    const right = pos.x + BOX_W + ORIGIN;
    const bottom = pos.y + groupBoxHeight(g.knobCount) + ORIGIN;
    if (right > maxRight) maxRight = right;
    if (bottom > maxBottom) maxBottom = bottom;
  });
  return { width: Math.ceil(maxRight), height: Math.ceil(maxBottom) };
}

/** Knob count for a binding group (controls that resolved to a ParamDef). */
export function knobCountOf(g: { bindings: BindingGroup['bindings'] }): number {
  return g.bindings.length;
}
