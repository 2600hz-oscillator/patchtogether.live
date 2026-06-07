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
// Pure + DOM-free so the geometry is unit-testable in the node env (the web
// package's vitest runs in `node`, no jsdom).

import type { BindingGroup } from '$lib/graph/control-surface';

/** Group box width (px). Wide enough for up to 3 knobs across. */
export const BOX_W = 168;
/** Horizontal/vertical gap between tiled boxes (px). */
export const GAP = 12;
/** Canvas inset of the first box (px). */
export const ORIGIN = 10;

// Group-box vertical geometry (must track the card's CSS so the unlocked
// canvas height we compute actually contains the rendered box). A box is:
//   label row + a knob grid that wraps every KNOBS_PER_ROW knobs.
const BOX_PAD_Y = 4 + 6; // .cs-group top + bottom padding
const LABEL_H = 16; // .cs-group-label line + margin
const KNOB_ROW_H = 56; // a knob (36px dial) + its label + row gap
const KNOBS_PER_ROW = 3; // a BOX_W box fits ~3 knobs across

/** Estimated rendered height (px) of a group box holding `knobCount` knobs. */
export function groupBoxHeight(knobCount: number): number {
  const rows = Math.max(1, Math.ceil(Math.max(0, knobCount) / KNOBS_PER_ROW));
  return BOX_PAD_Y + LABEL_H + rows * KNOB_ROW_H;
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
  // the ACTUAL per-box height below, so a tall box still gets room.
  return { x: ORIGIN + col * (BOX_W + GAP), y: ORIGIN + row * 150 };
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
