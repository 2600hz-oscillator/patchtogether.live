// packages/web/src/lib/graph/electra-control.ts
//
// ELECTRA CONTROL — data model + geometry + helpers.
//
// A sibling of control-surface.ts. Where a Control Surface stores a flat,
// position-agnostic `data.bindings[]` (first-seen, auto-grouped), an
// ElectraControl stores an EXPLICIT POSITIONAL map: a fixed 6×6 grid (36 slots)
// laid out exactly for the Electra One. Each filled slot is a POINTER to another
// module's control (the SAME {moduleId, paramId, name?} `ControlBinding` shape) —
// NOT a copy of state. A proxied control on the card reads + writes the SOURCE
// module's live param directly and is keyed for MIDI by the same moduleId:paramId,
// so a MIDI assignment on the proxy === the assignment on the source, the same
// control can live in multiple slots/surfaces, and there's no per-proxy state to
// drift.
//
// Geometry (the single piece of new mapping math, unit-tested in
// electra-control.test.ts):
//
//   slotIndex(row, knob) = (row-1)*6 + (knob-1)        // 0..35, the data-map key
//
//   electraPosOf(row, knob):
//     controlSetId = ceil(row / 2)        // rows 1-2 → set 1 (TOP), 3-4 → set 2
//                                         //   (MIDDLE), 5-6 → set 3 (BOTTOM)
//     potId        = (row odd ? 0 : 6) + knob   // odd row = a band's TOP sub-row
//                                               //   (pots 1-6); even row = its
//                                               //   BOTTOM sub-row (pots 7-12)
//
//   NOTE: the storage ordering (slotIndex = row-major) is NOT the same as the
//   firmware's control-set-then-pot walk. Do NOT derive (controlSetId, potId)
//   from a naive `floor(slot/12)+1` / `slot%12+1` — those orderings differ at
//   the band boundaries. Always go through electraPosOf(rowKnobOf(slot)) (i.e.
//   electraPosOfSlot). Anchors pinned by the unit test: Row2→2 = cs1/pot8/slot7;
//   Row6→6 = cs3/pot12/slot35 (rightmost knob of the bottom row of the bottom
//   bank — the canonical "last" slot).
//
// All persistent state lives on the node's `data` (Yjs-synced). The live
// mutators below mutate node.data IN PLACE (set/delete a single key) inside a
// LOCAL_ORIGIN transaction — they must NEVER rebuild-and-reassign a map/array
// that holds already-integrated Yjs types (the [[yjs-save-load-real-ydoc]]
// "Type already integrated" trap that broke the second send-to-surface). The
// pure with* helpers are for unit assertions only.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import type { ControlBinding } from '$lib/graph/control-surface';

export const ELECTRA_CONTROL_TYPE = 'electraControl';

/** Fixed grid dimensions — 6 rows × 6 knobs = 36 slots, NEVER dynamic. */
export const ELECTRA_ROWS = 6;
export const ELECTRA_KNOBS = 6;
export const ELECTRA_SLOT_COUNT = ELECTRA_ROWS * ELECTRA_KNOBS; // 36

/** The three 2-row banks, top to bottom, mirroring the Electra's control sets.
 *  `controlSetId` 1 = TOP, 2 = MIDDLE, 3 = BOTTOM. `rows` are the 1-based task
 *  rows that belong to the bank. */
export const ELECTRA_BANKS: ReadonlyArray<{
  label: string;
  controlSetId: number;
  rows: readonly [number, number];
}> = [
  { label: 'TOP', controlSetId: 1, rows: [1, 2] },
  { label: 'MID', controlSetId: 2, rows: [3, 4] },
  { label: 'BOT', controlSetId: 3, rows: [5, 6] },
] as const;

export interface ElectraControlData {
  name?: string;
  /** slot index "0".."35" → binding. Sparse: empty slots are simply absent.
   *  The card derives the fixed 6×6 visual grid from the (row, knob)
   *  enumeration, NOT from this map, so empties render empty regardless of
   *  sparsity. */
  slots?: Record<string, ControlBinding>;
}

// ──────────────────────────── pure geometry ────────────────────────────

