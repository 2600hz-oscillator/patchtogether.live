// packages/web/src/lib/livecode/port-types.ts
//
// Shared port-resolution + cable-compatibility helpers. Used by
// runtime.ts (to validate patch() / unpatch() at run time) AND by
// diagnostics.ts (to lint patch() calls at edit time without running).
//
// The runtime + the linter share the SAME compatibility predicate so a
// patch the linter highlights green will succeed when run, and one it
// highlights red will fail — no surprises from "the linter was wrong".

import type { ModuleNode, Edge, CableType } from '$lib/graph/types';
import { canConnect, migrateCableType } from '$lib/graph/types';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';

/** A minimal def shape — the fields runtime + diagnostics + completions
 *  need across audio + video registries. */
export interface DefPorts {
  type: string;
  domain: 'audio' | 'video';
  inputs: readonly { id: string; type: CableType }[];
  outputs: readonly { id: string; type: CableType }[];
}

/** Pull a def from whichever registry owns it. Returns undefined if the
 *  module type isn't registered. */
export function getDefForType(type: string): DefPorts | undefined {
  const audio = getModuleDef(type as never);
  if (audio) return audio as DefPorts;
  const video = getVideoModuleDef(type as never);
  if (video) return video as DefPorts;
  return undefined;
}

/** Pull a def from a live ModuleNode. */
export function getDefForNode(node: ModuleNode): DefPorts | undefined {
  return getDefForType(node.type);
}

/** Liberal patch compatibility — matches what the manual cable-drag
 *  flow allows. The DSL-evaluator's isCompatible was the same predicate;
 *  consolidating here so both the editor lint + the runtime stay
 *  in lockstep. */
export function isPatchCompatible(srcType: CableType, dstType: CableType): boolean {
  // canConnect already migrates legacy 9-type strings → the 4 post-collapse
  // types and covers cv↔cv (the former pitch/gate cross-patches), poly↔cv, and
  // cv→video. Delegate to it, then keep the livecode flow's slightly-more-liberal
  // allowance: audio ↔ cv both directions (the DSL has always let scripts wire an
  // audio source into a cv input and vice-versa; not newly restricting that).
  if (canConnect(srcType, dstType)) return true;
  const src = migrateCableType(srcType);
  const dst = migrateCableType(dstType);
  const audioOrCv: ReadonlySet<CableType> = new Set<CableType>(['audio', 'cv']);
  if (audioOrCv.has(src) && audioOrCv.has(dst)) return true;
  return false;
}

/** Parse 'moduleName.portId' into its two halves. Returns null when
 *  malformed (no dot, leading/trailing dot, empty halves). */
export function parsePortRef(ref: string): { node: string; port: string } | null {
  const i = ref.indexOf('.');
  if (i <= 0 || i >= ref.length - 1) return null;
  return { node: ref.slice(0, i), port: ref.slice(i + 1) };
}

/** Look up a module on the rack by its display name (data.name) OR
 *  its raw node id. Case-insensitive on name. Returns undefined if not
 *  found. */
export function findModuleByName(
  nodes: Record<string, ModuleNode | undefined>,
  name: string,
): ModuleNode | undefined {
  if (nodes[name]) return nodes[name];
  const lower = name.toLowerCase();
  for (const n of Object.values(nodes)) {
    if (!n) continue;
    const nm = ((n.data?.name as string | undefined) ?? '').toLowerCase();
    if (nm === lower) return n;
  }
  return undefined;
}

/** Result of resolveCable: which side is source, which is dest, the
 *  underlying ports + a uniform error message if the resolution failed.
 *
 *  Direction-agnostic — call it with whichever order the user typed.
 *  Returns ok=true when EXACTLY ONE direction is valid:
 *
 *    A → B (A.out → B.in)
 *    B → A (B.out → A.in)
 *
 *  If both are valid (rare; mostly when a module has same-named in + out
 *  ports), prefers the first arg as source. If neither, returns ok=false
 *  with the most-helpful error reason. */
