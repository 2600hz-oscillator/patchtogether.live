// packages/web/src/lib/graph/group-actions.ts
//
// Pure helpers for the Module-grouping Phase 1 create-group / ungroup
// actions. Pure → no Yjs writes; callers wrap the result in a
// ydoc.transact. Kept separate from the meta-domain module def so the
// transactional logic is unit-testable without spinning a doc.

import type { Edge, ModuleNode, CableType, PortDef } from './types';
import type { ExposedPort, GroupData } from './group-projection';

export interface PortCandidate {
  /** The child node id this port lives on. */
  childId: string;
  /** The port id on the child module. */
  childPortId: string;
  /** input or output. */
  direction: 'input' | 'output';
  /** Cable type of the port. */
  cableType: CableType;
  /** Optional default UI label (verbose). */
  label?: string;
  /** True iff this port currently has at least one cable to a node
   *  OUTSIDE the selection — i.e. would-be-dropped without exposure. */
  hasExternalCable: boolean;
  /** Description of where the external cable goes (for the modal
   *  tooltip + the "Patched: external" indicator). */
  externalSummary?: string;
  /** True iff this port currently has at least one cable to a node
   *  INSIDE the selection — i.e. a wholly-internal patch that the
   *  group will preserve as-is (no exposure needed). */
  hasInternalCable: boolean;
  /** Description of the internal cable(s) (modal tooltip + the
   *  "Patched: internal" indicator). */
  internalSummary?: string;
}

export interface PortLookupModule {
  id: string;
  type: string;
  inputs: readonly PortDef[];
  outputs: readonly PortDef[];
  /** Optional display label for the module type. */
  label?: string;
}

export interface BuildCandidatesArgs {
  selectionIds: string[];
  /** All nodes in the snapshot. */
  nodes: readonly ModuleNode[];
  /** All edges in the snapshot. */
  edges: readonly Edge[];
  /** Per-selected-node port-def lookup (inputs + outputs). */
  modulesById: Map<string, PortLookupModule>;
}

/**
 * For every port on every selected module, build a PortCandidate. Marks
 * ports that have a cable to a NON-selected node as `hasExternalCable`
 * so the group-builder modal can pre-check them.
 */
export function buildPortCandidates(args: BuildCandidatesArgs): PortCandidate[] {
  const selection = new Set(args.selectionIds);
  const out: PortCandidate[] = [];

  // Index edges by {nodeId,portId} on both endpoints for fast lookup.
  interface EndpointRow {
    selfNodeId: string;
    selfPortId: string;
    otherNodeId: string;
    otherPortId: string;
    selfRole: 'source' | 'target';
  }
  const endpointMap = new Map<string, EndpointRow[]>();
  for (const e of args.edges) {
    const sKey = `${e.source.nodeId}::${e.source.portId}`;
    const tKey = `${e.target.nodeId}::${e.target.portId}`;
    const sRow: EndpointRow = {
      selfNodeId: e.source.nodeId,
      selfPortId: e.source.portId,
      otherNodeId: e.target.nodeId,
      otherPortId: e.target.portId,
      selfRole: 'source',
    };
    const tRow: EndpointRow = {
      selfNodeId: e.target.nodeId,
      selfPortId: e.target.portId,
      otherNodeId: e.source.nodeId,
      otherPortId: e.source.portId,
      selfRole: 'target',
    };
    const sArr = endpointMap.get(sKey) ?? [];
    sArr.push(sRow);
    endpointMap.set(sKey, sArr);
    const tArr = endpointMap.get(tKey) ?? [];
    tArr.push(tRow);
    endpointMap.set(tKey, tArr);
  }

  for (const childId of args.selectionIds) {
    const mod = args.modulesById.get(childId);
    if (!mod) continue;

    const collect = (port: PortDef, direction: 'input' | 'output') => {
      const key = `${childId}::${port.id}`;
      const rows = endpointMap.get(key) ?? [];
      const externalRows = rows.filter((r) => !selection.has(r.otherNodeId));
      const internalRows = rows.filter((r) => selection.has(r.otherNodeId));
      const hasExternal = externalRows.length > 0;
      const hasInternal = internalRows.length > 0;
      const externalSummary = externalRows
        .slice(0, 3)
        .map((r) => `${r.otherNodeId}.${r.otherPortId}`)
        .join(', ');
      const internalSummary = internalRows
        .slice(0, 3)
        .map((r) => `${r.otherNodeId}.${r.otherPortId}`)
        .join(', ');
      out.push({
        childId,
        childPortId: port.id,
        direction,
        cableType: port.type,
        hasExternalCable: hasExternal,
        externalSummary: hasExternal ? externalSummary : undefined,
        hasInternalCable: hasInternal,
        internalSummary: hasInternal ? internalSummary : undefined,
      });
    };
    for (const port of mod.inputs) collect(port, 'input');
    for (const port of mod.outputs) collect(port, 'output');
  }
  return out;
}