/** Slot index 0..35 for a 1-based (row, knob). Row-major. */
export function slotIndex(row: number, knob: number): number {
  return (row - 1) * ELECTRA_KNOBS + (knob - 1);
}

/** Inverse of slotIndex: a 0..35 slot index → its 1-based (row, knob). */
export function rowKnobOf(slot: number): { row: number; knob: number } {
  return {
    row: Math.floor(slot / ELECTRA_KNOBS) + 1,
    knob: (slot % ELECTRA_KNOBS) + 1,
  };
}

/** The (controlSetId, potId) on the Electra page for a 1-based (row, knob).
 *  See the file header for the derivation; this is the §2 bijection. */
export function electraPosOf(row: number, knob: number): { controlSetId: number; potId: number } {
  const controlSetId = Math.ceil(row / 2); // 1=TOP, 2=MIDDLE, 3=BOTTOM
  const bandTopRow = row % 2 === 1; // odd row = band's top sub-row (pots 1-6)
  const potId = (bandTopRow ? 0 : 6) + knob; // 1-6 (top) or 7-12 (bottom)
  return { controlSetId, potId };
}

/** (controlSetId, potId) for a 0..35 storage slot index. Routes through the §2
 *  formula (NOT a naive floor(slot/12)+1) so band-boundary slots map correctly. */
export function electraPosOfSlot(slot: number): { controlSetId: number; potId: number } {
  const { row, knob } = rowKnobOf(slot);
  return electraPosOf(row, knob);
}

/** The bank (TOP/MIDDLE/BOTTOM) a 1-based row belongs to. */
export function bankForRow(row: number): { label: string; controlSetId: number } {
  const controlSetId = Math.ceil(row / 2);
  return { label: ELECTRA_BANKS[controlSetId - 1]?.label ?? '', controlSetId };
}

// ──────────────────────────── pure readers ────────────────────────────

/** Coerce a node's `data` into a typed ElectraControlData (never throws). */
export function readElectraData(node: { data?: unknown } | undefined): ElectraControlData {
  const d = node?.data;
  if (!d || typeof d !== 'object') return {};
  return d as ElectraControlData;
}

/** Display name for an ElectraControl (falls back to a stable default). */
export function electraName(node: { data?: unknown } | undefined): string {
  const name = readElectraData(node).name;
  return typeof name === 'string' && name.trim().length > 0 ? name : 'Electra Control';
}

/** Every electraControl node in the patch, id-sorted, with its name. */
export function listElectraControls(
  nodes: Record<string, ModuleNode | undefined>,
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || node.type !== ELECTRA_CONTROL_TYPE) continue;
    out.push({ id, name: electraName(node) });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** The binding occupying a slot (or undefined). */
export function bindingAtSlot(data: ElectraControlData, slot: number): ControlBinding | undefined {
  return data.slots?.[String(slot)];
}

/** True if a slot is occupied. */
export function hasSlotBinding(data: ElectraControlData, slot: number): boolean {
  return data.slots?.[String(slot)] !== undefined;
}

/** The slot index a given (moduleId, paramId) is assigned to, or null. The
 *  same control can only occupy one slot in a given ElectraControl (re-assigning
 *  it to a new slot moves it). Returns the LOWEST occupied slot for the pointer
 *  if it somehow lands in several. */
export function slotForBinding(
  data: ElectraControlData,
  moduleId: string,
  paramId: string,
): number | null {
  const slots = data.slots;
  if (!slots) return null;
  let found: number | null = null;
  for (const [key, b] of Object.entries(slots)) {
    if (b.moduleId === moduleId && b.paramId === paramId) {
      const s = Number(key);
      if (found === null || s < found) found = s;
    }
  }
  return found;
}

// ──────────── pure with* helpers (unit assertions only — NOT live writes) ────────────

/** Return a NEW slots map with `slot` set to a binding for (moduleId, paramId). */
export function withSlotAssigned(
  data: ElectraControlData,
  slot: number,
  moduleId: string,
  paramId: string,
): Record<string, ControlBinding> {
  return { ...(data.slots ?? {}), [String(slot)]: { moduleId, paramId } };
}

