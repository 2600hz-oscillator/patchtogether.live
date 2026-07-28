// packages/web/src/lib/ui/controls/param-grid-model.ts
//
// PURE cell/navigation logic for ParamGrid.svelte — the RACKLINE param picker
// for a discrete param with MANY states whose states are PICTURES rather than
// words (PF-15). Segmented lays ≤6 named states out inline; Selector shows a
// 7+ roster as a one-column list. Neither can show a 32-entry roster whose
// entries are little DIAGRAMS — the DX7's algorithm chart is the case that
// forced this: 32 wiring topologies, and the only readable presentation is the
// chart itself, laid out as a grid.
//
// So ParamGrid renders a CHIP (always in the cell — it is the param's one
// `control-<paramId>` element, the MIDI-assignable root) plus a PORTALED,
// viewport-clamped POPOVER holding the grid. Portaling is what lets it work at
// EVERY tier: a 4x8 diagram grid never has to fit a 46 px lane knob column,
// because it does not live in that column.
//
// Everything here is pure + node-testable; the component is a thin shell over
// these resolvers (the Segmented/Selector precedent).

import type { SelectorOption } from './selector-model';

/** One cell of the picker grid. */
export interface GridCell {
  value: number;
  label: string;
  title?: string;
}

/**
 * Hard ceiling on the DERIVED cell roster.
 *
 * A grid is only meaningful over a small integer range: the derivation walks
 * `min..max` by ones, so declaring `'grid'` on a 0..20000 Hz cutoff would
 * otherwise try to paint twenty thousand cells and hang the tab. 64 covers
 * every plausible topology chart (the DX7's 32 is the largest we know of) with
 * headroom, and the face-lint rule that a `'grid'` param must be `discrete`
 * with a bounded step count is the real guard — this is the belt to its braces.
 */
export const GRID_MAX_CELLS = 64;

/**
 * The cells a param renders in its picker.
 *
 * A DECLARED `options` roster (PF-1) wins — it carries authored labels and
 * titles. Otherwise the roster is derived from the param's integer range, one
 * cell per step, labelled by `format` when the def declares one (PF-3) and by
 * the bare number when it does not. Pure.
 */
export function paramGridCells(
  p: { min: number; max: number; options?: readonly SelectorOption<number>[] },
  format?: (v: number) => string,
): GridCell[] {
  if (p.options?.length) {
    return p.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.title ? { title: o.title } : {}),
    }));
  }
  const lo = Math.ceil(Math.min(p.min, p.max));
  const hi = Math.floor(Math.max(p.min, p.max));
  const out: GridCell[] = [];
  for (let v = lo; v <= hi && out.length < GRID_MAX_CELLS; v++) {
    out.push({ value: v, label: format ? format(v) : String(v) });
  }
  return out;
}

/**
 * The index of the cell NEAREST `value` (-1 for an empty roster).
 *
 * NEAREST rather than exact, for the same reason `nearestSegmentValue` exists:
 * a param ALWAYS has a value, so a picker highlighting nothing is strictly
 * worse than highlighting the state the value is nearest — and an off-detent
 * value is normal (a rack saved before the range changed, a CV-motorized read
 * landing between steps). Ties resolve EARLIER, matching nearestSegmentValue.
 * Pure.
 */
export function nearestGridIndex(value: number, cells: readonly GridCell[]): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const d = Math.abs(cells[i]!.value - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Default column count for `count` cells: at most 8 wide, so 32 lays out as the
 * DX7's own 4-rows-of-8 chart shape and a small roster stays one row. A caller
 * with a real chart order (PR 4's algorithm picker) passes `cols` explicitly.
 * Pure.
 */
export function gridColumns(count: number): number {
  return Math.max(1, Math.min(8, count));
}

/** Keys the grid navigates with (everything else is passed through). */
export type GridNavKey = 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * The focused index after a navigation key — CLAMPED, never wrapping.
 *
 * Wrapping is wrong for a CHART: the 32 algorithms are laid out in the
 * hardware's own order, so ArrowRight off the end of row 4 jumping back to
 * algorithm 1 would read as a glitch, not a feature. Vertical moves that would
 * leave the grid HOLD (a partial last row must not swallow the cursor).
 * `index` may be -1 (nothing focused yet) — any key then lands inside. Pure.
 */
export function gridNavIndex(index: number, key: string, count: number, cols: number): number {
  if (count <= 0) return -1;
  const c = Math.max(1, Math.floor(cols));
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, i));
  switch (key) {
    case 'ArrowRight':
      return clamp(index + 1);
    case 'ArrowLeft':
      return clamp(index - 1);
    case 'ArrowDown':
      return index + c <= count - 1 ? clamp(index + c) : clamp(index);
    case 'ArrowUp':
      return index - c >= 0 ? index - c : clamp(index);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return index < 0 ? index : clamp(index);
  }
}

/**
 * The text the always-visible CHIP shows for `value`. A declared `format`
 * (PF-3) is the authored answer ('ALG 05'); otherwise the nearest cell's label,
 * falling back to the raw number for an empty roster. Pure.
 */
export function gridChipLabel(
  value: number,
  cells: readonly GridCell[],
  format?: (v: number) => string,
): string {
  if (format) return format(value);
  const i = nearestGridIndex(value, cells);
  return i >= 0 ? cells[i]!.label : String(value);
}
