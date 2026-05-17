// packages/web/src/lib/graph/saved-group-resurrect.ts
//
// Pure helpers for the saved-groups library:
//   - extractSavedGroupPayload: given a `group` ModuleNode + the current
//     snapshot, build a SavedGroupPayload that can round-trip back into
//     any rack.
//   - resurrectSavedGroup: given a SavedGroupPayload + the destination
//     rack's existing ids, mint fresh ids for every child + edge + the
//     group itself; return the new group node + children + internal
//     edges ready to be written into the snapshot in a single transact.
//
// Pure (no Yjs writes). Callers wrap the result in `ydoc.transact`.
// Symmetric with planCreateGroup / planDuplicateGroup in group-actions.ts.

import type { Edge, ModuleNode } from './types';
import type { ExposedPort, GroupData } from './group-projection';
import type { SavedGroupPayload } from '$lib/server/saved-groups';

export interface ExtractSavedGroupArgs {
  /** The `group` node to serialize. */
  group: ModuleNode;
  /** All nodes in the snapshot (children are resolved by group.data.childIds). */
  nodes: readonly ModuleNode[];
  /** All edges in the snapshot (internal edges are filtered out). */
  edges: readonly Edge[];
}

export interface ExtractedSavedGroup {
  payload: SavedGroupPayload;
  /** Convenience: the label used (group's name, or 'GROUP!' fallback). */
  label: string;
}

/**
 * Capture a group + its children + internal edges into a SavedGroupPayload.
 *
 * Notes:
 *   - Children are deep-cloned (JSON round-trip) so the payload is
 *     independent of the live patch graph; subsequent mutations to the
 *     original modules don't bleed into the saved snippet.
 *   - The group node itself is NOT serialized — it's reconstructed from
 *     exposedPorts + label at resurrect time. Only its label + exposed
 *     ports matter for round-tripping.
 *   - Edges with exactly one endpoint inside the group are SKIPPED —
 *     they're "external" cables that conceptually live in the source
 *     rack, not the snippet. The user's mental model is "save the
 *     group + its guts", not "save everything the group touches".
 *   - parentGroupId on each child is preserved at extract time but
 *     rewritten to the NEW group id at resurrect time.
 */
export function extractSavedGroupPayload(args: ExtractSavedGroupArgs): ExtractedSavedGroup | null {
  const data = (args.group.data as unknown as GroupData | undefined) ?? null;
  if (!data) return null;
  const childIdSet = new Set(data.childIds);
  const childrenById = new Map<string, ModuleNode>();
  for (const n of args.nodes) if (childIdSet.has(n.id)) childrenById.set(n.id, n);

  // Deep-clone children so the payload is stable against later mutations.
  const children: ModuleNode[] = [];
  for (const id of data.childIds) {
    const node = childrenById.get(id);
    if (!node) continue; // missing child — skip silently
    children.push(deepClone(node));
  }

  const internalEdges: Edge[] = [];
  for (const e of args.edges) {
    if (childIdSet.has(e.source.nodeId) && childIdSet.has(e.target.nodeId)) {
      internalEdges.push(deepClone(e));
    }
  }

  const label = (typeof data.label === 'string' && data.label.length > 0)
    ? data.label
    : 'GROUP!';
  const exposedPorts: ExposedPort[] = data.exposedPorts.map((p) => ({ ...p }));

  // Phase 4 — round-trip exposed controls. Entries that reference a missing
  // child are silently dropped (defensive — extract should never see one
  // because the group's childIds + nodes lists are consistent at save time).
  const exposedControlsSrc = data.exposedControls ?? [];
  const exposedControls = exposedControlsSrc
    .filter((ec) => childIdSet.has(ec.childId))
    .map((ec) => ({ childId: ec.childId, controlId: ec.controlId }));

  const payload: SavedGroupPayload = {
    label,
    exposedPorts,
    children,
    internalEdges,
  };
  if (exposedControls.length > 0) payload.exposedControls = exposedControls;

  return {
    label,
    payload,
  };
}

export interface ResurrectSavedGroupArgs {
  payload: SavedGroupPayload;
  /** Existing node ids in the destination snapshot — used to mint collision-free ids. */
  existingNodeIds: Iterable<string>;
  /** Existing edge ids — same. */
  existingEdgeIds: Iterable<string>;
  /** Position for the new group node (flow-space). Children land at an
   *  offset from the group's spawn point so the user sees them lay out
   *  near where they invoked the insert. */
  groupPosition: { x: number; y: number };
}

export interface ResurrectSavedGroupPlan {
  /** The new group ModuleNode (domain='meta', type='group'). */
  newGroup: ModuleNode;
  /** Newly-minted children, with parentGroupId stamped + positions
   *  preserved relative to the group's old centroid. */
  newChildren: ModuleNode[];
  /** New internal edges between the children (endpoint nodeIds rewritten). */
  newEdges: Edge[];
}

