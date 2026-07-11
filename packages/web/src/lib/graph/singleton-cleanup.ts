// packages/web/src/lib/graph/singleton-cleanup.ts
//
// PHASE 4c — DETERMINISTIC POST-MERGE SINGLETON CLEANUP.
//
// THE PROBLEM (the undeletable-ghost race)
// ----------------------------------------
// TIMELORDE auto-spawns when a rack opens without one (Canvas.svelte). Two
// peers can BOTH observe the same TIMELORDE-less snapshot, BOTH pass the
// transact-time re-check (Yjs has no conditional insert — peers can't see each
// other's un-merged writes), and EACH insert a distinct TIMELORDE node. Yjs
// merges both → the converged doc holds two `maxInstances: 1` nodes. The audio
// engine drops the loser at runtime, but TIMELORDE is `undeletable: true`, so
// the orphan graph node can never be removed by the user → an unrecoverable
// ghost.
//
// Write-time enforcement CANNOT close this (no conditional insert; the race is
// inherent to optimistic CRDT merges). The fix is a DETERMINISTIC pass over the
// CONVERGED snapshot that removes the duplicate(s).
//
// THE DESIGN (three properties make it collab-safe)
// -------------------------------------------------
//  1. DETERMINISTIC SURVIVOR — for an over-cap type we keep the lex-SMALLEST
//     node id and delete the lex-larger duplicate(s). This MATCHES the engine's
//     eviction tie-break (#705) so engine + graph agree on which instance is
//     the canonical one. Every peer computes the identical survivor from the
//     identical converged snapshot.
//
//  2. SINGLE ELECTED DELETER — exactly ONE peer issues the delete. If every
//     peer deleted, N peers would each delete the (N-1) lex-larger duplicates
//     and could race down to ZERO nodes of the type (deleting even the
//     survivor). We elect one peer — owner-preferred, else the lowest awareness
//     clientID — and only that peer acts. Non-elected peers wait for the merge
//     to converge.
//
//  3. RE-CHECK IN THE TRANSACT + NEVER-DELETE-THE-LAST — even with (2), two
//     peers can briefly believe they're elected (awareness churn), or the
//     cleanup can fire twice. So the actual delete (Canvas) re-reads the live
//     count INSIDE the Yjs transact and skips any deletion that would drop the
//     type to zero. This helper enforces the same invariant in its plan: it
//     never returns ALL nodes of a type, only the lex-larger surplus. The
//     combination is idempotent — re-running on an already-cleaned doc is a
//     no-op.
//
// SCOPE: type-level `def.maxInstances` ONLY. Per-USER caps (PICTUREBOX 8 /
// CAMERA 4 / SAMSLOOP per-rackspace budget) are EXCLUDED — they key off
// currentUserId + a per-rackspace budget, NOT the flat type count, so a blunt
// lex-delete of another user's node is worse UX than a transient extra. Those
// types are listed in PER_USER_CAPPED_TYPES below and skipped even though their
// def carries a numeric `maxInstances`.
//
// PURE + framework-free: no Svelte, no Yjs, no `$lib` imports. The actual
// mutation (the Yjs transact + delete) lives in Canvas.svelte's snapshot
// $effect; this module only DECIDES. That keeps it unit-testable against plain
// fakes and ports verbatim to the native core. It deliberately does NOT live in
// the audio reconciler, which is audio-only and runs on EVERY peer — putting the
// delete there would double-delete.

import { instanceCount, type TypedNode, type CapDef } from './cap';

/**
 * Module types whose `maxInstances` is a PER-USER / per-rackspace budget rather
 * than a global type-level singleton cap. The cleanup pass MUST NOT touch these
 * — deleting another user's PICTUREBOX/CAMERA because the rackspace total
 * exceeds a per-user budget would lex-delete a node the local user doesn't own.
 * Their limits are enforced in their own helpers
 * (multiplayer/picturebox-limits.ts, multiplayer/samsloop-limits.ts).
 *
 * SAMSLOOP has no `maxInstances` on its def at all (purely per-user gated), so
 * it never enters the cleanup regardless — it's listed here for documentation
 * and as a guard if a numeric cap is ever added to its def.
 */
