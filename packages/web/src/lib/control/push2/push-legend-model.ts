// packages/web/src/lib/control/push2/push-legend-model.ts
//
// LEGEND MODE — on-device documentation for the Push 2's 960×160 display, and
// the pure model behind it. Hold the LEGEND button (`PUSH_CC_LEGEND`) and the
// screen becomes 2 rows × 8 slices naming what the surrounding buttons do IN THE
// CURRENT VIEW; release and the previous screen comes back. DISPLAY-ONLY: no
// button changes what it does, and there is no mode to get stuck in.
//
// ── THE POINT OF THE FEATURE: IT CANNOT GO STALE ──────────────────────────
//
// The owner's requirement was "this text should be tied to the code such that
// the module can't get out of date with the explanation text." So every cell
// below is produced by ONE of exactly two mechanisms, and neither is a
// hand-maintained parallel list:
//
//   (a) The ROUTING TABLE ITSELF carries the legend. `TOP_ROW_BINDINGS`,
//       `GRID_SHIFT_BINDINGS`, `CLIP_RIGHT_BINDINGS` and `KEYS_ARP_BINDINGS`
//       (launchpad-map.ts) each hold `{ action, legend }` in ONE row: the
//       dispatch reads `.action`, this file reads `.legend`. One entry, two
//       consumers — a new button cannot be routed without being named.
//
//   (b) The legend is COMPUTED FROM THE DISPATCH CLASSIFIER'S OWN RETURN VALUE,
//       for the positional columns where there is no table to hang text on:
//         · Grid scene launch  → `slotForScene(sceneForWindowIndex(offset, i))`
//           — the SAME call `handleSceneLaunch` makes, so "SCENE 12" is 12
//           because the dispatch would fire scene 12, scroll offset included.
//         · Control per-lane STOP → `controlRight(i)` returns the lane; the text
//           is that lane. Re-map the column and the legend re-maps with it.
//         · Top-row SHIFT layer → `armTopLane(cc)` returns the lane it arms.
//         · KEYS scale column → `keysScaleRight(i)` returns the scale it writes.
//       These cannot drift because there is nothing to keep in sync: change the
//       classifier and the sentence changes in the same expression.
//
// `push-legend-model.test.ts` then holds the line in BOTH directions — a cell
// that dispatches with no legend is red, and a legend with nothing behind it is
// red — with two PERMANENT negative controls (a fake bound-but-unnamed entry and
// a fake named-but-unbound entry) so the gate is re-proven on every run rather
// than at authoring time.
//
// ── SCOPE, STATED SO IT IS NOT READ AS COVERAGE ───────────────────────────
//
// This models the TWO layers the owner asked for — base and SHIFT — of the TWO
// button rows the display can sit above:
//   · BOTTOM row of cells → the 8 function buttons UNDER the display
//     (Push CC 20..27 → Launchpad top CC 91..98), cell i over button i.
//   · TOP row of cells → the 8 SCENE buttons beside the grid (Push CC 43 at the
//     TOP … 36 at the BOTTOM), cell i = scene index i, so LEFT→RIGHT reads
//     TOP→BOTTOM. That is the codebase's own scene-index convention
//     (`sceneIndexForCc`), not a new one.
// It does NOT model: the 8×8 pad matrix, the encoders, the D-Pad, the
// channel-select row above the display, or the third-layer modifiers (GRID-held
// repeat counts, latched PROB pages, copy/paste arms). Those are deliberate
// omissions, not gaps the gate is failing to see — `legendScope()` names them.

import {
  TOP_ROW_BINDINGS,
  GRID_SHIFT_BINDINGS,
  CLIP_RIGHT_BINDINGS,
  KEYS_ARP_BINDINGS,
  topRowBinding,
  topRowAction,
  armTopLane,
  gridShiftRight,
  clipRight,
  controlRight,
  keysScaleRight,
  keysArpShiftRight,
  sceneForWindowIndex,
  slotForScene,
  isEditExitSceneRow,
  type SingleView,
} from '$lib/control/launchpad/launchpad-map';
import { LP_HEIGHT } from '$lib/control/launchpad/launchpad-sysex';
import type { LaunchpadLegendContext } from '$lib/control/launchpad/launchpad-control.svelte';

