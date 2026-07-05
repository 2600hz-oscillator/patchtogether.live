// packages/web/src/lib/graph/validate-edge.ts
//
// FW3 foundational seam (Phase 3b) — a PURE, framework-free edge/graph
// validator for the patch data model.
//
// WHY THIS EXISTS
// ---------------
// Three edge-write paths feed the reconciler (handleConnect drag,
// loadEnvelopeIntoStore import, resurrectSavedGroup). The reconciler's
// engine.addEdge THROWS on a missing/mismatched port, and that throw is
// swallowed at the reconcile-pass level — so ONE malformed edge silently
// aborts the WHOLE reconcile pass for every peer in the rackspace. This
// validator lets each write path drop the single bad edge BEFORE it reaches
// the engine, instead of letting it poison the batch.
//
// SCOPE — STRUCTURAL CHECKS ONLY
// ------------------------------
// We check that an edge is *structurally* materializable:
//   * both endpoint nodes exist,
//   * the source handle is a declared OUTPUT and the target a declared INPUT
//     (direction), both resolving on their defs,
//   * canConnect(sourceType, targetType) passes (domain/type compatibility),
//   * for validateGraphFragment, the node's module type is registered.
//
// We deliberately DO NOT:
//   * enforce per-rackspace caps — already enforced at insertSavedGroup /
//     addNode.
//   * validate param values or `data` shape — handled by each module def's
//     migrate().
//
// PURITY — no Svelte / SvelteFlow / Yjs imports. This is a model-layer file
// so it ports straight into the native core. It imports only the data-model
// types + canConnect from graph/types.ts and the resolveExposedPort helper
// from group-projection.ts (both already pure).

import type { Edge, ModuleNode, CableType, PortDef } from './types';
import { canConnectToPort } from './types';
import { resolveExposedPort } from './group-projection';

/**
 * Minimal def shape the validator needs: a module's declared input + output
 * ports. The full ModuleDef carries far more (params, card
 * metadata); validation only reads the port lists, so we accept this narrow
 * structural view. Any AudioModuleDef / VideoModuleDef / MetaModuleDef is
 * assignable to it.
 */
export interface ValidatorDef {
  inputs: readonly PortDef[];
  outputs: readonly PortDef[];
}

/**
 * A (type) => def lookup. Callers pass the existing chain
 * `getModuleDef(t) ?? getVideoModuleDef(t) ?? getMetaModuleDef(t)`. Returns
 * undefined when the module type is not registered. The lookup is NOT baked
 * in here so the model layer stays free of the registry singletons.
 */
export type ResolveDef = (type: string) => ValidatorDef | undefined;

export interface ValidateResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false. Absent when ok. */
  reason?: string;
}

/**
 * Resolve one edge endpoint to a concrete {cableType, direction}:
 *
 *   1. GROUP exposed port FIRST — mirror handleConnect (Canvas.svelte
 *      ~1424-1425): a cable to a saved group's exposed handle is resolved via
 *      resolveExposedPort, which yields the exposed port's declared cableType
 *      + direction. So a cable to a group's exposed port validates correctly
 *      without the group node needing a module def.
 *   2. Otherwise look the port up on the node's module def, in the requested
 *      direction (output for a source endpoint, input for a target endpoint).
 *
 * Returns null when neither path resolves the handle — the caller turns that
 * into a validation failure with an appropriate reason.
 */
function resolveEndpoint(
  node: ModuleNode,
  portId: string,
  want: 'output' | 'input',
  resolveDef: ResolveDef,
): { cableType: CableType; accepts?: readonly CableType[] } | null {
  // 1) Group exposed port — resolve BEFORE consulting any module def.
  const exposed = resolveExposedPort(node, portId);
  if (exposed) {
    // The exposed port carries its own direction. A source endpoint must be
    // an exposed OUTPUT; a target endpoint an exposed INPUT.
    if (exposed.direction !== want) return null;
    return { cableType: exposed.cableType };
  }

  // 2) Regular module port via the def.
  const def = resolveDef(node.type);
  if (!def) return null;
  const ports = want === 'output' ? def.outputs : def.inputs;
  const port = ports.find((p) => p.id === portId);
  if (!port) return null;
  // `accepts` (per-port source widening, e.g. a SCOPE probe) is honoured on
  // INPUT ports only — outputs never widen what they emit.
  return want === 'input'
    ? { cableType: port.type, accepts: port.accepts }
    : { cableType: port.type };
}

