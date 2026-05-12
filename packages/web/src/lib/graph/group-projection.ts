// packages/web/src/lib/graph/group-projection.ts
//
// Module-grouping Phase 1 — snapshot projection layer.
//
// Groups are a UI-only abstraction: the audio + video engines must remain
// blissfully unaware that some modules are "inside a group". This file is
// the indirection that makes that possible.
//
// A GROUP! node carries `data.exposedPorts: ExposedPort[]`. Each ExposedPort
// is a stable id paired with the real {childId, childPortId} it stands in
// for. When the canvas draws cables to a group, it draws them onto these
// exposed-port handles. But the reconciler needs to see the REAL child port,
// or it won't be able to materialize the edge in the engine's address space.
//
// `projectGroups(snap)` rewrites any edge endpoint that points at a group's
// exposed port → the real child port. The group node itself stays in the
// snapshot (so the canvas can find it for rendering) but the reconciler's
// `domain === 'meta'` skip rule already keeps it out of engine.addNode.
//
// Pure function. No Yjs, no DOM, no side effects. Empty fast-path: if no
// group nodes exist the input snapshot is returned unchanged (same reference).

import type { Edge, ModuleNode, CableType } from './types';
import type { PatchSnapshot } from './snapshot';

/**
 * A port exposed on the boundary of a GROUP! node. The group's handle at
 * this id stands in for {childId, childPortId} during projection.
 */
export interface ExposedPort {
  /** Stable id used as the group's port handle in Svelte Flow. */
  id: string;
  /** The child module owning the real port. */
  childId: string;
  /** The port id on the child module. */
  childPortId: string;
  /** 'input' or 'output' — drives which handle column on GroupCard. */
  direction: 'input' | 'output';
  /** Cable type — drives the cable-color stripe + canConnect checks. */
  cableType: CableType;
  /** Optional human-readable label (default: derive from childPortId). */
  label?: string;
}

/**
 * A group node's `data` shape. `childIds` records membership so a follow-up
 * Ungroup can iterate them; `parentGroupId` on each child node also encodes
 * the inverse pointer for fast canvas-side filtering.
 */
export interface GroupData {
  label?: string;
  childIds: string[];
  exposedPorts: ExposedPort[];
  /** Phase 2: when true, the group renders its children in place instead of
   *  collapsing them. Phase 1 always collapses. */
  expanded?: boolean;
}

/**
 * Read-only view onto a group node + its parsed data. Internal helper —
 * the snapshot's ModuleNode.data is `unknown`, so we narrow it here.
 */
interface ResolvedGroup {
  node: ModuleNode;
  data: GroupData;
}

function asGroupData(data: unknown): GroupData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<GroupData>;
  if (!Array.isArray(d.exposedPorts)) return null;
  if (!Array.isArray(d.childIds)) return null;
  return {
    label: typeof d.label === 'string' ? d.label : undefined,
    childIds: d.childIds.filter((x): x is string => typeof x === 'string'),
    exposedPorts: d.exposedPorts.filter((p): p is ExposedPort => {
      if (!p || typeof p !== 'object') return false;
      const ep = p as Partial<ExposedPort>;
      return (
        typeof ep.id === 'string' &&
        typeof ep.childId === 'string' &&
        typeof ep.childPortId === 'string' &&
        (ep.direction === 'input' || ep.direction === 'output')
      );
    }),
    expanded: d.expanded === true,
  };
}

/**
 * True iff this snapshot contains at least one group node.
 */
function hasGroups(snap: PatchSnapshot): boolean {
  for (const n of snap.nodes) if (n.type === 'group') return true;
  return false;
}

/**
 * Build the {nodeId:exposedId → {childId, childPortId}} lookup for every
 * exposed port on every group in the snapshot.
 *
 * Returned keys: `${groupNodeId}::${exposedPortId}`.
 */
export function buildExposedPortMap(snap: PatchSnapshot): Map<string, { childId: string; childPortId: string }> {
  const map = new Map<string, { childId: string; childPortId: string }>();
  for (const node of snap.nodes) {
    if (node.type !== 'group') continue;
    const data = asGroupData(node.data);
    if (!data) continue;
    for (const ep of data.exposedPorts) {
      map.set(`${node.id}::${ep.id}`, { childId: ep.childId, childPortId: ep.childPortId });
    }
  }
  return map;
}

/**
 * Project a snapshot through any GROUP! nodes:
 * - Each edge endpoint that names a group's exposed port is rewritten
 *   to point at the underlying child {nodeId, portId}.
 * - Edges whose endpoint references a group but a non-existent exposed
 *   port are dropped (defensive — a stale edge across a group rename).
 * - Edges that touch no group are passed through unchanged.
 *
 * The group node itself is NOT removed from the snapshot. The reconciler's
 * `domain === 'meta'` skip rule already filters it out before engine.addNode
 * runs.
 *
 * Empty fast-path: if the snapshot has no group nodes the input is returned
 * unchanged (same reference) so equality checks downstream still cache.
 */
export function projectGroups(snap: PatchSnapshot): PatchSnapshot {
  if (!hasGroups(snap)) return snap;

  const exposed = buildExposedPortMap(snap);

  const projectedEdges: Edge[] = [];
  for (const edge of snap.edges) {
    let source = edge.source;
    let target = edge.target;
    let drop = false;

    const srcKey = `${edge.source.nodeId}::${edge.source.portId}`;
    if (exposed.has(srcKey)) {
      const real = exposed.get(srcKey)!;
      source = { nodeId: real.childId, portId: real.childPortId };
    } else {
      // If the source NODE is a group but the portId is unknown, drop.
      const srcNode = snap.nodes.find((n) => n.id === edge.source.nodeId);
      if (srcNode?.type === 'group') drop = true;
    }

    const tgtKey = `${edge.target.nodeId}::${edge.target.portId}`;
    if (exposed.has(tgtKey)) {
      const real = exposed.get(tgtKey)!;
      target = { nodeId: real.childId, portId: real.childPortId };
    } else {
      const tgtNode = snap.nodes.find((n) => n.id === edge.target.nodeId);
      if (tgtNode?.type === 'group') drop = true;
    }

    if (drop) continue;
    projectedEdges.push({
      id: edge.id,
      source,
      target,
      sourceType: edge.sourceType,
      targetType: edge.targetType,
    });
  }

  return {
    nodes: snap.nodes,
    edges: projectedEdges,
  };
}
