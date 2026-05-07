// Per-user layout split (Stage B PR B-b).
//
// In single-user mode, a node's position lives directly on `node.position`
// in the shared `nodes` Y.Map. In multiplayer that doesn't work — dragging
// a card on user A's screen shouldn't move it on user B's. The fix isolates
// visual layout from the audio-affecting graph.
//
// Schema: `ydoc.getMap('layouts')` is keyed by userId; each value is itself
// a `Y.Map<{x, y}>` keyed by nodeId. Each user reads + writes only their
// own entry. The original `node.position` becomes the *default* position
// (used by users who have no layout entry yet for that node — e.g., a
// newcomer joining a Rackspace where existing nodes were placed before
// they arrived).
//
// Resolution order on read:
//   1. layouts[currentUserId][nodeId]   ← my override
//   2. node.position                    ← creator's intent / default
//   3. caller-provided fallback         ← absolute backstop
//
// Stage B PR B-a (already shipped) attached the HocuspocusProvider; this
// module adds the schema split. Without it, two clients still see each
// other's drags as the shared `node.position` field mutates. Stage A
// single-user behavior is preserved when `currentUserId` is undefined
// (public canvas at `/`) — the helpers fall through to `node.position`.

import * as Y from 'yjs';

export interface XY {
  x: number;
  y: number;
}

const LAYOUTS_MAP_NAME = 'layouts';

/** Get the per-user layouts map. Created lazily on first access. */
function getLayoutsMap(ydoc: Y.Doc): Y.Map<Y.Map<XY>> {
  return ydoc.getMap<Y.Map<XY>>(LAYOUTS_MAP_NAME);
}

/** Get the current user's layout map, creating it if missing. Caller must
 *  call this inside a `ydoc.transact` if write follows. */
function getOrCreateUserLayout(
  ydoc: Y.Doc,
  userId: string,
): Y.Map<XY> {
  const layouts = getLayoutsMap(ydoc);
  let mine = layouts.get(userId);
  if (!mine) {
    mine = new Y.Map<XY>();
    layouts.set(userId, mine);
  }
  return mine;
}

/**
 * Resolve a node's display position for the current user.
 *
 * `currentUserId === undefined` returns `defaultPos` directly (single-user
 * mode — the caller, e.g. the public canvas at `/`, doesn't have an
 * authenticated user). When defined, looks up the per-user override; falls
 * back to `defaultPos` when the user has no entry for this node.
 */
export function getNodePosition(
  ydoc: Y.Doc,
  currentUserId: string | undefined,
  nodeId: string,
  defaultPos: XY,
): XY {
  if (!currentUserId) return defaultPos;
  const layouts = getLayoutsMap(ydoc);
  const mine = layouts.get(currentUserId);
  const override = mine?.get(nodeId);
  return override ?? defaultPos;
}

/**
 * Persist a node's per-user position. No-op when `currentUserId` is
 * undefined — caller is in single-user mode and is expected to mutate
 * `node.position` on the patch graph directly (existing behavior).
 *
 * Wraps in a transact so the layout-map creation + entry write land as
 * a single Yjs update — important for collaboration semantics.
 */
export function setNodePosition(
  ydoc: Y.Doc,
  currentUserId: string | undefined,
  nodeId: string,
  pos: XY,
): void {
  if (!currentUserId) return;
  ydoc.transact(() => {
    const mine = getOrCreateUserLayout(ydoc, currentUserId);
    mine.set(nodeId, pos);
  });
}

/**
 * Drop a per-user entry when a node is deleted. Called by the same
 * transact that removes the node from `patch.nodes`. Idempotent — if no
 * entry exists, no-op.
 */
export function clearNodePosition(
  ydoc: Y.Doc,
  currentUserId: string | undefined,
  nodeId: string,
): void {
  if (!currentUserId) return;
  const layouts = getLayoutsMap(ydoc);
  const mine = layouts.get(currentUserId);
  if (!mine) return;
  if (!mine.has(nodeId)) return;
  ydoc.transact(() => {
    mine.delete(nodeId);
  });
}

/**
 * Garbage-collect a user's layout entries that no longer correspond to a
 * live node in `patch.nodes`. Called on rackspace mount as a one-shot
 * cleanup after migrations or buggy client behavior. Cheap (O(layoutSize)).
 */
export function pruneStaleLayoutEntries(
  ydoc: Y.Doc,
  currentUserId: string | undefined,
  liveNodeIds: ReadonlySet<string>,
): void {
  if (!currentUserId) return;
  const layouts = getLayoutsMap(ydoc);
  const mine = layouts.get(currentUserId);
  if (!mine) return;
  const stale: string[] = [];
  for (const nid of mine.keys()) {
    if (!liveNodeIds.has(nid)) stale.push(nid);
  }
  if (stale.length === 0) return;
  ydoc.transact(() => {
    for (const nid of stale) mine.delete(nid);
  });
}