/** Cells per legend row — the 8 scene buttons / the 8 function buttons. */
export const LEGEND_CELLS = 8;

/**
 * One legend cell.
 *
 * `label: ''` is a REAL answer, not a missing one: it means "this button does
 * nothing here" (the Arranger view routes no scene presses at all; SHIFT has no
 * shift layer of its own). `bound: false` says the same thing in a form a gate
 * can assert, which is what keeps "unbound" and "undocumented" distinguishable.
 */
export interface PushLegendCell {
  /** 0..7, left→right on screen. */
  index: number;
  /** What the button does here, or '' when it does nothing. */
  label: string;
  /** Does a press at this position dispatch anything in this context? */
  bound: boolean;
  /** The position marker drawn small above the label ('S1'..'S8' / '1'..'8'). */
  tag: string;
}

/** Which physical row a legend row documents. */
export type PushLegendRowId = 'scene' | 'function';

export interface PushLegendRow {
  id: PushLegendRowId;
  /** Row caption, e.g. 'SCENE COLUMN (right of grid)'. */
  caption: string;
  cells: readonly PushLegendCell[];
}

export interface PushLegendView {
  /** The view being documented, e.g. 'clip' — or the mode that took it over. */
  context: string;
  /** Is the SHIFT layer showing? */
  shift: boolean;
  /** Documents the 8 SCENE buttons beside the grid (drawn as the TOP row). */
  scene: PushLegendRow;
  /** Documents the 8 function buttons under the display (drawn as the BOTTOM
   *  row, directly above the physical buttons it names). */
  function: PushLegendRow;
  /** Set when nothing is routing at all (no clip-player bound). */
  note: string | null;
}

/** What this legend covers, and — just as importantly — what it does not. Read
 *  by the gate so the scope is asserted rather than assumed. */
export function legendScope(): {
  covered: readonly string[];
  uncovered: readonly string[];
} {
  return {
    covered: ['scene column (base + SHIFT)', 'function row (base + SHIFT)'],
    uncovered: [
      '8×8 pad matrix',
      'display encoders',
      'D-Pad',
      'channel-select row above the display',
      'GRID-held repeat-count layer',
      'latched PROB / PLAY-EVERY pages',
      'copy/paste arm targets',
    ],
  };
}

// ---------------------------------------------------------------------------
// Cell builders. Each is a thin wrapper over the classifier the ROUTER calls.
// ---------------------------------------------------------------------------

function cell(index: number, tag: string, label: string): PushLegendCell {
  return { index, tag, label, bound: label !== '' };
}

/** The legend of a scene button in a table-driven column: the row's own text. */
function fromBinding(
  index: number,
  binding: { legend: string; shiftLegend: string | null } | undefined,
  shift: boolean,
): PushLegendCell {
  if (!binding) return cell(index, sceneTag(index), '');
  const label = shift ? (binding.shiftLegend ?? binding.legend) : binding.legend;
  return cell(index, sceneTag(index), label);
}

/** 'S1'..'S8' — S1 is the TOP scene button (Push CC 43). */
function sceneTag(index: number): string {
  return `S${index + 1}`;
}

/**
 * The GRID view's scene column with no modifier: a straight scene launch. The
 * NUMBER comes from the exact pair of calls `handleSceneLaunch` makes, so a
 * scrolled window is reported honestly and an out-of-range slot reads as
 * unbound rather than as "scene 65".
 */