export interface ResolvedCable {
  ok: true;
  source: { node: ModuleNode; port: { id: string; type: CableType } };
  target: { node: ModuleNode; port: { id: string; type: CableType } };
}
export interface ResolvedCableErr {
  ok: false;
  reason: string;
}

export function resolveCable(
  nodes: Record<string, ModuleNode | undefined>,
  refA: string,
  refB: string,
): ResolvedCable | ResolvedCableErr {
  const a = parsePortRef(refA);
  const b = parsePortRef(refB);
  if (!a) return { ok: false, reason: `'${refA}' is not a 'module.port' reference` };
  if (!b) return { ok: false, reason: `'${refB}' is not a 'module.port' reference` };
  const nodeA = findModuleByName(nodes, a.node);
  const nodeB = findModuleByName(nodes, b.node);
  if (!nodeA) return { ok: false, reason: `module '${a.node}' not found` };
  if (!nodeB) return { ok: false, reason: `module '${b.node}' not found` };
  const defA = getDefForNode(nodeA);
  const defB = getDefForNode(nodeB);
  if (!defA) return { ok: false, reason: `module type '${nodeA.type}' not registered` };
  if (!defB) return { ok: false, reason: `module type '${nodeB.type}' not registered` };

  // Try A.out → B.in
  const aOut = defA.outputs.find((p) => p.id === a.port);
  const bIn = defB.inputs.find((p) => p.id === b.port);
  if (aOut && bIn && isPatchCompatible(aOut.type, bIn.type)) {
    return {
      ok: true,
      source: { node: nodeA, port: aOut },
      target: { node: nodeB, port: bIn },
    };
  }

  // Try B.out → A.in
  const bOut = defB.outputs.find((p) => p.id === b.port);
  const aIn = defA.inputs.find((p) => p.id === a.port);
  if (bOut && aIn && isPatchCompatible(bOut.type, aIn.type)) {
    return {
      ok: true,
      source: { node: nodeB, port: bOut },
      target: { node: nodeA, port: aIn },
    };
  }

  // Neither direction worked — disambiguate the failure for a helpful
  // error.
  if (!aOut && !aIn) return { ok: false, reason: `'${a.node}' has no port '${a.port}'` };
  if (!bOut && !bIn) return { ok: false, reason: `'${b.node}' has no port '${b.port}'` };
  // Both ports exist but no direction is compatible.
  if (aOut && bOut)  return { ok: false, reason: `both '${refA}' and '${refB}' are outputs — patch needs one out + one in` };
  if (aIn && bIn)    return { ok: false, reason: `both '${refA}' and '${refB}' are inputs — patch needs one out + one in` };
  // One side is out, the other in, but types don't allow it.
  if (aOut && bIn) {
    return {
      ok: false,
      reason: `cannot connect ${aOut.type} → ${bIn.type} (${a.node}.${a.port} → ${b.node}.${b.port})`,
    };
  }
  if (bOut && aIn) {
    return {
      ok: false,
      reason: `cannot connect ${bOut.type} → ${aIn.type} (${b.node}.${b.port} → ${a.node}.${a.port})`,
    };
  }
  return { ok: false, reason: `no compatible direction between '${refA}' and '${refB}'` };
}

/** Look up an existing cable's edge id between two endpoints —
 *  direction-agnostic. */
export function findEdgeBetween(
  edges: Record<string, Edge | undefined>,
  resolved: ResolvedCable,
): Edge | undefined {
  for (const e of Object.values(edges)) {
    if (!e) continue;
    if (e.source.nodeId === resolved.source.node.id && e.source.portId === resolved.source.port.id &&
        e.target.nodeId === resolved.target.node.id && e.target.portId === resolved.target.port.id) {
      return e;
    }
  }
  return undefined;
}

/** Build a deterministic edge id from a resolved cable. Mirrors the
 *  evaluator's `e-{src}-{srcPort}-{dst}-{dstPort}` convention so the
 *  reconciler treats the new edge as exactly one cable. */
export function edgeIdForCable(resolved: ResolvedCable): string {
  return `e-${resolved.source.node.id}-${resolved.source.port.id}-${resolved.target.node.id}-${resolved.target.port.id}`;
}
