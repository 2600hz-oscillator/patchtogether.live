// packages/web/src/lib/ui/workflow/dock-row-plan.ts
//
// PF-21 — the DOCK FACEPLATE's ROW PLAN: which SECTION BANDS share a horizontal
// row, so a faceplate stops being one tall column of one-band-per-row strips.
//
// ── THE OWNER'S RULE (2026-08-03, from sixstrum's dock face) ────────────────
//
//   "we need to make better use of horizontal space and not be so vertical…
//    here 2 and 3 can be on the same row, and probably 4 and 5 as well. it's
//    okay to have 2 (or more) clearly labeled distinct sections on the same
//    row. 10 controls is probably the most we should have on a row, so work
//    with that."
//
// This is a PLATFORM behaviour, not a per-face declaration. A face spec says
// what a faceplate DECLARES (`face.pages`); the platform says how it READS —
// the same split the readouts-below-the-hero and hints-are-annotation-only
// decisions landed under, both of which needed zero spec edits. So NOTHING in
// any module def changes here: the row plan is derived from the bands
// `dockFacePlan` already produced.
//
// ── THE RULE, AS IMPLEMENTED ────────────────────────────────────────────────
//
//  1. A TABBED face never packs. `dockTabPlan` hides all but the active band,
//     so "two sections on a row" is not a layout the face can even show — and
//     an empty flex row for each hidden band is worse than nothing. This is
//     also why pentemelodica and cloudseed are UNTOUCHED by this change: they
//     trip DOCK_TAB_MIN_BANDS and render as rails.
//
//  2. A band carrying a WIDE cell is SOLO — it takes a row of its own. Measured
//     off the live dock (20 faces, 104 cells, a 1220 px pane): every KNOB
//     COLUMN renders 40–68.8 px wide, and every non-column cell renders
//     94.3–560 px (segmented 94.3 / 107.3 / 430.9, selector 168, file 114.6,
//     panel 300 / 560). That is a clean bimodal gap, and it is why the split is
//     drawn at the cell KIND rather than at a width estimate the model would
//     have to invent: `cellWidthClass` reads the SAME declaration the shell
//     renders from (`paramCellKind` / `shellCellFor`), so a control that grows
//     an `options` roster re-classifies itself and its band stops packing on
//     the same commit. It is DENY-BY-DEFAULT: a cell the classifier cannot
//     resolve counts as WIDE, so an unknown width never packs.
//
//  3. Every remaining run of consecutive packable bands is packed so no row
//     holds more than DOCK_ROW_MAX_CONTROLS cells.
//
//  4. A band that alone exceeds the ceiling still gets a row — a section is
//     ATOMIC and is never split across rows (see `packRun`).
//
// ── WHAT THIS MODEL DOES *NOT* DECIDE, AND WHY ──────────────────────────────
//
// ⚠ IT DOES NOT MODEL WIDTH IN PIXELS, ON PURPOSE. `DOCK_ROW_MAX_CONTROLS` is
// a FLAT CONSTANT — the owner's legibility ceiling — and it is NOT derived from
// the available width, does not scale with the pane, and would not change if
// the dock doubled in size. Stating that plainly because this repo has been
// bitten repeatedly by constants that LOOK derived and are flat.
//
// The PHYSICAL constraint is enforced where it can actually be measured: the
// row is a `flex-wrap: wrap` container in ModuleShell, so a row that genuinely
// does not fit degrades into the stacked layout it has today instead of
// overflowing the faceplate. That is deliberate — `card-control-overflow`
// reports VIEWPORT-SCALED pixels under xyflow's zoom transform, so any px
// budget written here could not be validated against the number that spec
// prints anyway. The browser owns the physics; this model owns the intent.

import type { ParamDef } from '$lib/graph/types';
import type { DockFaceBand, FaceControl } from './curated-face';
import { dockTabPlan } from './dock-tabs-model';
import {
  declaredParamCells,
  momentaryParamIds,
  paramCellKind,
  type DeclaredParamCell,
  type ParamCellKind,
} from './shell-control-kind';
import { shellCellFor } from './shell-cells';

/**
 * The owner's ceiling: the most CONTROL CELLS one row may carry.
 *
 * ⚠ FLAT, not derived. See the file header — this is a legibility number the
 * owner set by eye ("10 controls is probably the most we should have on a
 * row"), and nothing in the codebase computes it from the dock's width.
 */
export const DOCK_ROW_MAX_CONTROLS = 10;

