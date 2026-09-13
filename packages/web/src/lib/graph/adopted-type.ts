// ONE upstream walk for TYPE-TRANSPARENT pass-through outputs
// (`PortDef.adoptsUpstreamFrom`).
//
// WHY THIS FILE EXISTS — the chicken-and-egg the owner hit twice.
//
// `adoptsUpstreamFrom` says "this output emits whatever is patched into that
// input". It was born in `buildPatchSnapshot`, where it re-derives the
// `sourceType` of an edge that ALREADY EXISTS, so that the cross-domain bridge
// reads a scaled CV on the raw tail-sample path instead of RMS-envelope-
// following it (the SCALER dead-knob bug).
//
// But CREATING a cable is decided by `canConnect(srcType, dstType)`, which is
// handed two CABLE TYPES and nothing else — no node, no port, no graph — so it
// could only ever see SCALER's DECLARED `audio`, and `audio → cv` is refused by
// design. The result was an output that was type-transparent for READING and
// opaque for PATCHING: `scaler.out` would not connect to any `cv`-typed jack,
// so the adoption never got the chance to apply. The owner's report was exactly
// that — *"scaler's output wont patch to cv ins"*.
//
// The fix is to resolve the EFFECTIVE emitted type BEFORE validating, using the
// same walk the snapshot already does. This module is that walk, extracted so
// there is exactly one of it: a second copy would drift, and a drifted copy is
// how "connectable" and "connected" end up disagreeing again.
//
// `canConnect` stays a PURE two-type function. Nothing here widens the type
// rule — `audio → cv` remains refused in general. What changes is only WHICH
// type a pass-through output is judged on: the one it will actually emit.
//
// ⚠ THE UNPATCHED CASE IS A REFUSAL, DELIBERATELY. With nothing feeding the
// named input there is no adopted type, `resolveEmittedType` returns undefined,
// and every caller falls back to the port's DECLARED type — so a bare SCALER's
// `out` is `audio` and will NOT connect to a `cv` jack until a CV is patched
// into its `in`. Permitting it would manufacture an edge whose runtime type is
// genuinely `audio` landing on a CV param — precisely the DC/click hazard
// `canConnect` exists to prevent — and the snapshot resolver would keep it
// `audio` anyway, so the cable would exist and misbehave. Patch the source
// first and the output cable connects; that ordering is stated in the docs of
// every module that adopts.

import type { CableType, Edge, PortDef } from './types';

/** The narrow def view the walk needs: a module's declared port lists. Any
 *  AudioModuleDef / VideoModuleDef / MetaModuleDef is assignable. */
export interface AdoptionDefView {
  inputs?: readonly PortDef[];
  outputs?: readonly PortDef[];
}

/** The minimum edge shape the walk reads. Full `Edge` is assignable. */
export interface AdoptionEdgeView {
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: CableType;
}

/**
 * Everything the walk needs about the live graph, as three lookups — so the
 * pure model layer never has to import a store, and a caller that already has
 * the nodes/edges to hand builds one in O(E) instead of re-deriving per edge.
 */
export interface AdoptionGraph {
  resolveDef: (moduleType: string) => AdoptionDefView | undefined;
  nodeType: (nodeId: string) => string | undefined;
  /** The single edge feeding (nodeId, inputPortId), if any. */
  inboundEdge: (nodeId: string, inputPortId: string) => AdoptionEdgeView | undefined;
}

/** Cycle / pathological-chain guard. A chain of pass-throughs longer than this
 *  resolves to `undefined` and every caller falls back to the declared type —
 *  the same bound the snapshot resolver has always used. */
const MAX_CHAIN_DEPTH = 16;

/**
 * Build an AdoptionGraph over a node list + an edge list. The inbound index is
 * built ONCE, so validating a whole fragment stays linear rather than
 * quadratic.
 */
export function makeAdoptionGraph(
  nodes: readonly { id: string; type: string }[],
  edges: readonly AdoptionEdgeView[],
  resolveDef: (moduleType: string) => AdoptionDefView | undefined,
): AdoptionGraph {
  const typeById = new Map<string, string>();
  for (const n of nodes) typeById.set(n.id, n.type);
  const inbound = new Map<string, AdoptionEdgeView>();
  for (const e of edges) inbound.set(`${e.target.nodeId}\u0000${e.target.portId}`, e);
  return {
    resolveDef,
    nodeType: (id) => typeById.get(id),
    inboundEdge: (nodeId, portId) => inbound.get(`${nodeId}\u0000${portId}`),
  };
}

/**
 * What does (nodeId, outPortId) actually EMIT right now?
 *
 *   * A port that does NOT declare `adoptsUpstreamFrom` → its declared `type`.
 *   * A pass-through with a cable on the named input → the type of whatever is
 *     feeding it, chasing chained pass-throughs (SCALER → SCALER → …) up to
 *     MAX_CHAIN_DEPTH.
 *   * A pass-through with NOTHING on the named input → `undefined`. Callers
 *     MUST fall back to the declared type; see the unpatched-case note above.
 *   * An unregistered module / unknown port → `undefined`, same fallback.
 *
 * Note the upstream's DECLARED port type wins over the feeding edge's stored
 * `sourceType`: a stale or mislabelled cable-type on an edge cannot re-type a
 * pass-through. The stored value is used only when the upstream port itself
 * cannot be resolved (a group's exposed port, a module that has since been
 * unregistered), which is the same precedence the snapshot resolver shipped.
 */
export function resolveEmittedType(
  nodeId: string,
  outPortId: string,
  g: AdoptionGraph,
  depth = 0,
): CableType | undefined {
  if (depth > MAX_CHAIN_DEPTH) return undefined;
  const def = g.resolveDef(g.nodeType(nodeId) ?? '');
  const outPort = def?.outputs?.find((p) => p.id === outPortId);
  if (!outPort?.adoptsUpstreamFrom) return outPort?.type;
  const feeder = g.inboundEdge(nodeId, outPort.adoptsUpstreamFrom);
  if (!feeder) return undefined; // nothing patched in → caller uses the declared type
  // The feeder's source might itself be a pass-through — recurse.
  const upstream = resolveEmittedType(feeder.source.nodeId, feeder.source.portId, g, depth + 1);
  return upstream ?? feeder.sourceType;
}

/**
 * The type a prospective cable FROM this output should be judged on: the
 * resolved emitted type when there is one, else the port's declared type.
 * This is the value every connection validator wants — it is never undefined,
 * so a caller cannot accidentally treat "no adoption" as "no type".
 */
export function effectiveOutputType(
  nodeId: string,
  outPort: Pick<PortDef, 'id' | 'type' | 'adoptsUpstreamFrom'>,
  g: AdoptionGraph | undefined,
): CableType {
  if (!g || !outPort.adoptsUpstreamFrom) return outPort.type;
  return resolveEmittedType(nodeId, outPort.id, g) ?? outPort.type;
}