/**
 * Take a SavedGroupPayload + a destination rack's id space; return a plan
 * for inserting the snippet with fresh ids. Pure — caller wraps in
 * ydoc.transact.
 *
 * Position handling: the saved children remember their absolute positions
 * from the source rack. We compute their centroid + the offset of each
 * child from that centroid, then place the new group at `groupPosition`
 * and offset each child by the same delta from the new centroid. Result:
 * the saved group lands as a recognizable shape, anchored at the user's
 * insert point.
 */
export function resurrectSavedGroup(args: ResurrectSavedGroupArgs): ResurrectSavedGroupPlan {
  const takenNodes = new Set(args.existingNodeIds);
  const takenEdges = new Set(args.existingEdgeIds);

  // Centroid of saved children's original positions.
  let cx = 0;
  let cy = 0;
  const n = args.payload.children.length;
  for (const c of args.payload.children) {
    cx += c.position.x;
    cy += c.position.y;
  }
  cx = n > 0 ? cx / n : 0;
  cy = n > 0 ? cy / n : 0;

  // Mint child ids first so internal-edge endpoints can be rewritten.
  const oldToNew = new Map<string, string>();
  const newChildren: ModuleNode[] = [];
  for (const child of args.payload.children) {
    const newId = mintNodeId(child.type, takenNodes);
    takenNodes.add(newId);
    oldToNew.set(child.id, newId);
    const dx = child.position.x - cx;
    const dy = child.position.y - cy;
    const cloned: ModuleNode = {
      id: newId,
      type: child.type,
      domain: child.domain,
      position: { x: args.groupPosition.x + dx, y: args.groupPosition.y + dy },
      params: { ...child.params },
    };
    if (child.data !== undefined) cloned.data = deepClone(child.data);
    if (cloned.data && typeof cloned.data === 'object') {
      delete (cloned.data as { parentGroupId?: string }).parentGroupId;
    }
    newChildren.push(cloned);
  }

  // Mint the new group id + stamp parentGroupId on each child.
  const newGroupId = mintNodeId('group', takenNodes);
  takenNodes.add(newGroupId);
  for (const child of newChildren) {
    if (!child.data) child.data = {};
    (child.data as { parentGroupId?: string }).parentGroupId = newGroupId;
  }

  // Rewrite exposedPorts.childId references.
  const newExposed: ExposedPort[] = args.payload.exposedPorts.map((ep) => {
    const newChildId = oldToNew.get(ep.childId) ?? ep.childId;
    return {
      id: ep.id, // exposed-port ids are unique within a group, reuse is fine
      childId: newChildId,
      childPortId: ep.childPortId,
      direction: ep.direction,
      cableType: ep.cableType,
      ...(ep.label !== undefined ? { label: ep.label } : {}),
    };
  });
  const newGroupData: GroupData = {
    label: args.payload.label,
    childIds: newChildren.map((c) => c.id),
    exposedPorts: newExposed,
    expanded: false,
  };
  // Phase 4: rewrite each exposedControl's childId to the freshly-minted
  // copy. Entries that lost their child (defensive — shouldn't happen
  // because the payload's children + exposedControls are saved together)
  // are dropped silently.
  const incomingControls = args.payload.exposedControls;
  if (Array.isArray(incomingControls) && incomingControls.length > 0) {
    const remapped = incomingControls
      .map((ec) => {
        const newChildId = oldToNew.get(ec.childId);
        if (!newChildId) return null;
        return { childId: newChildId, controlId: ec.controlId };
      })
      .filter((x): x is { childId: string; controlId: string } => x !== null);
    if (remapped.length > 0) newGroupData.exposedControls = remapped;
  }
  const newGroup: ModuleNode = {
    id: newGroupId,
    type: 'group',
    domain: 'meta',
    position: { ...args.groupPosition },
    params: {},
    data: newGroupData as unknown as Record<string, unknown>,
  };

  // Clone internal edges with fresh ids + remapped endpoint nodeIds.
  // An edge is "internal" iff BOTH endpoints exist in oldToNew. The
  // payload's internalEdges array should already meet that, but we
  // re-check defensively (saved blobs might be from older schemas).
  const newEdges: Edge[] = [];
  for (const edge of args.payload.internalEdges) {
    const srcNew = oldToNew.get(edge.source.nodeId);
    const tgtNew = oldToNew.get(edge.target.nodeId);
    if (!srcNew || !tgtNew) continue;
    const newEdgeId = mintEdgeId(takenEdges);
    takenEdges.add(newEdgeId);
    newEdges.push({
      id: newEdgeId,
      source: { nodeId: srcNew, portId: edge.source.portId },
      target: { nodeId: tgtNew, portId: edge.target.portId },
      sourceType: edge.sourceType,
      targetType: edge.targetType,
    });
  }

  return { newGroup, newChildren, newEdges };
}

function mintNodeId(type: string, taken: Set<string>): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${type}-${randomSlice()}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${type}-${randomSlice()}-${randomSlice()}`;
}

function mintEdgeId(taken: Set<string>): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `e-${randomSlice()}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `e-${randomSlice()}-${randomSlice()}`;
}

function randomSlice(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
