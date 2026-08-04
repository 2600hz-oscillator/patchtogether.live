// packages/web/src/lib/control/push2/push-electra-model.ts
//
// ELECTRA CONTROL MODE — the pure view model behind the Push 2's third display
// mode. Enter it with the lower-right "Shift" button (CC 49, a plain press
// TOGGLE) and the six leftmost display encoders become ONE ROW of the rack's
// ELECTRA CONTROL 6×6 grid; the two rightmost encoders go inert and the space
// above them becomes a ROW readout you scroll with the scroll encoder (CC 15).
//
// The owner's framing: "in this way we can use grid to fully replace an electra
// controller, albeit one row at a time and without touchscreen functions or our
// mixmasters/control views. we're just doing the control part."
//
// ── WHY A "ROW" IS SIX CONTROLS, NOT TWELVE ───────────────────────────────
//
// An ElectraControl node stores a FIXED 6×6 grid of 36 slots (`ELECTRA_ROWS` ×
// `ELECTRA_KNOBS`, graph/electra-control.ts). That grid is the app's own model of
// the Electra One page: three stacked 2-row banks, each bank one of the device's
// three 12-pot control sets, each bank's top sub-row pots 1-6 and bottom sub-row
// pots 7-12. So a ROW is six controls, rows are numbered 1..6 top to bottom, and
// `slotIndex(row, knob)` is the storage key — the SAME geometry the card renders
// and the SAME one `electraPosOfSlot` flashes to the hardware. Nothing here
// invents a layout; six is the grid's own row width.
//
// ── THE NAME AND THE STATUS MUST BE THE CARD'S, NOT A SECOND OPINION ──────
//
// The spec says the strip shows "the same name/status info that we see on
// electra / the card". Both come from shared expressions rather than from
// re-derivation:
//
//   · NAME   — `electraSlotLabel(binding, def.label)`, the single function
//              `ElectraControlCard.svelte` also calls. Custom name else param
//              label, one place.
//   · STATUS — `pushStrip()` from push-card-model.ts, unchanged. That routes the
//              readout through `knobReadout` and the bar position through
//              `knobValueToFrac` — the same two functions `Knob`/`KnobConic`
//              print and draw from. The Push strip and the card's dial therefore
//              agree BY CONSTRUCTION, including on log curves, bipolar zero
//              anchors and named discrete states.
//
// The custom name reaches `pushStrip` as a ParamDef with its `label` swapped,
// which is why the readout stays the param's real one: only the label moves.
//
// PURE — no store, no registry, no engine. The live wiring (which node, which
// param, what value) is injected as `resolveSlot`.

import type { ParamDef } from '$lib/graph/types';
import { ELECTRA_KNOBS, ELECTRA_ROWS, slotIndex, bankForRow } from '$lib/graph/electra-control';
import { pushStrip, emptyStrip, type PushStripView } from './push-card-model';
import type { PushEncoderTarget } from './push2-map';

/** Rows in the grid — re-exported so the Push layer never re-derives 6. */
export const ELECTRA_MODE_ROWS = ELECTRA_ROWS; // 6
/** Encoders that drive controls in this mode — the grid's row width. */
export const ELECTRA_MODE_KNOBS = ELECTRA_KNOBS; // 6

/**
 * What a display encoder does IN ELECTRA CONTROL MODE.
 *
 * `inert` is a REAL answer, not a missing one. The owner's spec assigns encoders
 * 1-6 and the scroll encoder and says nothing about encoders 7 and 8; rather than
 * invent a function for them they are declared to do NOTHING, which is a state a
 * gate can assert and a later PR can change deliberately. Deny by default.
 */
export type PushElectraEncoder =
  /** Display encoder 1..6 → the row's knob 1..6. */
  | { kind: 'knob'; knob: number }
  /** The scroll encoder (CC 15) → step the selected ROW. */
  | { kind: 'rowScroll' }
  /** The MASTER encoder (CC 79) → mixmstrs master_volume, unchanged in this
   *  mode: it is not one of the eight, it sits beside the physical master
   *  level, and the spec never asked for it. */
  | { kind: 'master' }
  /** Display encoders 7 and 8 — deliberately unassigned in this mode. */
  | { kind: 'inert' };

/**
 * Re-interpret an already-classified encoder target for ElectraControl mode.
 *
 * It takes the `PushEncoderTarget` the SHIPPING classifier produced rather than a
 * raw CC, so there is exactly ONE CC→encoder map in the codebase and this cannot
 * drift away from it. TOTAL over the target type — every target has an answer
 * here, so a new encoder target added to the map fails to compile until this
 * mode says what it does. PURE.
 */
