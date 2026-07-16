// packages/web/src/lib/graph/automation-assign.ts
//
// PARAM → AUTOMATION-LANE assignment writes (per-clip automation redesign,
// Phase B). The synced model is `ClipPlayerData.autoAssign` — a sparse map
// `automationTargetKey → laneIndex` on each clip-player node. ONE lane per
// param GLOBALLY: assigning moves the key (removing it from every other player
// and lane first), so a control is never recorded by two lanes at once.
//
// Writes are in-place single-key mutations inside ONE LOCAL_ORIGIN transaction
// (undoable, never a map spread — [[yjs-save-load-real-ydoc]]). Reads are the
// pure clip-types helpers (`coerceAutoAssign` et al).
//
// PRUNE (mirrors control-surface-params.pruneSurfaceDangling): when an assigned
// control's source MODULE is deleted, its assignment lingers in node.data — the
// card's $effect calls `pruneAutoAssignDangling` on every graph change, which
// is conservative (module-absent only), a no-op when nothing dangles, and
// transactional when something does.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import {
  automationTargetKey,
  parseAutomationTargetKey,
  coerceAutoAssign,
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

/** Where `target` is currently assigned — the (player, lane) pair, or null. */
export function automationAssignmentFor(
  nodes: Record<string, { type?: string; data?: unknown } | undefined>,
  target: AutomationTarget,
): { nodeId: string; lane: number } | null {
  const key = automationTargetKey(target);
  for (const nid of listClipPlayers(nodes)) {
    const lane = coerceAutoAssign((nodes[nid]?.data as ClipPlayerData | undefined)?.autoAssign)[
      key
    ];
    if (typeof lane === 'number') return { nodeId: nid, lane };
  }
  return null;
}

/** ASSIGN `target` to `lane` on clip-player `playerId` — the right-click menu's
 *  "Assign to automation lane ▸ N". ONE lane per param: the key is removed from
 *  every other player (and its old lane here) in the SAME transaction, so the
 *  move is atomic + a single undo step. Clamped lane; no-op on a bad player. */
export function assignAutomationLane(
  playerId: string,
  target: AutomationTarget,
  lane: number,
): void {
  const L = Math.max(0, Math.min(CLIP_LANES - 1, Math.trunc(lane)));
  const key = automationTargetKey(target);
  if (!parseAutomationTargetKey(key)) return;
  if (patch.nodes[playerId]?.type !== 'clipplayer') return;
  ydoc.transact(() => {
    for (const nid of listClipPlayers(patch.nodes)) {
      const live = patch.nodes[nid] as ModuleNode | undefined;
      if (!live) continue;
      if (nid === playerId) {
        if (!live.data) live.data = {};
        const d = live.data as ClipPlayerData;
        if (!d.autoAssign) d.autoAssign = {};
        d.autoAssign[key] = L; // single-key in-place write (move = overwrite)
      } else {
        const d = live.data as ClipPlayerData | undefined;
        if (d?.autoAssign && key in d.autoAssign) delete d.autoAssign[key];
      }
    }
  }, LOCAL_ORIGIN);
}

/** REMOVE `target`'s automation assignment from whichever player holds it —
 *  the right-click menu's "Remove automation assignment". One transaction. */
export function removeAutomationAssignment(target: AutomationTarget): void {
  const key = automationTargetKey(target);
  const holders = listClipPlayers(patch.nodes).filter((nid) => {
    const d = (patch.nodes[nid] as ModuleNode | undefined)?.data as ClipPlayerData | undefined;
    return !!d?.autoAssign && key in coerceAutoAssign(d.autoAssign);
  });
  if (holders.length === 0) return;
  ydoc.transact(() => {
    for (const nid of holders) {
      const d = (patch.nodes[nid] as ModuleNode | undefined)?.data as ClipPlayerData | undefined;
      if (d?.autoAssign && key in d.autoAssign) delete d.autoAssign[key];
    }
  }, LOCAL_ORIGIN);
}

/** The raw `auto` map of a clip-player node (untyped read). */
function autoMapOf(nid: string): Record<string, { tracks?: Record<string, unknown> } | null> | undefined {
  const d = (patch.nodes[nid] as ModuleNode | undefined)?.data as ClipPlayerData | undefined;
  return d?.auto as Record<string, { tracks?: Record<string, unknown> } | null> | undefined;
}

/** True when `target` has RECORDED envelopes in ANY clip of any player — the
 *  "Clear recorded automation" menu item shows only when there is something to
 *  clear. PURE read. */
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
 * CLEAR `target`'s RECORDED envelopes — the DELETE affordance that pairs with
 * "Remove automation assignment" (remove = stops future recording; CLEAR =
 * deletes what was recorded). Scope (the owner's lane model): when the target
 * is ASSIGNED, delete its track from every clip in its assigned lane on that
 * player; when UNASSIGNED, delete it from EVERY clip on every player (no lane
 * to scope by). A record left with zero tracks is deleted too (no empty-shell
 * litter). ONE LOCAL_ORIGIN transaction (a single undo step). Returns the
 * number of tracks removed.
 */
export function clearRecordedAutomation(target: AutomationTarget): number {
  const key = automationTargetKey(target);
  const holder = automationAssignmentFor(patch.nodes, target);
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

/** Drop every assignment on player `playerId` whose target MODULE no longer
 *  exists (module-absent only — the conservative, unambiguous case; mirrors
 *  `bindingDefinitelyDangling` case 1). In-place deletes inside one
 *  LOCAL_ORIGIN transaction; NO transaction when nothing dangles. Safe to call
 *  on every graph change. Returns the number removed. */
export function pruneAutoAssignDangling(playerId: string): number {
  const live = patch.nodes[playerId] as ModuleNode | undefined;
  if (live?.type !== 'clipplayer') return 0;
  const assign = coerceAutoAssign((live.data as ClipPlayerData | undefined)?.autoAssign);
  const dangling = Object.keys(assign).filter((key) => {
    const target = parseAutomationTargetKey(key);
    return !target || !patch.nodes[target.nodeId];
  });
  if (dangling.length === 0) return 0;
  ydoc.transact(() => {
    const d = (patch.nodes[playerId] as ModuleNode | undefined)?.data as
      | ClipPlayerData
      | undefined;
    if (!d?.autoAssign) return;
    for (const key of dangling) {
      if (key in d.autoAssign) delete d.autoAssign[key];
    }
  }, LOCAL_ORIGIN);
  return dangling.length;
}