export interface BuildExposeArgs {
  /** Subset of candidates the user checked in the modal. */
  selectedCandidates: PortCandidate[];
}

/**
 * Mint a stable ExposedPort id from {childId, childPortId, direction}.
 * Slashes are escaped — child ids are usually `${type}-${slice}` so they
 * never contain slashes, but defensive.
 */
function makeExposedPortId(c: PortCandidate): string {
  const safe = (s: string) => s.replace(/::/g, '_');
  return `${c.direction === 'input' ? 'in' : 'out'}--${safe(c.childId)}--${safe(c.childPortId)}`;
}

/**
 * Map the user-checked port candidates → ExposedPort[]. Output order is
 * stable: inputs first (in selection order), then outputs (in selection
 * order). The modal's "tab" navigation can rely on this for accessibility.
 */
export function buildExposedPorts(args: BuildExposeArgs): ExposedPort[] {
  const inputs: ExposedPort[] = [];
  const outputs: ExposedPort[] = [];
  for (const c of args.selectedCandidates) {
    const ep: ExposedPort = {
      id: makeExposedPortId(c),
      childId: c.childId,
      childPortId: c.childPortId,
      direction: c.direction,
      cableType: c.cableType,
      label: c.label,
    };
    if (c.direction === 'input') inputs.push(ep);
    else outputs.push(ep);
  }
  return [...inputs, ...outputs];
}

export interface CreateGroupArgs {
  groupId: string;
  selectionIds: string[];
  exposedPorts: ExposedPort[];
  /** All edges in the snapshot — caller passes the same array buildPortCandidates was given. */
  edges: readonly Edge[];
  /** All nodes in the snapshot. */
  nodes: readonly ModuleNode[];
  /** Optional explicit position. Defaults to centroid of selected children. */
  position?: { x: number; y: number };
  /** Optional human-readable label. */
  label?: string;
}

export interface CreateGroupPlan {
  /** The group node to insert. */
  groupNode: ModuleNode;
  /** Edge mutations to apply in the same transact. */
  edges: {
    /** Edge id → new endpoint (when the inside endpoint matched an exposed port). */
    rewrite: Array<{ id: string; newSource?: { nodeId: string; portId: string }; newTarget?: { nodeId: string; portId: string } }>;
    /** Edge ids to delete (had an inside endpoint but no exposed port, OR fully internal — internal edges are KEPT, see below). */
    deleteIds: string[];
  };
  /** Per-child data.parentGroupId set. */
  childParentSets: Array<{ childId: string; parentGroupId: string }>;
}

