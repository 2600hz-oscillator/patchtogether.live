// packages/web/src/lib/graph/automation-assign.ts
//
// MODULE → AUTOMATION-LANE assignment writes (owner-locked final model: "we
// assign entire modules to a lane, they get the border"). The synced model is
// `ClipPlayerData.autoAssign` — a sparse map `moduleNodeId → laneIndex` on each
// clip-player node. ONE lane per module GLOBALLY: assigning moves the key
// (removing it from every other player and lane first), so a module is never
// recorded by two lanes at once.
//
// Writes are in-place single-key mutations inside ONE LOCAL_ORIGIN transaction
// (undoable, never a map spread — [[yjs-save-load-real-ydoc]]). Reads are the
// pure clip-types helpers (`coerceAutoAssign` et al).
//
// PRUNE (mirrors control-surface-params.pruneSurfaceDangling): when an assigned
// MODULE is deleted, its assignment lingers in node.data. Pruning follows the
// multi-surface discipline — `pruneAllAutoAssignDangling` sweeps EVERY
// clip-player (called from the Canvas graph-change seam, so it runs even when
// no clipplayer card is mounted), and the card's $effect additionally calls the
// per-player `pruneAutoAssignDangling`. Both are conservative (module-absent
// only), no-ops when nothing dangles, and transactional when something does.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

/** Transaction origin for JANITOR writes (the dangling-assignment prune + the
 *  duplicate-assignment repair). Deliberately NOT the undo-tracked
 *  LOCAL_ORIGIN: the janitor runs on EVERY client from the graph-change seam,
 *  so a peer-driven module deletion would otherwise plant phantom undo items
 *  on every OTHER client's stack — and undoing past one would livelock
 *  (restore → re-prune → a fresh item) while wiping redo. A non-tracked
 *  origin still SYNCS (any origin does); it just never enters any client's
 *  undo scope. Janitor writes are idempotent by construction (delete-if-
 *  present), so every peer running them concurrently converges. */
export const AUTO_JANITOR_ORIGIN = Symbol('automation-janitor');
import {
  automationTargetKey,
  parseAutomationTargetKey,
  coerceAutoAssign,
  assignedLaneOfModule,
  laneOf,
  CLIP_LANES,
  type AutomationTarget,
  type ClipPlayerData,
} from '$lib/audio/modules/clip-types';

/** Every clip-player node id in the patch (they ALL accept assignments now —
 *  no stamped automation clip required). */
export function listClipPlayers(
  nodes: Record<string, { type?: string } | undefined>,
): string[] {
  const out: string[] = [];
  for (const [nid, node] of Object.entries(nodes)) {
    if (node?.type === 'clipplayer') out.push(nid);
  }
  return out;
}

/** Where MODULE `moduleId` is currently assigned — the (player, lane) pair, or
 *  null. When several players claim the same module (a transient merge state),
 *  the LOWEST player node id wins — the same deterministic tie-break the card
 *  border uses. PURE read. */
export function automationAssignmentFor(
  nodes: Record<string, { type?: string; data?: unknown } | undefined>,
  moduleId: string,
): { nodeId: string; lane: number } | null {
  for (const nid of listClipPlayers(nodes).sort()) {
    const lane = assignedLaneOfModule(
      nodes[nid]?.data as ClipPlayerData | undefined,
      moduleId,
    );
    if (typeof lane === 'number') return { nodeId: nid, lane };
  }
  return null;
}

/** ASSIGN module `moduleId` to `lane` on clip-player `playerId` — the module
 *  card's right-click "Assign to automation lane ▸ N". ONE lane per module: the
 *  key is removed from every other player (and its old lane here) in the SAME
 *  transaction, so the move is atomic + a single undo step. Clamped lane;
 *  no-op on a bad player / a non-existent module / self-assignment. */
export function assignAutomationLane(
  playerId: string,
  moduleId: string,
  lane: number,
  origin: unknown = LOCAL_ORIGIN,
): void {
  const L = Math.max(0, Math.min(CLIP_LANES - 1, Math.trunc(lane)));
  if (typeof moduleId !== 'string' || moduleId.length === 0 || moduleId.includes('::')) return;
  if (!patch.nodes[moduleId]) return; // assign only a live module
  if (patch.nodes[playerId]?.type !== 'clipplayer') return;
  if (moduleId === playerId) return; // a player never automates itself
  ydoc.transact(() => {
    for (const nid of listClipPlayers(patch.nodes)) {
      const live = patch.nodes[nid] as ModuleNode | undefined;
      if (!live) continue;
      if (nid === playerId) {
        if (!live.data) live.data = {};
        const d = live.data as ClipPlayerData;
        if (!d.autoAssign) d.autoAssign = {};
        d.autoAssign[moduleId] = L; // single-key in-place write (move = overwrite)
      } else {
        const d = live.data as ClipPlayerData | undefined;
        if (d?.autoAssign && moduleId in d.autoAssign) delete d.autoAssign[moduleId];
      }
    }
  }, origin);
}