/**
 * Validate a single edge against the current node set + a def lookup.
 *
 * Rules enforced (in order, returning the first failure):
 *   1. The source node exists.
 *   2. The target node exists.
 *   3. The source handle resolves as an OUTPUT (declared output port, or an
 *      exposed-output group port). An input-as-source is rejected here.
 *   4. The target handle resolves as an INPUT (declared input port, or an
 *      exposed-input group port). An output-as-target is rejected here.
 *   5. canConnect(sourceType, targetType) passes — domain/type compatibility.
 *
 * `edge.sourceType` / `edge.targetType` are IGNORED for compatibility — we
 * re-derive the real types from the resolved ports so a stale or spoofed
 * cable-type on the edge can't sneak an incompatible patch past canConnect.
 */
export function validateEdge(
  edge: Edge,
  nodes: readonly ModuleNode[],
  resolveDef: ResolveDef,
): ValidateResult {
  const srcNode = nodes.find((n) => n.id === edge.source.nodeId);
  if (!srcNode) {
    return { ok: false, reason: `source node ${edge.source.nodeId} not found` };
  }
  const dstNode = nodes.find((n) => n.id === edge.target.nodeId);
  if (!dstNode) {
    return { ok: false, reason: `target node ${edge.target.nodeId} not found` };
  }

  const src = resolveEndpoint(srcNode, edge.source.portId, 'output', resolveDef);
  if (!src) {
    return {
      ok: false,
      reason: `source ${srcNode.type}.${edge.source.portId} is not a declared output port`,
    };
  }

  const dst = resolveEndpoint(dstNode, edge.target.portId, 'input', resolveDef);
  if (!dst) {
    return {
      ok: false,
      reason: `target ${dstNode.type}.${edge.target.portId} is not a declared input port`,
    };
  }

  if (!canConnectToPort(src.cableType, { type: dst.cableType, accepts: dst.accepts })) {
    return {
      ok: false,
      reason: `incompatible cable types ${src.cableType} → ${dst.cableType}`,
    };
  }

  return { ok: true };
}

export interface GraphFragment {
  nodes: readonly ModuleNode[];
  edges: readonly Edge[];
}

export interface FragmentValidation {
  /** Edges that passed validateEdge. */
  validEdges: Edge[];
  /** Edges dropped, paired with the reason they failed validateEdge. */
  droppedEdges: { edge: Edge; reason: string }[];
  /** Nodes dropped because their module type is not registered. */
  droppedNodes: { node: ModuleNode; reason: string }[];
}

/**
 * Validate a whole graph fragment (the unit each write path hands the
 * reconciler).
 *
 *   * Drops nodes whose module type is NOT registered (resolveDef returns
 *     undefined). Group nodes are kept — they have no module def but ARE the
 *     domain of resolveExposedPort, so they are exempt from the type-registered
 *     check. (The reconciler's `domain === 'meta'` skip keeps them out of
 *     engine.addNode regardless.)
 *   * Drops edges failing validateEdge. Edges are validated against the
 *     SURVIVING node set (after the unregistered-type drop), so an edge whose
 *     endpoint references a node we just dropped fails validateEdge's
 *     "source/target node not found" check and is dropped too.
 */
export function validateGraphFragment(
  fragment: GraphFragment,
  resolveDef: ResolveDef,
): FragmentValidation {
  const droppedNodes: { node: ModuleNode; reason: string }[] = [];
  const validNodes: ModuleNode[] = [];

  for (const node of fragment.nodes) {
    // Group nodes have no module def but are legitimate (they carry exposed
    // ports). Keep them; gate only real (audio/video) module types.
    if (node.type === 'group') {
      validNodes.push(node);
      continue;
    }
    if (!resolveDef(node.type)) {
      droppedNodes.push({ node, reason: `module type ${node.type} is not registered` });
      continue;
    }
    validNodes.push(node);
  }

  const validEdges: Edge[] = [];
  const droppedEdges: { edge: Edge; reason: string }[] = [];

  for (const edge of fragment.edges) {
    const res = validateEdge(edge, validNodes, resolveDef);
    if (res.ok) {
      validEdges.push(edge);
    } else {
      droppedEdges.push({ edge, reason: res.reason ?? 'invalid edge' });
    }
  }

  return { validEdges, droppedEdges, droppedNodes };
}