/**
 * Build the plan for "Create group" without performing any Yjs writes.
 *
 * Edge classification:
 *   - "External": exactly one endpoint inside the selection.
 *       * If that inside endpoint matches an exposed port → rewrite the
 *         inside endpoint to {nodeId: groupId, portId: exposed.id}.
 *       * Otherwise → delete the edge (the user opted not to expose this
 *         port, so the cable is dropped).
 *   - "Internal": both endpoints inside the selection → kept as-is.
 *     Internal edges remain in the snapshot pointing at the real child
 *     ports; they're filtered out of the canvas's flowEdges by the
 *     collapsed-group rule, but stay in the patch graph so Ungroup
 *     can restore them. The reconciler still materializes them
 *     because both children remain (just hidden from the UI).
 *   - "External (both outside)": no endpoint inside → unchanged.
 */
export function planCreateGroup(args: CreateGroupArgs): CreateGroupPlan {
  const selection = new Set(args.selectionIds);
  // Build a lookup from {childId,childPortId} → exposed port id.
  const exposeKey = (childId: string, portId: string, direction: 'input' | 'output') =>
    `${direction}::${childId}::${portId}`;
  const exposedLookup = new Map<string, ExposedPort>();
  for (const ep of args.exposedPorts) {
    exposedLookup.set(exposeKey(ep.childId, ep.childPortId, ep.direction), ep);
  }

  const rewrite: CreateGroupPlan['edges']['rewrite'] = [];
  const deleteIds: string[] = [];

  for (const edge of args.edges) {
    const srcInside = selection.has(edge.source.nodeId);
    const dstInside = selection.has(edge.target.nodeId);

    if (srcInside && dstInside) {
      // Internal: keep as-is. Reconciler still routes it (children remain).
      continue;
    }
    if (!srcInside && !dstInside) {
      // Fully external — untouched.
      continue;
    }

    // Exactly one endpoint inside: needs to be rewritten or dropped.
    if (srcInside) {
      const ep = exposedLookup.get(exposeKey(edge.source.nodeId, edge.source.portId, 'output'));
      if (ep) {
        rewrite.push({ id: edge.id, newSource: { nodeId: args.groupId, portId: ep.id } });
      } else {
        deleteIds.push(edge.id);
      }
    } else {
      // dstInside
      const ep = exposedLookup.get(exposeKey(edge.target.nodeId, edge.target.portId, 'input'));
      if (ep) {
        rewrite.push({ id: edge.id, newTarget: { nodeId: args.groupId, portId: ep.id } });
      } else {
        deleteIds.push(edge.id);
      }
    }
  }

  // Position: centroid of selected children's positions if not overridden.
  const position = args.position ?? computeCentroid(args.nodes, args.selectionIds);

  const groupData: GroupData = {
    childIds: args.selectionIds.slice(),
    exposedPorts: args.exposedPorts.slice(),
  };
  if (args.label) groupData.label = args.label;
  const groupNode: ModuleNode = {
    id: args.groupId,
    type: 'group',
    domain: 'meta',
    position,
    params: {},
    data: groupData as unknown as Record<string, unknown>,
  };

  const childParentSets = args.selectionIds.map((cid) => ({
    childId: cid,
    parentGroupId: args.groupId,
  }));

  return {
    groupNode,
    edges: { rewrite, deleteIds },
    childParentSets,
  };
}

function computeCentroid(
  nodes: readonly ModuleNode[],
  selectionIds: readonly string[],
): { x: number; y: number } {
  const sel = new Set(selectionIds);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const node of nodes) {
    if (!sel.has(node.id)) continue;
    sx += node.position.x;
    sy += node.position.y;
    n++;
  }
  if (n === 0) return { x: 0, y: 0 };
  return { x: sx / n, y: sy / n };
}

export interface UngroupArgs {
  groupNode: ModuleNode;
  /** All edges in the snapshot. */
  edges: readonly Edge[];
}

export interface UngroupPlan {
  /** Edge ids to rewrite back to the underlying child port. */
  rewrite: Array<{ id: string; newSource?: { nodeId: string; portId: string }; newTarget?: { nodeId: string; portId: string } }>;
  /** Child ids to clear data.parentGroupId on. */
  childrenToClear: string[];
  /** The group node id to delete. */
  groupNodeId: string;
}