export const PER_USER_CAPPED_TYPES: ReadonlySet<string> = new Set([
  'picturebox',
  'cameraInput',
  'samsloop',
]);

/** Minimal node shape the plan needs: an id + a module type. */
export interface IdentifiedNode extends TypedNode {
  id: string;
}

/** Minimal def shape: type + (optional) instance cap + (optional) undeletable. */
export interface CleanupDef extends CapDef {
  /** When true, the user can't delete it — a duplicate becomes an
   *  unrecoverable ghost, which is precisely what this pass cleans up. */
  undeletable?: boolean;
}

/** One awareness peer: its numeric clientID + whether it owns the rackspace. */
export interface CleanupPeer {
  clientID: number;
  isRackOwner?: boolean;
}

/**
 * Is a def in-scope for type-level singleton cleanup?
 *
 *  - must declare a finite `maxInstances` (a cap to enforce), AND
 *  - must NOT be a per-user-capped type (those use a different budget).
 *
 * `maxInstances` of 0 or NaN/negative is treated as "no type-level cap" and
 * skipped (defensive — no shipped def does this).
 */
export function isTypeLevelCapped(def: CleanupDef | null | undefined): boolean {
  if (def == null) return false;
  const cap = def.maxInstances;
  if (cap === undefined || !Number.isFinite(cap) || cap < 1) return false;
  if (PER_USER_CAPPED_TYPES.has(def.type)) return false;
  return true;
}

/**
 * Elect the single peer responsible for issuing the cleanup delete.
 *
 * Owner-preferred (matching the DOOM host election / #345): among peers whose
 * `isRackOwner` is true, the lex-min clientID; if there is no owner, the lex-min
 * clientID among ALL peers. clientID is numeric + unique per connected tab, so
 * every peer computes the same winner from the same awareness roster.
 *
 * Returns `null` when there are no peers (no awareness / no provider) — in that
 * single-user / no-provider case the lone client is trivially the deleter and
 * `isElectedDeleter` handles it via `localClientID == null`.
 */
export function electDeleter(peers: readonly CleanupPeer[]): number | null {
  if (peers.length === 0) return null;
  const owners = peers.filter((p) => p.isRackOwner === true);
  const pool = owners.length > 0 ? owners : peers;
  let min = pool[0].clientID;
  for (const p of pool) if (p.clientID < min) min = p.clientID;
  return min;
}

/**
 * Should THIS client perform the cleanup delete?
 *
 *  - No provider / no awareness (`localClientID == null`, `peers` empty) →
 *    single-user; this lone client IS the deleter → true.
 *  - Otherwise: true iff this client's clientID is the elected deleter's.
 *
 * Non-elected peers return false and simply wait for the elected peer's delete
 * to merge in. The in-transact re-check (Canvas) is the backstop if two peers
 * momentarily both believe they're elected during awareness churn.
 */
export function isElectedDeleter(
  localClientID: number | null | undefined,
  peers: readonly CleanupPeer[],
): boolean {
  // Single-user / no-provider: no awareness roster → lone deleter.
  if (localClientID == null) return true;
  const elected = electDeleter(peers);
  // No peers known yet but we have a local id → act (we're the only one we
  // can see; the in-transact re-check + never-delete-last keep it safe).
  if (elected == null) return true;
  return elected === localClientID;
}

/** A single planned deletion: which node, and why (for tracing). */
export interface SingletonDeletion {
  /** The node id to delete (a lex-larger duplicate of an over-cap type). */
  id: string;
  /** The module type that is over its type-level cap. */
  type: string;
  /** The surviving node id (lex-smallest of the type) kept in place. */
  keptId: string;
  /** Whether the type is `undeletable` (an over-cap one is the ghost case). */
  undeletable: boolean;
}