export function electraModeEncoder(target: PushEncoderTarget): PushElectraEncoder {
  switch (target.kind) {
    case 'strip':
      return target.index < ELECTRA_MODE_KNOBS
        ? { kind: 'knob', knob: target.index + 1 }
        : { kind: 'inert' }; // display encoders 7 and 8
    case 'moduleScroll':
      return { kind: 'rowScroll' };
    case 'master':
      return { kind: 'master' };
  }
}

/**
 * Step the selected row by `delta` detents, WRAPPING at both ends.
 *
 * Wrap, not clamp — the same choice `stepLaneFocus` makes for the card flip, and
 * for the same reason: with six positions and no visible end stop, a clamp reads
 * as a broken encoder when you are already on row 6. Clamps the raw delta so a
 * hard flick moves one row per detent rather than spinning the list. PURE.
 */
export function stepElectraRow(row: number, delta: number): number {
  const n = ELECTRA_MODE_ROWS;
  const cur = Number.isFinite(row) ? Math.trunc(row) : 1;
  const base = ((cur - 1) % n + n) % n; // 0-based, tolerant of a corrupt input
  const step = Math.trunc(Number.isFinite(delta) ? delta : 0);
  if (step === 0) return base + 1;
  return (((base + step) % n) + n) % n + 1;
}

/** A slot resolved against the live rack: its ParamDef, its current value, and
 *  the name the card shows for it. */
export interface ElectraSlotResolved {
  def: ParamDef;
  value: number;
  /** Already through `electraSlotLabel` — custom name else param label. */
  label: string;
}

export interface PushElectraView {
  /** The ElectraControl node's display name (`electraName`). '' when absent. */
  surfaceName: string;
  /** 1-based selected row. */
  row: number;
  /** Always `ELECTRA_MODE_ROWS`. */
  rowCount: number;
  /** The Electra bank this row belongs to — 'TOP' / 'MID' / 'BOT'. The device's
   *  own vocabulary (`ELECTRA_BANKS`), so a row number on the Push names the
   *  same band the card's bank header does. */
  bank: string;
  /** ALWAYS length `ELECTRA_MODE_KNOBS` (6), knob 1..6 left to right. An
   *  unassigned or unresolvable slot is an `empty` strip — the grid is sparse by
   *  design, so a blank knob is normal, not an error. */
  strips: readonly PushStripView[];
  /** Non-null when the mode has nothing to drive at all. */
  empty: null | 'no-surface';
}

/**
 * The whole ElectraControl-mode view for one row. PURE.
 *
 * `surfaceName === null` means the rack has no ElectraControl node — a real
 * state (the mode is reachable from any rack), reported as `empty: 'no-surface'`
 * rather than as six blank knobs, because "there is no surface" and "the surface
 * has an empty row" are different answers and the screen should say which.
 */
export function pushElectraView(args: {
  surfaceName: string | null;
  row: number;
  resolveSlot: (slot: number) => ElectraSlotResolved | null;
}): PushElectraView {
  const row = clampRow(args.row);
  const bank = bankForRow(row).label;
  if (args.surfaceName === null) {
    return {
      surfaceName: '',
      row,
      rowCount: ELECTRA_MODE_ROWS,
      bank,
      strips: Array.from({ length: ELECTRA_MODE_KNOBS }, (_, i) => emptyStrip(i + 1)),
      empty: 'no-surface',
    };
  }
  const strips: PushStripView[] = [];
  for (let knob = 1; knob <= ELECTRA_MODE_KNOBS; knob++) {
    const r = args.resolveSlot(slotIndex(row, knob));
    if (!r) {
      strips.push(emptyStrip(knob));
      continue;
    }
    // Swap ONLY the label so the readout, the bar, the pips and the cells all
    // stay the param's own — see the header note.
    const def = r.label === r.def.label ? r.def : { ...r.def, label: r.label };
    strips.push(pushStrip(def, r.value, knob));
  }
  return {
    surfaceName: args.surfaceName,
    row,
    rowCount: ELECTRA_MODE_ROWS,
    bank,
    strips,
    empty: null,
  };
}

/** Fold any number into 1..ELECTRA_MODE_ROWS. Defensive: the row is persisted
 *  to localStorage, so a hand-edited or older value must not paint row 0. */
export function clampRow(row: number): number {
  if (!Number.isFinite(row)) return 1;
  return Math.max(1, Math.min(ELECTRA_MODE_ROWS, Math.trunc(row)));
}