/**
 * How wide a cell is, in the only two classes that matter for packing.
 *
 *   'column' — a knob column: a KnobConic, a <Toggle> switch, a momentary pad,
 *              or a family/static ACTION button. Measured 40–68.8 px.
 *   'wide'   — a roster or a picture: a <Segmented> row, a <Selector>, a
 *              <ParamGrid> chip, a file import, or a bespoke PANEL. Measured
 *              94.3–560 px, i.e. between 1.4× and 8× a knob column.
 */
export type DockCellWidthClass = 'column' | 'wide';

/**
 * The width class of every PARAM cell kind, EXHAUSTIVE OVER `ParamCellKind`.
 *
 * ⚠ THIS IS A `Record`, NOT A CHAIN OF `===`, AND THAT IS THE POINT. The chain
 * it replaces listed the column kinds and let everything else fall to the
 * deny-by-default `wide` arm — which is the correct answer for an UNRESOLVABLE
 * cell (see `cellWidthClass`) and the wrong one for a kind that simply had not
 * been added yet. Those two cases were indistinguishable, so `fader` (#1464)
 * silently classified as a 560px-wide roster while `ModuleShell` rendered it as
 * a 22px column, and every band holding one would have gone solo. A
 * `Record<ParamCellKind, …>` makes the next new kind a COMPILE error (TS2741,
 * missing property) instead of a silent default — the author has to answer the
 * question rather than inherit an answer.
 *
 * Measured widths behind each entry (live dock, 20 faces, 104 cells, 1220px
 * pane): knob columns 40–68.8px; segmented 94.3 / 107.3 / 430.9; selector 168;
 * grid chip 120–168; colour swatch 56; fader track 22.
 */
export const PARAM_CELL_WIDTH_CLASS: Record<ParamCellKind, DockCellWidthClass> = {
  // Paints inside one `.kcol` column.
  knob: 'column',
  toggle: 'column',
  momentary: 'column',
  // A 56px swatch at hero — narrower than a knob's 64px column.
  color: 'column',
  // `ModuleShell`'s fader branch renders `<div class="kcol ms-cell-fader">` and
  // `Fader.svelte`'s track is 22px wide. noise could not surface this (one
  // param, promoted to the hero, zero bands, so no fader ever reached a band);
  // marbles is the first face to put faders IN bands, and while this said
  // 'wide' every one of its six bands would have taken a row of its own.
  fader: 'column',
  // Rosters and pictures — 1.4× to 8× a knob column, so they hold a row.
  segmented: 'wide',
  selector: 'wide',
  grid: 'wide',
};

/** The def fields the row plan reads. A superset of nothing else — it needs the
 *  module TYPE (to resolve family/static cells through `shellCellFor`) and the
 *  full ParamDef list (to resolve a param's rendered primitive). */
export interface RowPlanDefLike {
  type?: string;
  params?: readonly ParamDef[];
  face?: {
    momentary?: readonly string[];
    paramCells?: Readonly<Record<string, DeclaredParamCell>>;
  };
}

/**
 * Which width class a curated control renders as AT THE DOCK.
 *
 * ⚠ DENY BY DEFAULT. A param with no matching ParamDef, and a family/static key
 * with no registered shell cell, both resolve to 'wide' — because the honest
 * answer is "unknown", and an unknown-width cell must not be packed beside
 * another section. (Both cases are already loud failures elsewhere:
 * module-face-lint fails an orphaned face key, and an unregistered family key
 * renders as the INERT cell that fails the same gate plus faces-parity. This
 * function only decides that the layout stays conservative meanwhile.)
 *
 * Pure — it reads the SAME two resolvers the shell renders from, so the class
 * cannot drift from what actually paints.
 */
export function cellWidthClass(ctl: FaceControl, def: RowPlanDefLike | undefined): DockCellWidthClass {
  if (ctl.kind === 'param') {
    const pd = (def?.params ?? []).find((p) => p.id === (ctl.paramId ?? ctl.key));
    if (!pd) return 'wide';
    const kind = paramCellKind(pd, momentaryParamIds(def), 'dock', declaredParamCells(def));
    // One table, exhaustive over the kind union — see PARAM_CELL_WIDTH_CLASS
    // for why this is a Record and not a chain of `===`.
    return PARAM_CELL_WIDTH_CLASS[kind];
  }
  const cell = shellCellFor(def?.type ?? '', ctl);
  if (!cell) return 'wide';
  // An ACTION is a <Button> in a knob column (measured 42.8–82.8 px); a FILE
  // import is the same primitive with a long caption (114.6 px) and a status
  // line under it, a SELECTOR is a 168 px chip, and a PANEL declares its own
  // `minWidth` (280–560 px). Only the first two of those stay in a column.
  return cell.kind === 'action' || cell.kind === 'toggle' ? 'column' : 'wide';
}