/** REMOVE module `moduleId`'s automation assignment from whichever player holds
 *  it — the module card's "Remove automation assignment". One transaction. */
export function removeAutomationAssignment(moduleId: string): void {
  const holders = listClipPlayers(patch.nodes).filter((nid) => {
    const d = (patch.nodes[nid] as ModuleNode | undefined)?.data as ClipPlayerData | undefined;
    return !!d?.autoAssign && moduleId in coerceAutoAssign(d.autoAssign);
  });
  if (holders.length === 0) return;
  ydoc.transact(() => {
    for (const nid of holders) {
      const d = (patch.nodes[nid] as ModuleNode | undefined)?.data as ClipPlayerData | undefined;
      if (d?.autoAssign && moduleId in d.autoAssign) delete d.autoAssign[moduleId];
    }
  }, LOCAL_ORIGIN);
}

/** The raw `auto` map of a clip-player node (untyped read). */
function autoMapOf(nid: string): Record<string, { tracks?: Record<string, unknown> } | null> | undefined {
  const d = (patch.nodes[nid] as ModuleNode | undefined)?.data as ClipPlayerData | undefined;
  return d?.auto as Record<string, { tracks?: Record<string, unknown> } | null> | undefined;
}

/** True when `target` (one CONTROL) has RECORDED envelopes in ANY clip of any
 *  player — the control menu's "Clear recorded automation" shows only when
 *  there is something to clear. PURE read. */
export function hasRecordedAutomation(
  nodes: Record<string, { type?: string; data?: unknown } | undefined>,
  target: AutomationTarget,
): boolean {
  const key = automationTargetKey(target);
  for (const nid of listClipPlayers(nodes)) {
    const auto = (nodes[nid]?.data as ClipPlayerData | undefined)?.auto;
    if (!auto || typeof auto !== 'object') continue;
    for (const rec of Object.values(auto)) {
      const tracks = (rec as { tracks?: Record<string, unknown> } | null)?.tracks;
      if (tracks && typeof tracks === 'object' && key in tracks) return true;
    }
  }
  return false;
}

/**
 * CLEAR `target`'s RECORDED envelopes — the per-CONTROL delete affordance
 * (recording is module-scoped, deleting stays control-precise). Scope: when the
 * control's MODULE is ASSIGNED, delete its track from every clip in the
 * module's assigned lane on that player; when UNASSIGNED, delete it from EVERY
 * clip on every player (no lane to scope by). A record left with zero tracks
 * is deleted too (no empty-shell litter). ONE LOCAL_ORIGIN transaction (a
 * single undo step). Returns the number of tracks removed.
 */
export function clearRecordedAutomation(target: AutomationTarget): number {
  const key = automationTargetKey(target);
  const holder = automationAssignmentFor(patch.nodes, target.nodeId);
  // Collect (player, clipKey) hits first so the transaction only opens when
  // there is something to delete.
  const hits: { nid: string; clipKey: string }[] = [];
  for (const nid of listClipPlayers(patch.nodes)) {
    if (holder && nid !== holder.nodeId) continue; // assigned → only its player
    const auto = autoMapOf(nid);
    if (!auto) continue;
    for (const [clipKey, rec] of Object.entries(auto)) {
      if (holder && laneOf(Number(clipKey)) !== holder.lane) continue; // assigned → only its lane
      const tracks = rec?.tracks;
      if (tracks && typeof tracks === 'object' && key in tracks) hits.push({ nid, clipKey });
    }
  }
  if (hits.length === 0) return 0;
  ydoc.transact(() => {
    for (const { nid, clipKey } of hits) {
      const auto = autoMapOf(nid);
      const rec = auto?.[clipKey];
      const tracks = rec?.tracks;
      if (!auto || !tracks || !(key in tracks)) continue;
      delete tracks[key];
      if (Object.keys(tracks).length === 0) delete auto[clipKey]; // no empty shells
    }
  }, LOCAL_ORIGIN);
  return hits.length;
}

/** Delete ONE clip's whole automation record (`auto[clipIndex]`) — the card
 *  editor's per-clip "CLR AUTO". ONE LOCAL_ORIGIN transaction (undoable).
 *  Returns true when something was deleted. */
export function clearClipAutomation(playerId: string, clipIdx: number): boolean {
  const auto = autoMapOf(playerId);
  const k = String(clipIdx);
  if (!auto || auto[k] === undefined || auto[k] === null) return false;
  ydoc.transact(() => {
    const live = autoMapOf(playerId);
    if (live && live[k] !== undefined) delete live[k];
  }, LOCAL_ORIGIN);
  return true;
}

/** The dangling assignment keys on player `playerId` — iterates the RAW map
 *  (not the coerced view) so retired `nodeId::paramId` keys arriving over
 *  sync MID-SESSION are treated as always-dangling too (the factory sweep is
 *  load-only; this seam retires them on running clients). PURE. */
