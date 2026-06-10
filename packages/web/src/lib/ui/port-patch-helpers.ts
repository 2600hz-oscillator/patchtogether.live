// port-patch-helpers.ts
//
// Pure helpers for the right-click "Patch to..." flow.
//
// The cascading menu (port → modules → ports) needs:
//   1. A list of every OTHER module in the patch (with display name + type label).
//   2. For a chosen target module, the list of ports that are type-compatible
//      with the source port. Direction matters: an OUTPUT source picks INPUTs
//      on the target; an INPUT source picks OUTPUTs.
//   3. For each candidate INPUT, whether it already has an incoming cable so
//      the menu can flag the entry as a destructive overwrite.

import type { Edge, ModuleNode, PortDef } from '$lib/graph/types';
import { canConnect, canConnectToPort } from '$lib/graph/types';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { VideoModuleDef } from '$lib/video/module-registry';
import type { MetaModuleDef } from '$lib/meta/module-registry';

/** Any-domain module def — they all share the port shape we need. Meta
 *  modules (sticky etc.) declare empty inputs/outputs so they're never
 *  actual candidates in the patch-to menu; including them in the union
 *  keeps the type plumbing uniform with the spawn + persistence paths. */
export type AnyDef = AudioModuleDef | VideoModuleDef | MetaModuleDef;

export interface ModuleEntry {
  nodeId: string;
  /** Display name shown in the menu — e.g. "ANALOG VCO #1". */
  displayName: string;
  /** Module type label (e.g. "Analog VCO") shown beside the name. */
  typeLabel: string;
}

export interface CandidatePort {
  portId: string;
  /** Verbose label (already uppercased). */
  label: string;
  /** Type from the def — used to colour the row stripe. */
  cable: string;
  /** When set, this is an INPUT port already receiving from another cable.
   *  Selecting it will replace the existing connection. */
  occupiedBy?: {
    sourceNodeId: string;
    sourcePortId: string;
    sourceDisplayName: string;
  };
}

/**
 * Compute display names for every module in the patch. When a type has more
 * than one instance, suffix with " #N" using insertion order. Single
 * instances use the bare type label.
 */
export function buildModuleEntries(
  nodes: Partial<Record<string, ModuleNode>> | Record<string, ModuleNode>,
  defLookup: (type: string) => AnyDef | undefined,
  excludeNodeId: string,
): ModuleEntry[] {
  const ids = Object.keys(nodes).filter((id) => nodes[id]);
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(nodes[id]!.type, (counts.get(nodes[id]!.type) ?? 0) + 1);

  const indexByType = new Map<string, number>();
  const out: ModuleEntry[] = [];
  for (const id of ids) {
    const n = nodes[id]!;
    const idx = (indexByType.get(n.type) ?? 0) + 1;
    indexByType.set(n.type, idx);
    if (id === excludeNodeId) continue;
    const def = defLookup(n.type);
    const typeLabel = def?.label ?? n.type;
    const total = counts.get(n.type) ?? 1;
    const displayName = total > 1 ? `${typeLabel} #${idx}` : typeLabel;
    out.push({ nodeId: id, displayName, typeLabel });
  }
  return out;
}

/** Module display name for a single node — same numbering rule as
 *  buildModuleEntries. Used to label the source side of an occupied input. */
export function moduleDisplayName(
  nodeId: string,
  nodes: Partial<Record<string, ModuleNode>> | Record<string, ModuleNode>,
  defLookup: (type: string) => AnyDef | undefined,
): string {
  const n = nodes[nodeId];
  if (!n) return nodeId;
  const def = defLookup(n.type);
  const typeLabel = def?.label ?? n.type;
  const sameType = Object.values(nodes).filter(
    (other) => other && other.type === n.type,
  );
  if (sameType.length <= 1) return typeLabel;
  // Index by insertion order.
  const ids = Object.keys(nodes).filter((id) => nodes[id]?.type === n.type);
  const idx = ids.indexOf(nodeId);
  return `${typeLabel} #${idx + 1}`;
}

/**
 * Compute the candidate target ports on `targetDef` for a source port whose
 * cable type is `srcType` and whose direction is `srcDirection`.
 *
 * If `srcDirection === 'output'`, candidates are INPUT ports of the target
 * whose declared type satisfies canConnect(srcType, dstType).
 * If `srcDirection === 'input'`, candidates are OUTPUT ports of the target
 * whose declared type satisfies canConnect(dstType_actually_src_now, srcType).
 *
 * Returned list preserves the def's declared port order.
 */
export function compatibleTargetPorts(
  srcType: string,
  srcDirection: 'output' | 'input',
  targetDef: AnyDef,
  targetNodeId: string,
  edges: Partial<Record<string, Edge>> | Record<string, Edge>,
  nodes: Partial<Record<string, ModuleNode>> | Record<string, ModuleNode>,
  defLookup: (type: string) => AnyDef | undefined,
): CandidatePort[] {
  const out: CandidatePort[] = [];
  if (srcDirection === 'output') {
    for (const p of targetDef.inputs) {
      // Honour a per-port `accepts` widening (e.g. a SCOPE probe taking the CV
      // family on an audio input) so the cascade matches the drag validator.
      if (!canConnectToPort(srcType, p)) continue;
      const occ = findOccupant(targetNodeId, p.id, edges);
      out.push({
        portId: p.id,
        label: portLabel(p),
        cable: p.type as string,
        occupiedBy: occ
          ? {
              sourceNodeId: occ.source.nodeId,
              sourcePortId: occ.source.portId,
              sourceDisplayName: `${moduleDisplayName(occ.source.nodeId, nodes, defLookup)}.${occ.source.portId}`,
            }
          : undefined,
      });
    }
  } else {
    // The source is an INPUT — we're patching FROM the chosen target's
    // OUTPUT into our input. Compatibility is canConnect(targetOutputType,
    // srcType) — the cable runs from target → source.
    for (const p of targetDef.outputs) {
      if (!canConnect(p.type as string, srcType)) continue;
      out.push({
        portId: p.id,
        label: portLabel(p),
        cable: p.type as string,
      });
    }
  }
  return out;
}

/**
 * The single occupancy check: returns the edge currently terminating on
 * (targetNodeId, targetPortId), or undefined if the input is free. Exported so
 * the stereo-autowire planner reuses the EXACT same "is this input occupied?"
 * logic the cascade uses — one source of truth.
 */
export function findOccupant(
  targetNodeId: string,
  targetPortId: string,
  edges: Partial<Record<string, Edge>> | Record<string, Edge>,
): Edge | undefined {
  for (const e of Object.values(edges)) {
    if (!e) continue;
    if (e.target.nodeId === targetNodeId && e.target.portId === targetPortId) {
      return e;
    }
  }
  return undefined;
}

function portLabel(p: PortDef): string {
  return p.id.toUpperCase();
}