/** Every cell a band paints — un-clustered first, then each cluster's, the same
 *  flattening `dockPlanControls` uses for one band. */
function bandCells(band: DockFaceBand): FaceControl[] {
  return [...band.controls, ...band.clusters.flatMap((c) => c.controls)];
}

/** How many CONTROL CELLS a band paints — the quantity the owner's ceiling
 *  counts. Clustered cells count: a cluster is a caption inside the band, not a
 *  separate section. */
export function bandControlCount(band: DockFaceBand): number {
  return bandCells(band).length;
}

/**
 * May this band SHARE a row? Only when every one of its cells is a knob column
 * (see `cellWidthClass`). A band carrying a roster, a grid chip, a file import
 * or a bespoke panel keeps a row to itself.
 *
 * ⚠ This is the rule that keeps sixstrum's `1 · instrument · chord` on its own
 * row — it carries the 14-entry PRESET selector — which is exactly the shape
 * the owner's own example asked for (2+3 and 4+5 paired, 1 left alone). It is
 * also what keeps dx7's `operators` band, whose two panels declare 280 px and
 * 560 px floors, from being packed beside two other sections.
 */
export function bandIsPackable(band: DockFaceBand, def: RowPlanDefLike | undefined): boolean {
  return bandCells(band).every((c) => cellWidthClass(c, def) === 'column');
}

/** One rendered row of the dock faceplate: one or more section bands, in
 *  declaration order. A row of ONE is the layout every faceplate has today. */
export interface DockFaceRow {
  /** Stable key for the `{#each}` — the ids of its bands, joined. */
  id: string;
  bands: DockFaceBand[];
  /** Total control cells on this row (the ceiling's quantity). */
  controls: number;
}

/** The comparison the packer optimises, in strict priority order. */
interface PackCandidate {
  rows: number;
  /** The largest row's CONTROL COUNT (fewest-rows ties break on evenness). */
  max: number;
  /**
   * Each row's CONTROL COUNT, in order — the final tie-break.
   *
   * ⚠ CONTROLS, NOT BANDS — and the reason to say so is that the two ARE THE
   * SAME ORDER here, which is not obvious and is worth recording rather than
   * rediscovering. A first draft compared band counts. Trying to write a test
   * that told them apart proved it cannot exist: rows are PREFIXES, so a
   * longer first row has both more sections and (every band holding ≥ 1 cell)
   * more weight. The two lexicographic orders are therefore identical for any
   * plan `heroFacePlan` can produce, since it already drops emptied bands.
   *
   * Weight is kept because it is the quantity the rule is ABOUT ("lightest row
   * first / no runt final row") and because the equivalence rests on that
   * ≥ 1-cell precondition — if a zero-cell band ever reached this packer the
   * band-count version would silently start answering a different question.
   */
  weights: number[];
  /** Each row's BAND count, in order — used only to rebuild the groups. */
  lens: number[];
}

function better(a: PackCandidate, b: PackCandidate): boolean {
  // 1. FEWEST ROWS — the owner asked for less vertical sprawl, and row count is
  //    height. Greedy first-fit already achieves the minimum here; the rest of
  //    this comparison only chooses AMONG the minimal-row partitions.
  if (a.rows !== b.rows) return a.rows < b.rows;
  // 2. EVENEST — minimise the largest row, so one row is never a wall of ten
  //    knobs beside a neighbour holding two.
  if (a.max !== b.max) return a.max < b.max;
  // 3. HEAVIEST ROW LAST — the lexicographically smallest sequence of row
  //    CONTROL COUNTS. This is the paragraph-balancing rule (no runt final
  //    line), and it is what turns sixstrum's [3,3,3,6] into (3+3) then (3+6)
  //    rather than (3+3+3) then (6): both are two rows with a max of 9 — so
  //    rules 1 and 2 tie — and (6,9) is lexicographically before (9,6).
  const n = Math.min(a.weights.length, b.weights.length);
  for (let i = 0; i < n; i++) {
    if (a.weights[i] !== b.weights[i]) return a.weights[i] < b.weights[i];
  }
  return a.weights.length < b.weights.length;
}

