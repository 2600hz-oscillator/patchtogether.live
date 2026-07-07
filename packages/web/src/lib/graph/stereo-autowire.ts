// packages/web/src/lib/graph/stereo-autowire.ts
//
// PURE, framework-free planner for module-wide stereo L/R auto-wire.
//
// WHY THIS EXISTS
// ---------------
// ~15 audio modules declare `stereoPairs: readonly [string, string][]` on their
// def (clouds, cofefve, rings, charlottes-echos, …) but NOTHING
// reads it at patch-commit time yet. The user wants: patching L (or R) of a
// stereo SOURCE into a stereo-accepting TARGET whose sibling input is currently
// UNPATCHED should auto-wire the OTHER side too (out_l→in_l implies out_r→in_r).
//
// DECIDED DEFAULTS (per the spec):
//   * Only auto-wire when the SOURCE module ALSO declares a matching stereoPairs
//     sibling — so out_l→in_l implies out_r→in_r, NEVER out_l→in_r.
//   * A MONO source into a stereo target's L leaves the sibling UNPATCHED (the
//     engine already normals R←L), so a source with no matching pair → null.
//   * Fire per the EXACT stereoPairs tuple containing the clicked port.
//   * Skip if the sibling TARGET input is already occupied.
//
// NAMING IS NON-UNIFORM across modules: in_l/in_r, inL/inR, L/R, odd/even,
// mix_l/mix_r, main/aux. So siblings are resolved STRICTLY via the stereoPairs
// tuples — never via name patterns.
//
// PURITY — no Svelte / SvelteFlow / Yjs imports. Imports only the data-model
// types + the shared canConnectToPort gate + findOccupant from
// port-patch-helpers (the single occupancy check). Ports straight into a native
// core.

import type { Edge, PortDef, CableType } from './types';
import { canConnectToPort } from './types';
import { findOccupant } from '$lib/ui/port-patch-helpers';

/**
 * The minimal def shape the planner needs: the stereoPairs tuples plus the
 * directional port lists (so a module that reuses `L`/`R` for BOTH inputs and
 * outputs — e.g. charlottes-echos — resolves the correct port in the correct
 * direction). Any AudioModuleDef is assignable.
 */
export interface StereoDef {
  inputs: readonly PortDef[];
  outputs: readonly PortDef[];
  stereoPairs?: readonly (readonly [string, string])[];
}

/**
 * Given a def and a port id, return that port's stereo SIBLING port id, or null
 * if the port is not a member of any stereoPairs tuple.
 *
 * Naming-agnostic: scans the def's stereoPairs tuples for one containing
 * `portId` (in either slot) and returns the OTHER slot. Multiple pairs are
 * supported — the first tuple containing the port wins (a port should never
 * appear in more than one tuple).
 *
 * Note: stereoPairs tuples are shared across inputs + outputs (the def carries
 * a single set; direction is inferred by the caller from which list the port
 * lives in). findStereoSibling therefore returns the sibling ID regardless of
 * direction — the caller (planStereoAutowire) re-resolves the sibling on the
 * correct directional port list.
 */
export function findStereoSibling(def: StereoDef, portId: string): string | null {
  const pairs = def.stereoPairs;
  if (!pairs) return null;
  for (const pair of pairs) {
    if (pair[0] === portId) return pair[1];
    if (pair[1] === portId) return pair[0];
  }
  return null;
}

export interface PlanStereoAutowireArgs {
  /** The port id on the SOURCE module that was just patched (an output). */
  fromPortId: string;
  /** The SOURCE module's def (provides its stereoPairs + outputs). */
  fromDef: StereoDef;
  /** The TARGET node id (the module receiving the cable). */
  toNodeId: string;
  /** The port id on the TARGET module that was just patched (an input). */
  toPortId: string;
  /** The TARGET module's def (provides its stereoPairs + inputs). */
  toDef: StereoDef;
  /** The current edge set — used for the sibling-occupancy check. */
  edges: Partial<Record<string, Edge>> | Record<string, Edge>;
}

export interface StereoAutowirePlan {
  /** The SECOND edge's source port (the source module's sibling OUTPUT). */
  siblingFromPortId: string;
  /** The SECOND edge's target port (the target module's sibling INPUT). */
  siblingToPortId: string;
  /** Resolved cable types for the second edge (for the Edge record). */
  sourceType: CableType;
  targetType: CableType;
}

/**
 * Plan the SECOND (sibling) edge to write when a stereo pair patch is made.
 *
 * Returns the sibling edge to write IFF ALL hold:
 *   1. The TARGET port is a member of one of the TARGET def's stereoPairs tuples
 *      (resolves a `siblingToPortId` that ACTUALLY EXISTS as an INPUT port).
 *   2. The SOURCE def ALSO declares a matching sibling for `fromPortId` that
 *      ACTUALLY EXISTS as an OUTPUT port (so mono→stereo and "no matching
 *      source pair" both fall through to null — the engine normals R←L).
 *   3. The sibling TARGET input is currently UNPATCHED (skip if occupied —
 *      never overwrite an existing connection).
 *   4. canConnectToPort(sourceSiblingType, targetSiblingPort) passes (the
 *      sibling pair is type-compatible, same gate the primary edge used).
 *
 * Returns null otherwise. The caller writes the returned edge INSIDE the same
 * ydoc.transact as the primary edge.
 *
 * NOTE on direction: the primary patch always runs source.OUTPUT → target.INPUT,
 * so the sibling source resolves on `fromDef.outputs` and the sibling target on
 * `toDef.inputs`. We confirm both sibling ports exist in their respective
 * directional lists — a port id that only appears in stereoPairs but not in the
 * directional list (shouldn't happen, but defensive) yields null.
 */
export function planStereoAutowire(args: PlanStereoAutowireArgs): StereoAutowirePlan | null {
  const { fromPortId, fromDef, toNodeId, toPortId, toDef, edges } = args;

  // 1) Target sibling must exist (target port is a stereo-pair member, and its
  //    sibling resolves to a real INPUT port on the target def).
  const siblingToPortId = findStereoSibling(toDef, toPortId);
  if (!siblingToPortId) return null;
  const siblingToPort = toDef.inputs.find((p) => p.id === siblingToPortId);
  if (!siblingToPort) return null;

  // 2) Source sibling must exist (the source ALSO declares the matching pair,
  //    and its sibling resolves to a real OUTPUT port). A mono source — no
  //    matching pair — falls through to null here (engine normals R←L).
  const siblingFromPortId = findStereoSibling(fromDef, fromPortId);
  if (!siblingFromPortId) return null;
  const siblingFromPort = fromDef.outputs.find((p) => p.id === siblingFromPortId);
  if (!siblingFromPort) return null;

  // 3) Skip if the sibling TARGET input is already occupied — never overwrite.
  if (findOccupant(toNodeId, siblingToPortId, edges)) return null;

  // 4) Type-compatibility — reuse the SAME gate the primary edge passed. The
  //    sibling source output's declared type must be acceptable on the sibling
  //    target input (honouring its per-port `accepts` widening).
  if (!canConnectToPort(siblingFromPort.type, siblingToPort)) return null;

  return {
    siblingFromPortId,
    siblingToPortId,
    sourceType: siblingFromPort.type,
    targetType: siblingToPort.type,
  };
}