function gridSceneLaunchCell(index: number, sceneScrollOffset: number): PushLegendCell {
  const scene = sceneForWindowIndex(sceneScrollOffset, index);
  const slot = slotForScene(scene);
  return cell(index, sceneTag(index), slot === null ? '' : `SCENE ${scene + 1}`);
}

/**
 * The CONTROL view's scene column: per-lane STOP. `controlRight` IS the router's
 * classifier and it returns the LANE, so the printed number is the lane the
 * press stops — re-map the column and this re-maps with it.
 */
function controlStopCell(index: number): PushLegendCell {
  const lane = controlRight(index);
  return cell(index, sceneTag(index), lane === null ? '' : `STOP L${lane + 1}`);
}

/**
 * The KEYS view's no-shift scene column. `keysScaleRight` returns the value that
 * is WRITTEN to `clip.scale` (or the arp toggle), so the label is the write.
 */
function keysScaleCell(index: number): PushLegendCell {
  const r = keysScaleRight(index);
  if (r === null) return cell(index, sceneTag(index), '');
  if (r === 'arpToggle') return cell(index, sceneTag(index), 'ARP ON/OFF');
  // `{ scale: undefined }` is chromatic — the ABSENCE of a scale, deliberately
  // not the string 'chromatic' (see keysScaleRight).
  return cell(index, sceneTag(index), (r.scale ?? 'chromatic').toUpperCase());
}

/**
 * The LENGTH page takes over the whole device; only the EXIT scene row routes.
 * `isEditExitSceneRow` takes a BOTTOM-ORIGIN row, and a legend cell index is
 * TOP-origin, hence the flip — the same one `sceneIndexForCc` encodes.
 */