/**
 * Plan the deterministic cleanup for a CONVERGED node map.
 *
 * For every IN-SCOPE type-level-capped type (see {@link isTypeLevelCapped})
 * whose live count exceeds `maxInstances`, keep the lex-SMALLEST `cap` node ids
 * and mark every lex-larger surplus node for deletion. The survivor set is the
 * `cap` lex-smallest ids, so the plan NEVER removes the last (or last `cap`)
 * remaining node of a type — re-running on a cleaned doc yields an empty plan
 * (idempotent).
 *
 * `nodes` is the live `patch.nodes` record (id → node-like). `defForType`
 * resolves a module type to its def (or undefined). The returned deletions are
 * sorted by (type, id) so two peers/runs produce byte-identical plans.
 *
 * NOTE: this does NOT consult the elected-deleter predicate — call
 * {@link isElectedDeleter} at the call-site and skip issuing deletes when it's
 * false. Splitting "what to delete" from "should I delete" keeps each piece
 * trivially testable.
 */
export function planSingletonCleanup(
  nodes: Record<string, IdentifiedNode | null | undefined>,
  defForType: (type: string) => CleanupDef | null | undefined,
): SingletonDeletion[] {
  // Group node ids by type, but only for in-scope (type-level-capped) types.
  const byType = new Map<string, { ids: string[]; def: CleanupDef }>();
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || !node.type) continue;
    // PINNED nodes (data.pinned === true — workflow drawer singletons, see
    // graph/workflow-pins.ts) are outside the canvas cap economy: excluded
    // from `instanceCount` (cap.ts) and never planned for deletion here.
    // Their deterministic ids can't duplicate (Y.Map key convergence), and
    // deleting one would break the workflow rack's always-on invariant.
    if (node.data?.pinned === true) continue;
    const def = defForType(node.type) ?? undefined;
    if (!isTypeLevelCapped(def)) continue;
    // `node.id` is the authoritative id; fall back to the map key (they match
    // in the live store, but be defensive against a missing field).
    const nodeId = node.id ?? id;
    const entry = byType.get(node.type);
    if (entry) entry.ids.push(nodeId);
    else byType.set(node.type, { ids: [nodeId], def: def! });
  }

  const deletions: SingletonDeletion[] = [];
  for (const [type, { ids, def }] of byType) {
    const cap = def.maxInstances as number; // finite & >=1 (isTypeLevelCapped)
    if (ids.length <= cap) continue; // at or under cap → nothing to clean
    // Deterministic lex sort: smallest `cap` ids survive, the rest are surplus.
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const survivors = sorted.slice(0, cap);
    const keptId = survivors[0]; // lex-smallest survivor (for tracing)
    const surplus = sorted.slice(cap);
    for (const id of surplus) {
      deletions.push({
        id,
        type,
        keptId,
        undeletable: def.undeletable === true,
      });
    }
  }

  // Stable order so every peer/run emits an identical plan.
  deletions.sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return deletions;
}

/**
 * IN-TRANSACT GUARD — is it SAFE to delete `id` (a planned surplus node) right
 * now, re-reading the LIVE node map?
 *
 * This is the never-delete-the-last invariant, re-evaluated against the live
 * (possibly-changed-since-plan) state inside the Yjs transact:
 *
 *  - the node must still exist (a rack-mate may have already deleted it), AND
 *  - deleting it must NOT drop the type's live count to zero — i.e. there must
 *    still be at least one OTHER node of the same type after removal.
 *
 * Together with the elected-deleter predicate this makes the whole pass
 * idempotent and double-delete-proof: if two peers race the same surplus node,
 * the second sees `count === 1` (only the survivor left) and refuses.
 */
export function isSafeToDelete(
  liveNodes: Record<string, TypedNode | null | undefined>,
  id: string,
  type: string,
): boolean {
  const node = liveNodes[id];
  if (!node || node.type !== type) return false; // already gone / type changed
  // Must leave at least one node of the type behind.
  return instanceCount(liveNodes, type) > 1;
}
