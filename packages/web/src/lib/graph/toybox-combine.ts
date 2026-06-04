// packages/web/src/lib/graph/toybox-combine.ts
//
// TOYBOX Phase 4 — Yjs mutators for the combine GRAPH (node.data.combine).
//
// The card edits the combine DAG (toybox-combine-graph.ts) live; every mutation
// writes node.data.combine through the patch proxy inside a single transaction
// tagged LOCAL_ORIGIN, then the video factory reads the live node each frame and
// the reconcile updates the output. Reads go through the live patch proxy.
//
// CRITICAL (same trap as control-surface + the sequencer save-to-slot bug,
// [[yjs-save-load-real-ydoc]]): these mutators mutate node.data.combine IN PLACE
// — push a NEW plain object onto nodes/edges, splice to remove, set a single key
// on a node's params object. They must NEVER rebuild-and-reassign an array/object
// that already holds live Y types (e.g. `combine.nodes = [...old, new]`): once an
// entry has synced it is a Y.Map, and spreading it into a fresh array re-
// integrates the already-integrated Y type → Yjs throws "Type already
// integrated". The pure helpers in toybox-combine-graph.ts (validateConnect,
// makeOpNode, …) compute WHAT to add as plain objects; we append those.
//
// The first edit on an EMPTY/absent/legacy combine seeds the default graph
// (makeDefaultCombineGraph) so a card that was only ever the code default
// becomes editable in place.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import {
  type ToyboxCombineGraph,
  type ToyboxGraphNode,
  type ToyboxInPort,
  type ToyboxOpKind,
  type ConnectError,
  isCombineGraph,
  makeDefaultCombineGraph,
  makeOpNode,
  validateConnect,
  canDeleteNode,
  edgesTouching,
  edgeIndex,
  nodeIndex,
  findNode,
} from '$lib/video/toybox-combine-graph';

/** Read a node's combine field as a GRAPH. Returns undefined for absent or
 *  legacy ({ steps }) shapes (the caller seeds a default before mutating). */
export function readCombineGraph(node: { data?: unknown } | undefined): ToyboxCombineGraph | undefined {
  const d = node?.data as { combine?: unknown } | undefined;
  if (!d) return undefined;
  return isCombineGraph(d.combine) ? (d.combine as ToyboxCombineGraph) : undefined;
}

/**
 * Run `fn` against the node's live combine GRAPH inside a Yjs transaction.
 * Seeds a fresh default graph IN PLACE first if node.data.combine is absent or
 * the legacy linear shape — building the default's nodes/edges by pushing plain
 * objects so nothing already-integrated is reassigned.
 */
function mutateCombine(nodeId: string, fn: (g: ToyboxCombineGraph) => void): void {
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return;
    if (!target.data) (target as { data: Record<string, unknown> }).data = {};
    const data = target.data as { combine?: unknown };
    if (!isCombineGraph(data.combine)) {
      // Seed the default graph in place: create the container, then push the
      // default nodes/edges (plain objects) so they integrate cleanly.
      data.combine = { nodes: [], edges: [] } as ToyboxCombineGraph;
      const def = makeDefaultCombineGraph();
      const g = data.combine as ToyboxCombineGraph;
      for (const n of def.nodes) g.nodes.push(n);
      for (const e of def.edges) g.edges.push(e);
    }
    fn(data.combine as ToyboxCombineGraph);
  }, LOCAL_ORIGIN);
}

/** Ensure node.data.combine is a graph (seed the default if empty/legacy).
 *  Returns nothing — use readCombineGraph to read it back afterwards. */
export function ensureCombineGraph(nodeId: string): void {
  mutateCombine(nodeId, () => {});
}

/** Add an op node of `kind`; returns the new node's id (or null if no node). */
export function addCombineNode(nodeId: string, kind: ToyboxOpKind): string | null {
  let newId: string | null = null;
  mutateCombine(nodeId, (g) => {
    const n = makeOpNode(g, kind); // plain object
    g.nodes.push(n); // append in place
    newId = n.id;
  });
  return newId;
}

/** Connect `from`'s output → `to`'s input `toPort`. Returns the connect verdict
 *  (so the caller/test can assert WHY a connect was rejected). Mutates only on
 *  success. */
export function connectCombine(
  nodeId: string,
  from: string,
  to: string,
  toPort: ToyboxInPort,
): { ok: boolean; error?: ConnectError } {
  let result: { ok: boolean; error?: ConnectError } = { ok: false, error: 'missing-node' };
  mutateCombine(nodeId, (g) => {
    const v = validateConnect(g, from, to, toPort);
    result = { ok: v.ok, error: v.error };
    if (v.ok && v.edge) g.edges.push(v.edge); // append a NEW plain edge in place
  });
  return result;
}

/** Delete an edge by id (in place). No-op if it doesn't exist. */
export function deleteCombineEdge(nodeId: string, edgeId: string): void {
  mutateCombine(nodeId, (g) => {
    const idx = edgeIndex(g, edgeId);
    if (idx >= 0) g.edges.splice(idx, 1); // remove in place
  });
}

/** Delete an op node + all edges touching it (in place). SOURCE/OUTPUT nodes
 *  are structural and cannot be deleted (no-op). */
export function deleteCombineNode(nodeId: string, targetNodeId: string): void {
  mutateCombine(nodeId, (g) => {
    if (!canDeleteNode(g, targetNodeId)) return;
    // Remove touching edges first (splice each in place, by id, high→low).
    const touching = edgesTouching(g, targetNodeId);
    for (const eid of touching) {
      const ei = edgeIndex(g, eid);
      if (ei >= 0) g.edges.splice(ei, 1);
    }
    const ni = nodeIndex(g, targetNodeId);
    if (ni >= 0) g.nodes.splice(ni, 1); // remove the node in place
  });
}

/** Set one float param on an op node (in place). No-op for unknown node. */
export function setCombineNodeParam(
  nodeId: string,
  targetNodeId: string,
  paramId: string,
  value: number,
): void {
  mutateCombine(nodeId, (g) => {
    const n = findNode(g, targetNodeId);
    if (!n) return;
    if (!n.params) n.params = {};
    n.params[paramId] = value; // set a single key in place (never spread params)
  });
}

/** Move a node's editor position (in place) — cosmetic, but persisted so the
 *  layout round-trips through save/load + multiplayer. */
export function setCombineNodePosition(
  nodeId: string,
  targetNodeId: string,
  x: number,
  y: number,
): void {
  mutateCombine(nodeId, (g) => {
    const n = findNode(g, targetNodeId);
    if (!n) return;
    n.x = x; // set in place
    n.y = y;
  });
}

export type { ToyboxGraphNode };