/**
 * Build the plan for "Ungroup" without performing any Yjs writes. Reverse
 * of planCreateGroup:
 *   - Every edge whose endpoint references group.id at an exposed port id
 *     is rewritten back to the real {childId, childPortId}.
 *   - Every child node's data.parentGroupId is cleared.
 *   - The group node is deleted.
 *
 * NOTE: External cables that were DROPPED at create-group time are NOT
 * restored — once the user committed the drop, it's gone. Phase 2 may
 * add an "undo group" path that uses the undo stack.
 */
export function planUngroup(args: UngroupArgs): UngroupPlan {
  const data = (args.groupNode.data as unknown as GroupData | undefined) ?? null;
  if (!data) {
    return { rewrite: [], childrenToClear: [], groupNodeId: args.groupNode.id };
  }
  const exposedById = new Map(data.exposedPorts.map((ep) => [ep.id, ep]));

  const rewrite: UngroupPlan['rewrite'] = [];
  for (const edge of args.edges) {
    let newSource: { nodeId: string; portId: string } | undefined;
    let newTarget: { nodeId: string; portId: string } | undefined;
    if (edge.source.nodeId === args.groupNode.id) {
      const ep = exposedById.get(edge.source.portId);
      if (ep) newSource = { nodeId: ep.childId, portId: ep.childPortId };
    }
    if (edge.target.nodeId === args.groupNode.id) {
      const ep = exposedById.get(edge.target.portId);
      if (ep) newTarget = { nodeId: ep.childId, portId: ep.childPortId };
    }
    if (newSource || newTarget) {
      rewrite.push({ id: edge.id, newSource, newTarget });
    }
  }
  return {
    rewrite,
    childrenToClear: data.childIds.slice(),
    groupNodeId: args.groupNode.id,
  };
}

// --------------------------------------------------------------------
// Module-grouping Phase 2B — edit-exposed-jacks
// --------------------------------------------------------------------
//
// Reopening the group builder for an existing group requires diffing the
// old exposedPorts list against the new one:
//   - "kept" ports keep their existing exposed-port id (so any external
//     cables already terminating there stay valid).
//   - "added" ports gain a fresh exposed-port id; the user may have just
//     wired one of them externally, so post-commit they appear unpatched
//     until the user drags a cable to them.
//   - "removed" ports get their exposed-port id deleted; any external
//     cables that point at them get dropped.

export interface EditExposedArgs {
  group: ModuleNode;
  /** Snapshot edges. */
  edges: readonly Edge[];
  /** New exposed-port set chosen by the user. The plan reconciles this
   *  against `group.data.exposedPorts` to compute the diff. */
  newExposedPorts: ExposedPort[];
  /** Optional new label. When omitted, the existing label is preserved. */
  newLabel?: string;
}

export interface EditExposedPlan {
  /** The merged exposed-ports list to write back to group.data.
   *  Preserves stable ids for kept ports + adds new ids for additions. */
  mergedExposedPorts: ExposedPort[];
  /** Edge ids referencing now-removed exposed ports — caller should drop. */
  deleteEdgeIds: string[];
  /** Edge id rewrites — when a port stays exposed but its id changed
   *  (defensive; shouldn't fire since we preserve ids for kept ports). */
  rewriteEdges: Array<{
    id: string;
    newSource?: { nodeId: string; portId: string };
    newTarget?: { nodeId: string; portId: string };
  }>;
  /** Optional label change (undefined → don't touch). */
  newLabel?: string;
}

/**
 * Build the plan for "Edit exposed patch jacks…". Pure function.
 *
 * The "stable id for kept ports" rule is the load-bearing piece:
 * external cables in the snapshot terminate on `{groupId, exposedId}`,
 * and rewriting them in lockstep with the exposed-port list would force
 * a full Yjs round-trip every time the user toggles a checkbox. Instead
 * we keep the old id for any port that's in both the old + new lists.
 */
