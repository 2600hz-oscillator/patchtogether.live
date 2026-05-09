// packages/web/src/lib/audio/modules/transport-card.ts
//
// Card-side helpers (DOM- and Y.Doc-aware) for handling QuicksaveControls
// callbacks. Each sequencer card provides:
//   - `snapshot()` — capture the current pattern/params into a snapshot object
//   - `applySnapshot(snap)` — apply a snapshot back to node.data + node.params
// and this helper drives the SAVE / LOAD click resolution + persists slot
// state into the patch graph (Y.Doc-synced).

import type { ModuleNode } from '$lib/graph/types';
import {
  coerceSlots,
  coercePendingMode,
  coerceSlotKey,
  defaultSlots,
  resolveSlotClick,
  type PendingMode,
  type SlotKey,
  type SlotMap,
  type Snapshot,
} from './transport-helpers';

/** Lightweight patch shape — accepts both the strict graph/types PatchGraph
 *  AND the SyncedStore-mapped shape (whose nodes record is Partial<...>). */
export interface PatchLike {
  nodes: Record<string, ModuleNode | undefined>;
}

export interface TransportCardDeps {
  nodeId: string;
  patch: PatchLike;
  /** Wrap mutations in a Y.Doc transact. */
  transact: (fn: () => void) => void;
  /** Capture the current pattern/params into a snapshot. */
  snapshot: () => Snapshot;
  /** Apply a snapshot's data into node.data + node.params. The card
   *  decides which keys go where; the helper just hands back the snap. */
  applySnapshot: (snap: Snapshot) => void;
}

/** Read a node.data field, defaulting if absent or wrong shape. */
export function readSlots(node: ModuleNode | undefined): SlotMap {
  const raw = (node?.data as Record<string, unknown> | undefined)?.slots;
  return coerceSlots(raw);
}

export function readPendingMode(node: ModuleNode | undefined): PendingMode {
  const raw = (node?.data as Record<string, unknown> | undefined)?.pendingMode;
  return coercePendingMode(raw);
}

export function readQueuedSlot(node: ModuleNode | undefined): SlotKey | null {
  const raw = (node?.data as Record<string, unknown> | undefined)?.queuedSlot;
  return coerceSlotKey(raw);
}

export function readLastLoadedSlot(node: ModuleNode | undefined): SlotKey | null {
  const raw = (node?.data as Record<string, unknown> | undefined)?.lastLoadedSlot;
  return coerceSlotKey(raw);
}

/** Set a single transport-related field on node.data. */
function setData(deps: TransportCardDeps, key: string, value: unknown): void {
  const target = deps.patch.nodes[deps.nodeId];
  if (!target) return;
  deps.transact(() => {
    if (!target.data) target.data = {};
    (target.data as Record<string, unknown>)[key] = value;
  });
}

export function setPendingMode(deps: TransportCardDeps, mode: PendingMode): void {
  setData(deps, 'pendingMode', mode);
}

export function clearPendingMode(deps: TransportCardDeps): void {
  setPendingMode(deps, null);
}

export function setQueuedSlot(deps: TransportCardDeps, slot: SlotKey | null): void {
  setData(deps, 'queuedSlot', slot);
}

export function setLastLoadedSlot(deps: TransportCardDeps, slot: SlotKey | null): void {
  setData(deps, 'lastLoadedSlot', slot);
}

/** Write a snapshot to a slot. Used by SAVE clicks. Triggers a single
 *  transact so the slot map appears atomic to remote collaborators. */
export function saveToSlot(deps: TransportCardDeps, slot: SlotKey): void {
  const target = deps.patch.nodes[deps.nodeId];
  if (!target) return;
  const snap = deps.snapshot();
  deps.transact(() => {
    if (!target.data) target.data = {};
    const cur = coerceSlots((target.data as Record<string, unknown>).slots);
    cur[slot] = snap;
    (target.data as Record<string, unknown>).slots = { ...cur };
  });
}

/** Apply a slot's snapshot to the node — callable from LOAD clicks and
 *  also from the engine (on QUEUE-driven sequence-end swap). Returns
 *  the slot key on success, null if the slot is empty. */
export function loadFromSlot(deps: TransportCardDeps, slot: SlotKey): SlotKey | null {
  const target = deps.patch.nodes[deps.nodeId];
  if (!target) return null;
  const slots = coerceSlots((target.data as Record<string, unknown> | undefined)?.slots);
  const snap = slots[slot];
  if (!snap) return null;
  deps.applySnapshot(snap);
  setLastLoadedSlot(deps, slot);
  return slot;
}

/** Resolve a slot button click. Reads pendingMode, dispatches save/load/
 *  queue, then clears pendingMode. Returns the action that fired (for
 *  test introspection). */
export function handleSlotClick(deps: TransportCardDeps, slot: SlotKey): 'save' | 'load' | 'queue' | 'noop' {
  const target = deps.patch.nodes[deps.nodeId];
  if (!target) return 'noop';
  const pending = readPendingMode(target);
  const action = resolveSlotClick(pending, slot);
  switch (action.kind) {
    case 'save':
      saveToSlot(deps, slot);
      clearPendingMode(deps);
      return 'save';
    case 'load':
      loadFromSlot(deps, slot);
      clearPendingMode(deps);
      // LOAD clears any pending queue too.
      setQueuedSlot(deps, null);
      return 'load';
    case 'queue':
      setQueuedSlot(deps, slot);
      clearPendingMode(deps);
      return 'queue';
    case 'noop':
      return 'noop';
  }
}

/** Re-export defaults so cards have one import surface. */
export { defaultSlots, coerceSlots };