/** Return a NEW slots map with `slot` removed. */
export function withSlotCleared(data: ElectraControlData, slot: number): Record<string, ControlBinding> {
  const next = { ...(data.slots ?? {}) };
  delete next[String(slot)];
  return next;
}

// ─────────────────────── ydoc mutators (side-effecting) ───────────────────────
//
// Each writes a SINGLE slot key in place inside one LOCAL_ORIGIN transaction.
// CRITICAL: never rebuild-and-reassign `data.slots` (or any sub-object that has
// already synced into a Y.Map) — once integrated, spreading it into a fresh
// object re-integrates already-integrated Y types and Yjs throws "Type already
// integrated" (the same trap that broke the second send-to-surface). Set/delete
// a single key; existing entries are untouched. (See control-surface.ts:163-173.)

function mutateElectra(id: string, fn: (data: ElectraControlData) => void): void {
  ydoc.transact(() => {
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    fn(target.data as ElectraControlData);
  }, LOCAL_ORIGIN);
}

/** Assign (or OVERWRITE) the slot at index `slot` with a pointer to
 *  (moduleId, paramId). Re-assigning a slot replaces its binding. If the SAME
 *  pointer already occupies a DIFFERENT slot, that older slot is cleared first
 *  (a control lives in at most one slot of a given ElectraControl), so dragging
 *  it to a new position MOVES rather than duplicates. */
export function assignSlotToElectra(
  id: string,
  slot: number,
  moduleId: string,
  paramId: string,
): void {
  mutateElectra(id, (data) => {
    if (!data.slots) data.slots = {};
    // If this exact pointer already sits in another slot, free that slot in
    // place first (delete a single key — never spread the map).
    for (const [key, b] of Object.entries(data.slots)) {
      if (key !== String(slot) && b.moduleId === moduleId && b.paramId === paramId) {
        delete data.slots[key];
      }
    }
    // Write a NEW plain object at the slot; it integrates cleanly. (Overwriting
    // an occupied slot is a plain re-assign of one key.)
    data.slots[String(slot)] = { moduleId, paramId };
  });
}

/** Clear the binding at `slot` (delete a single key in place). */
export function clearSlot(id: string, slot: number): void {
  mutateElectra(id, (data) => {
    if (!data.slots) return;
    delete data.slots[String(slot)];
  });
}

/** Set (or clear, with an empty/blank string) the CUSTOM display name of the
 *  binding at `slot`, mutating the existing binding object's `name` key in place
 *  — NEVER spreading/reassigning the slots map (see the CRITICAL note above). */
export function setSlotName(id: string, slot: number, name: string): void {
  mutateElectra(id, (data) => {
    const target = data.slots?.[String(slot)];
    if (!target) return;
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      target.name = trimmed; // set a single key on the existing (live) binding
    } else {
      delete target.name; // clearing reverts to the param label / auto abbrev
    }
  });
}

/** Drop any slot whose source module no longer exists in the patch. Conservative
 *  — only removes a binding when we are CERTAIN the source module is absent (a
 *  not-yet-loaded source on page-load / mid-sync is left alone). Splices keys in
 *  place inside one LOCAL_ORIGIN transaction; no-op (and no transaction, so no
 *  churn) when nothing dangles. Returns the number of slots cleared. Safe to call
 *  on every graph change (mirrors pruneSurfaceDangling). */
export function pruneElectraDangling(id: string): number {
  const data = readElectraData(patch.nodes[id]);
  const slots = data.slots;
  if (!slots) return 0;
  const dead = Object.entries(slots).filter(([, b]) => !patch.nodes[b.moduleId]);
  if (dead.length === 0) return 0;
  ydoc.transact(() => {
    const live = patch.nodes[id];
    if (!live?.data) return;
    const d = live.data as ElectraControlData;
    if (!d.slots) return;
    for (const [key, b] of Object.entries(d.slots)) {
      if (!patch.nodes[b.moduleId]) delete d.slots[key]; // remove in place
    }
  }, LOCAL_ORIGIN);
  return dead.length;
}