export function planEditExposed(args: EditExposedArgs): EditExposedPlan {
  const data = (args.group.data as unknown as GroupData | undefined) ?? null;
  const oldExposed = data?.exposedPorts ?? [];

  // Key a port by its underlying child + direction so we can match it
  // against the new list independent of its current id.
  const portKey = (e: { childId: string; childPortId: string; direction: 'input' | 'output' }) =>
    `${e.direction}::${e.childId}::${e.childPortId}`;

  const oldByKey = new Map<string, ExposedPort>();
  for (const ep of oldExposed) oldByKey.set(portKey(ep), ep);

  // Merge: for each new port, prefer the old id (if present) else use
  // whatever id the caller minted.
  const merged: ExposedPort[] = [];
  const newKeys = new Set<string>();
  for (const ep of args.newExposedPorts) {
    const k = portKey(ep);
    newKeys.add(k);
    const old = oldByKey.get(k);
    merged.push(old ? { ...old, label: ep.label ?? old.label } : ep);
  }

  // Removed-port ids are the ones present in oldByKey but absent from
  // newKeys. We collect their exposed-ids so the edge-dropper can find
  // any cables that referenced them.
  const removedExposedIds = new Set<string>();
  for (const [k, ep] of oldByKey) {
    if (!newKeys.has(k)) removedExposedIds.add(ep.id);
  }

  const deleteEdgeIds: string[] = [];
  for (const edge of args.edges) {
    if (edge.source.nodeId === args.group.id && removedExposedIds.has(edge.source.portId)) {
      deleteEdgeIds.push(edge.id);
      continue;
    }
    if (edge.target.nodeId === args.group.id && removedExposedIds.has(edge.target.portId)) {
      deleteEdgeIds.push(edge.id);
    }
  }

  const plan: EditExposedPlan = {
    mergedExposedPorts: merged,
    deleteEdgeIds,
    rewriteEdges: [],
  };
  if (args.newLabel !== undefined) plan.newLabel = args.newLabel;
  return plan;
}

// --------------------------------------------------------------------
// Module-grouping Phase 2C — duplicate group
// --------------------------------------------------------------------
//
// Atomically clone a group + every child into a fresh id space:
//   - Each child node gets a fresh id (deep-cloned data + params).
//   - The group's exposedPorts have their childId refs rewritten to the
//     new child ids.
//   - INTERNAL edges (both endpoints inside the source group) are cloned
//     with fresh ids + rewritten endpoint nodeIds.
//   - EXTERNAL edges (one endpoint inside the source group, terminating
//     on the source group node's exposed port) are NOT cloned — the
//     duplicate starts un-patched on its boundary, matching the
//     duplicate-module spec.
//   - Position offsets cascade by DUPLICATE_OFFSET per existing
//     duplicate, matching PR-93's behavior.

export interface DuplicateGroupArgs {
  /** The group node to duplicate. */
  group: ModuleNode;
  /** All child nodes that the group references. */
  children: ModuleNode[];
  /** All edges in the snapshot — internal ones are cloned, others ignored. */
  edges: readonly Edge[];
  /** Existing node ids in the snapshot, used to mint collision-free fresh ids. */
  existingNodeIds: Iterable<string>;
  /** Existing edge ids in the snapshot, used to mint collision-free fresh edge ids. */
  existingEdgeIds: Iterable<string>;
  /** Position offset applied to every duplicated node. Default = 30px down-right. */
  positionOffset?: { x: number; y: number };
  /** Optional override for the new group id (tests pass a deterministic seed). */
  newGroupIdSuffix?: string;
}

export interface DuplicateGroupPlan {
  /** The new group node to insert. */
  newGroup: ModuleNode;
  /** New child nodes to insert. */
  newChildren: ModuleNode[];
  /** New edges to insert (internal-only clones). */
  newEdges: Edge[];
}