function lengthEditSceneCell(index: number): PushLegendCell {
  const row = LP_HEIGHT - 1 - index;
  return cell(index, sceneTag(index), isEditExitSceneRow(row) ? 'EXIT' : '');
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** Caption for the scene row, naming the view/mode it documents. */
function sceneCaption(ctx: LaunchpadLegendContext): string {
  if (ctx.mode === 'lengthEdit') return 'SCENE COLUMN · LENGTH PAGE';
  if (ctx.mode === 'keys') return 'SCENE COLUMN · KEYS';
  return `SCENE COLUMN · ${ctx.view.toUpperCase()}`;
}

/**
 * The 8 SCENE buttons beside the grid, for the current view/mode/shift layer.
 * The branch order MIRRORS `handleSingleKey`: length-edit takes over first, then
 * KEYS, then the active view — because a legend that branched in a different
 * order would document a view the press would not reach.
 */
export function sceneLegendRow(ctx: LaunchpadLegendContext): PushLegendRow {
  const idx = Array.from({ length: LEGEND_CELLS }, (_, i) => i);
  const cells = idx.map((i): PushLegendCell => {
    if (ctx.mode === 'lengthEdit') return lengthEditSceneCell(i);
    if (ctx.mode === 'keys') {
      return ctx.shift
        ? fromBinding(i, KEYS_ARP_BINDINGS[keysArpIndex(i)], false)
        : keysScaleCell(i);
    }
    switch (ctx.view) {
      case 'grid':
        return ctx.shift
          ? fromBinding(i, GRID_SHIFT_BINDINGS[gridShiftIndex(i)], false)
          : gridSceneLaunchCell(i, ctx.sceneScrollOffset);
      case 'clip':
        return fromBinding(i, CLIP_RIGHT_BINDINGS[clipRightIndex(i)], ctx.shift);
      case 'control':
        return controlStopCell(i);
      case 'arranger':
        // The Arranger view routes NO pad or scene press (handleSingleKey's
        // `case 'arranger': break`). Eight legitimately empty cells.
        return cell(i, sceneTag(i), '');
    }
  });
  return { id: 'scene', caption: sceneCaption(ctx), cells };
}

// The three index helpers below exist so the legend NEVER indexes a binding
// table the router would not have consulted: each asks the router's own
// classifier whether position i resolves, and only then reads the row. A table
// that grew an entry the classifier rejects therefore paints blank (and the
// gate goes red) instead of silently advertising a button that does nothing.
function gridShiftIndex(i: number): number {
  return gridShiftRight(i) === null ? -1 : i;
}
function clipRightIndex(i: number): number {
  return clipRight(i) === null ? -1 : i;
}
function keysArpIndex(i: number): number {
  return keysArpShiftRight(i) === null ? -1 : i;
}

/**
 * The 8 function buttons UNDER the display (Push CC 20..27 → Launchpad top CC
 * 91..98, left→right). This row NEVER changes meaning per view — that is a
 * property of `topRowAction`, not an assumption here — so the base layer reads
 * the same in every view, which is itself worth showing.
 *
 * The SHIFT layer is the PER-LANE AUTOMATION ARM, and its lane comes from
 * `armTopLane(cc)` — the very classifier `handleTopRow` consults before
 * consuming the press. Column 7 is the SHIFT button itself, which has no shift
 * function: a legitimately empty cell, and the one the gate's
 * "empty ≠ missing" case is built on.
 */
export function functionLegendRow(ctx: LaunchpadLegendContext): PushLegendRow {
  const cells = TOP_ROW_BINDINGS.map((b, i): PushLegendCell => {
    const tag = String(i + 1);
    if (!ctx.shift) {
      // Ask the ROUTER, not the table: a row the classifier no longer resolves
      // must read as unbound even though its text is sitting right there.
      return cell(i, tag, topRowAction(b.cc) === null ? '' : b.legend);
    }
    const lane = armTopLane(b.cc);
    return cell(i, tag, lane === null ? '' : `ARM L${lane + 1}`);
  });
  return {
    id: 'function',
    caption: ctx.shift ? 'FUNCTION ROW · SHIFT (arm lane)' : 'FUNCTION ROW (below screen)',
    cells,
  };
}

/**
 * The whole legend for the CURRENT routing state. PURE — hand it a context and
 * it returns text; it reads no store, no device and no clock.
 */
export function pushLegendView(ctx: LaunchpadLegendContext): PushLegendView {
  const contextName =
    ctx.mode === 'lengthEdit' ? 'LENGTH' : ctx.mode === 'keys' ? 'KEYS' : ctx.view.toUpperCase();
  return {
    context: contextName,
    shift: ctx.shift,
    scene: sceneLegendRow(ctx),
    function: functionLegendRow(ctx),
    note: ctx.bound ? null : 'no clip player bound — these buttons route nowhere yet',
  };
}

/** Every cell of a legend, both rows — the gate's iteration seam. */
export function legendCells(v: PushLegendView): readonly PushLegendCell[] {
  return [...v.scene.cells, ...v.function.cells];
}

/** The `cc` the function-row cell at `index` documents (91..98). Exposed so the
 *  gate can ask the ROUTER about the same button the legend just named. */
export function functionCellCc(index: number): number | null {
  return TOP_ROW_BINDINGS[index]?.cc ?? null;
}

/** Every (view, mode, shift) combination the legend can be asked for — the
 *  gate's sweep. `edit` is a PAIR-mode mode and never reached in single. */
export function legendContexts(): readonly LaunchpadLegendContext[] {
  const views: readonly SingleView[] = ['grid', 'clip', 'arranger', 'control'];
  const modes: readonly LaunchpadLegendContext['mode'][] = ['session', 'keys', 'lengthEdit'];
  const out: LaunchpadLegendContext[] = [];
  for (const view of views) {
    for (const mode of modes) {
      for (const shift of [false, true]) {
        out.push({
          deployment: 'single',
          view,
          mode,
          shift,
          gridHeld: false,
          sceneScrollOffset: 0,
          bound: true,
        });
      }
    }
  }
  return out;
}

/** Re-export so the gate + the layout never re-derive the binding shape. */
export { topRowBinding };