function danglingAssignKeys(playerId: string): string[] {
  const live = patch.nodes[playerId] as ModuleNode | undefined;
  if (live?.type !== 'clipplayer') return [];
  const raw = (live.data as ClipPlayerData | undefined)?.autoAssign;
  if (!raw || typeof raw !== 'object') return [];
  return Object.keys(raw).filter(
    (key) => key.length === 0 || key.includes('::') || !patch.nodes[key],
  );
}

/** Drop every assignment on player `playerId` whose MODULE no longer exists
 *  (module-absent only — the conservative, unambiguous case; mirrors
 *  `bindingDefinitelyDangling` case 1) plus any retired `::`-form key. JANITOR
 *  write: in-place deletes inside one NON-undo-tracked AUTO_JANITOR_ORIGIN
 *  transaction (never pollutes any client's undo stack); NO transaction when
 *  nothing dangles. Safe to call on every graph change. Returns the number
 *  removed. */
export function pruneAutoAssignDangling(playerId: string): number {
  const dangling = danglingAssignKeys(playerId);
  if (dangling.length === 0) return 0;
  ydoc.transact(() => {
    const d = (patch.nodes[playerId] as ModuleNode | undefined)?.data as
      | ClipPlayerData
      | undefined;
    if (!d?.autoAssign) return;
    for (const key of dangling) {
      if (key in d.autoAssign) delete d.autoAssign[key];
    }
  }, AUTO_JANITOR_ORIGIN);
  return dangling.length;
}

/** Sweep EVERY clip-player for dangling module assignments — the multi-surface
 *  prune (control-surface discipline): runs from the Canvas graph-change seam,
 *  so a deleted module's assignment is dropped even when no clipplayer CARD is
 *  mounted (docked, off-screen, collapsed group). ONE JANITOR transaction
 *  (AUTO_JANITOR_ORIGIN — never undo-tracked) covering all players; a no-op
 *  (no transaction) when nothing dangles anywhere. Returns the number
 *  removed. */
export function pruneAllAutoAssignDangling(): number {
  const hits: { nid: string; keys: string[] }[] = [];
  for (const nid of listClipPlayers(patch.nodes)) {
    const keys = danglingAssignKeys(nid);
    if (keys.length) hits.push({ nid, keys });
  }
  if (hits.length === 0) return 0;
  let removed = 0;
  ydoc.transact(() => {
    for (const { nid, keys } of hits) {
      const d = (patch.nodes[nid] as ModuleNode | undefined)?.data as ClipPlayerData | undefined;
      if (!d?.autoAssign) continue;
      for (const key of keys) {
        if (key in d.autoAssign) {
          delete d.autoAssign[key];
          removed++;
        }
      }
    }
  }, AUTO_JANITOR_ORIGIN);
  return removed;
}

/** REPAIR duplicate module claims: ONE lane per module is a GLOBAL invariant,
 *  but a merge race (or a pre-scrub duplicate) can leave the same module
 *  assigned on TWO players / twice. Deterministically keep the LOWEST player
 *  node id's claim (the same tie-break the border + assignment reads use) and
 *  delete the rest. JANITOR write (AUTO_JANITOR_ORIGIN — idempotent deletes,
 *  every peer converges); a no-op (no transaction) when nothing is
 *  duplicated. Runs from the same Canvas graph-change seam as the prune.
 *  Returns the number of claims removed. */
export function repairDuplicateAutoAssign(): number {
  const players = listClipPlayers(patch.nodes).sort();
  const seen = new Set<string>();
  const hits: { nid: string; keys: string[] }[] = [];
  for (const nid of players) {
    const d = (patch.nodes[nid] as ModuleNode | undefined)?.data as ClipPlayerData | undefined;
    const assign = coerceAutoAssign(d?.autoAssign);
    const extras: string[] = [];
    for (const moduleId of Object.keys(assign).sort()) {
      if (seen.has(moduleId)) extras.push(moduleId); // a LATER player's duplicate claim
      else seen.add(moduleId);
    }
    if (extras.length) hits.push({ nid, keys: extras });
  }
  if (hits.length === 0) return 0;
  let removed = 0;
  ydoc.transact(() => {
    for (const { nid, keys } of hits) {
      const d = (patch.nodes[nid] as ModuleNode | undefined)?.data as ClipPlayerData | undefined;
      if (!d?.autoAssign) continue;
      for (const key of keys) {
        if (key in d.autoAssign) {
          delete d.autoAssign[key];
          removed++;
        }
      }
    }
  }, AUTO_JANITOR_ORIGIN);
  return removed;
}

// Retired param-level helper kept as a type re-export point for callers that
// still parse track keys (tracks stay keyed by `nodeId::paramId`).
export { parseAutomationTargetKey };