const DEFAULT_DUPLICATE_GROUP_OFFSET = { x: 30, y: 30 };

export function planDuplicateGroup(args: DuplicateGroupArgs): DuplicateGroupPlan {
  const offset = args.positionOffset ?? DEFAULT_DUPLICATE_GROUP_OFFSET;
  const takenNodes = new Set<string>(args.existingNodeIds);
  const takenEdges = new Set<string>(args.existingEdgeIds);

  // Mint child ids first so we can rewrite exposedPorts + edges in one
  // pass after.
  const oldToNewChildId = new Map<string, string>();
  const newChildren: ModuleNode[] = [];
  for (const child of args.children) {
    const newId = mintIdLocal(child.type, takenNodes);
    takenNodes.add(newId);
    oldToNewChildId.set(child.id, newId);
    const clone: ModuleNode = {
      id: newId,
      type: child.type,
      domain: child.domain,
      position: { x: child.position.x + offset.x, y: child.position.y + offset.y },
      params: { ...child.params },
    };
    if (child.data !== undefined) clone.data = deepCloneJson(child.data);
    // Clear the old parentGroupId; the new group id is filled in below.
    if (clone.data && typeof clone.data === 'object') {
      delete (clone.data as { parentGroupId?: string }).parentGroupId;
    }
    newChildren.push(clone);
  }

  // Mint the new group id.
  const newGroupId = args.newGroupIdSuffix
    ? `group-${args.newGroupIdSuffix}`
    : mintIdLocal('group', takenNodes);
  takenNodes.add(newGroupId);

  // Stamp parentGroupId on each new child.
  for (const child of newChildren) {
    if (!child.data) child.data = {};
    (child.data as { parentGroupId?: string }).parentGroupId = newGroupId;
  }

  // Clone the group node + rewrite its exposedPorts to point at new child ids.
  const sourceData = (args.group.data as unknown as GroupData | undefined) ?? null;
  const newExposed: ExposedPort[] = (sourceData?.exposedPorts ?? []).map((ep) => {
    const newChildId = oldToNewChildId.get(ep.childId) ?? ep.childId;
    return {
      id: ep.id, // id is unique within a group, not across groups, so reuse is fine
      childId: newChildId,
      childPortId: ep.childPortId,
      direction: ep.direction,
      cableType: ep.cableType,
      ...(ep.label !== undefined ? { label: ep.label } : {}),
    };
  });
  const newGroupData: GroupData = {
    childIds: newChildren.map((c) => c.id),
    exposedPorts: newExposed,
  };
  if (sourceData?.label !== undefined) newGroupData.label = sourceData.label;
  // The duplicate inherits the source's expanded state — defaulting to
  // collapsed feels less surprising, so we force it off.
  newGroupData.expanded = false;
  const newGroup: ModuleNode = {
    id: newGroupId,
    type: 'group',
    domain: 'meta',
    position: { x: args.group.position.x + offset.x, y: args.group.position.y + offset.y },
    params: {},
    data: newGroupData as unknown as Record<string, unknown>,
  };

  // Clone internal edges. An edge is "internal" iff both endpoints'
  // nodeIds are in the old-id → new-id map.
  const newEdges: Edge[] = [];
  for (const edge of args.edges) {
    const srcNew = oldToNewChildId.get(edge.source.nodeId);
    const tgtNew = oldToNewChildId.get(edge.target.nodeId);
    if (!srcNew || !tgtNew) continue; // not strictly internal
    const newEdgeId = mintEdgeIdLocal(takenEdges);
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

function mintIdLocal(type: string, taken: Set<string>): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${type}-${randomSliceLocal()}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${type}-${randomSliceLocal()}-${randomSliceLocal()}`;
}

function mintEdgeIdLocal(taken: Set<string>): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `e-${randomSliceLocal()}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `e-${randomSliceLocal()}-${randomSliceLocal()}`;
}

function randomSliceLocal(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