/**
 * Pack ONE run of consecutive packable bands into rows of at most `cap` cells.
 *
 * Returns the row SIZES (band counts per row). O(n²) exact DP rather than
 * greedy first-fit: greedy is optimal in ROW COUNT but not in the two
 * tie-breaks above, and the tie-break is load-bearing (see `better`).
 *
 * ⚠ A SECTION IS NEVER SPLIT. `counts[i] > cap` is allowed to occupy a row by
 * itself rather than being broken up: half a section's knobs under its label
 * and half under nothing destroys the identity the label exists to give, which
 * is the thing that makes two sections on one row legible in the first place.
 * (Its own cells still WRAP inside the section — `.page-controls` has always
 * been `flex-wrap` — which is a different thing: they stay under one label.)
 */
export function packRun(counts: readonly number[], cap = DOCK_ROW_MAX_CONTROLS): number[][] {
  const n = counts.length;
  if (n === 0) return [];
  // best[i] = the optimal packing of counts[i..n-1]
  const best: (PackCandidate | null)[] = new Array(n + 1).fill(null);
  best[n] = { rows: 0, max: 0, weights: [], lens: [] };
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let j = i; j < n; j++) {
      sum += counts[j];
      // A row may exceed the cap ONLY when it is a single (over-sized) band.
      if (j > i && sum > cap) break;
      const tail = best[j + 1]!;
      const cand: PackCandidate = {
        rows: 1 + tail.rows,
        max: Math.max(sum, tail.max),
        weights: [sum, ...tail.weights],
        lens: [j - i + 1, ...tail.lens],
      };
      if (!best[i] || better(cand, best[i]!)) best[i] = cand;
    }
  }
  // Re-walk the chosen row lengths into index groups.
  const out: number[][] = [];
  let at = 0;
  for (const len of best[0]!.lens) {
    out.push(Array.from({ length: len }, (_, k) => at + k));
    at += len;
  }
  return out;
}

/**
 * THE ROW PLAN for a dock faceplate.
 *
 * TOTAL by construction: the rows flatten to EXACTLY the input bands, in the
 * SAME order, each exactly once (`dockRowPlanIsTotal` asserts it, and
 * module-face-lint runs that over every faced module). Packing must not be able
 * to lose a section — that would be the `dockFacePlan` control-loss class one
 * level up.
 *
 * `tabbed` defaults to reading `dockTabPlan(bands)` so the two consumers cannot
 * disagree about whether a face is railed; pass it explicitly only in tests.
 */
export function dockRowPlan(
  bands: readonly DockFaceBand[] | null | undefined,
  def: RowPlanDefLike | undefined,
  opts?: { tabbed?: boolean; cap?: number },
): DockFaceRow[] {
  if (!bands || !bands.length) return [];
  const row = (bs: DockFaceBand[]): DockFaceRow => ({
    id: bs.map((b) => b.id).join('+'),
    bands: bs,
    controls: bs.reduce((n, b) => n + bandControlCount(b), 0),
  });

  const tabbed = opts?.tabbed ?? dockTabPlan(bands) !== null;
  // A RAIL shows one band at a time — there is no "beside" to pack into.
  if (tabbed) return bands.map((b) => row([b]));

  const cap = opts?.cap ?? DOCK_ROW_MAX_CONTROLS;
  const out: DockFaceRow[] = [];
  let run: DockFaceBand[] = [];
  const flushRun = () => {
    if (!run.length) return;
    const counts = run.map((b) => bandControlCount(b));
    for (const group of packRun(counts, cap)) out.push(row(group.map((i) => run[i])));
    run = [];
  };
  for (const band of bands) {
    if (bandIsPackable(band, def)) {
      run.push(band);
      continue;
    }
    flushRun();
    out.push(row([band]));
  }
  flushRun();
  return out;
}

/**
 * THE TOTALITY CHECK — did the row plan account for EXACTLY the bands it was
 * given, in order, none dropped and none duplicated?
 *
 * Same role (and the same reason) as `heroFacePlanIsTotal`: the dangerous
 * operation here is REGROUPING, and a regrouping bug looks like a faceplate
 * that quietly lost a section. This runs over every faced module in the unit
 * lane in milliseconds.
 */
export function dockRowPlanIsTotal(
  before: readonly DockFaceBand[] | null | undefined,
  rows: readonly DockFaceRow[],
): boolean {
  const a = (before ?? []).map((b) => b.id);
  const b = rows.flatMap((r) => r.bands.map((x) => x.id));
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
