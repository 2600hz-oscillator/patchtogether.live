// packages/web/src/lib/graph/control-surface-params.ts
//
// CONTROL SURFACE param adapter — the single resolution layer the surface card
// uses to turn a binding {moduleId, paramId} into (ParamDef + read + write),
// regardless of whether the source module stores its params FLAT on node.params
// (the normal case) or NESTED in node.data (TOYBOX).
//
// Two branches:
//   - NORMAL module: def from getModuleDef/getVideoModuleDef; read/write
//     node.params[paramId] — today's behaviour, unchanged.
//   - TOYBOX (params namespaced/nested under node.data.layers / node.data.combine):
//     def + get/set via resolveToyboxParam — the SAME live location the card's
//     own knobs, the CV-routing system (toybox-cv-routes.ts), and MIDI all use,
//     so a surface edit, a card edit, a CV write, and a MIDI assign all land on
//     the identical param object. The stored paramId is unchanged (the bare
//     'rotX' / 'combine:<id>:<p>' the toybox knobs already pass), keeping MIDI
//     keying consistent across surface + card.
//
// Writes that reach node.data go through a LOCAL_ORIGIN ydoc transaction so they
// ride the Y.Doc to rack-mates + register on the undo stack (mirrors the toybox
// card mutators). Flat node.params writes use the live patch proxy directly (its
// own setter already transacts) — unchanged from the original card.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode, ParamDef } from '$lib/graph/types';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { CONTROL_SURFACE_TYPE } from '$lib/graph/control-surface';
import {
  resolveToyboxParam,
  type ResolvedToyboxParam,
} from '$lib/video/toybox-control-params';

/** Module types whose params are namespaced/nested in node.data and so resolve
 *  through a bespoke adapter rather than the flat node.params path. */
const NESTED_PARAM_TYPES = new Set<string>(['toybox']);

/** True if this module type stores its controls nested in node.data. */
export function hasNestedParams(type: string | undefined): boolean {
  return !!type && NESTED_PARAM_TYPES.has(type);
}

/** A resolved surface control: its ParamDef + a live get/set bound to the source
 *  node's actual storage location. Returns null when the binding can't resolve
 *  (param no longer exists / source not in a resolvable state). */
export interface ResolvedSurfaceParam {
  def: ParamDef;
  get(): number;
  set(value: number): void;
}

/** Resolve a nested-param (toybox) binding against the LIVE node. Returns null
 *  if unresolvable. Centralises the "wrap the in-place set in a LOCAL_ORIGIN
 *  transaction" so every write rides the Y.Doc. */
function resolveNested(node: ModuleNode, paramId: string): ResolvedSurfaceParam | null {
  let r: ResolvedToyboxParam | null = null;
  if (node.type === 'toybox') r = resolveToyboxParam(node, paramId);
  if (!r) return null;
  const resolved = r;
  return {
    def: resolved.def,
    get: () => resolved.get(),
    set: (value: number) => {
      // Re-resolve INSIDE the transaction against the live node so the setter
      // closes over the current live param object (the toybox layers/combine
      // arrays can be rebuilt by a remote write between renders).
      ydoc.transact(() => {
        const live = patch.nodes[node.id] as ModuleNode | undefined;
        if (!live) return;
        const fresh = live.type === 'toybox' ? resolveToyboxParam(live, paramId) : null;
        (fresh ?? resolved).set(value);
      }, LOCAL_ORIGIN);
    },
  };
}

/** Resolve a normal flat-param binding (def from the registry; node.params I/O). */
function resolveFlat(node: ModuleNode, paramId: string): ResolvedSurfaceParam | null {
  const mdef = getModuleDef(node.type) ?? getVideoModuleDef(node.type);
  const def = mdef?.params.find((p) => p.id === paramId);
  if (!def) return null;
  return {
    def,
    get: () => {
      const live = patch.nodes[node.id] as ModuleNode | undefined;
      return (live?.params[paramId] ?? def.defaultValue ?? 0) as number;
    },
    set: (value: number) => {
      const live = patch.nodes[node.id];
      if (!live) return;
      live.params[paramId] = value; // proxy setter transacts
    },
  };
}

/**
 * Resolve a control-surface binding {moduleId(node), paramId} into a ParamDef +
 * live get/set. Branches on the source module's storage model (flat node.params
 * vs nested node.data). Returns null when unresolvable (so the card drops the
 * proxy, as before).
 */
export function resolveSurfaceParam(
  node: ModuleNode | undefined,
  paramId: string,
): ResolvedSurfaceParam | null {
  if (!node) return null;
  if (node.type === CONTROL_SURFACE_TYPE) return null; // never proxy a surface onto itself
  if (hasNestedParams(node.type)) return resolveNested(node, paramId);
  return resolveFlat(node, paramId);
}

/** Just the ParamDef for a binding (null if unresolvable) — the bound-check the
 *  card uses to decide whether a binding renders + the send-to-surface offer.
 *  Resolves against the LIVE node by id (the type+data may have changed). */
export function paramDefForBinding(
  node: ModuleNode | undefined,
  paramId: string,
): ParamDef | null {
  return resolveSurfaceParam(node, paramId)?.def ?? null;
}
