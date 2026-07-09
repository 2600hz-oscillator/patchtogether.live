// packages/web/src/lib/ui/modules/card-kit.ts
//
// Shared MECHANICAL helpers for module card components (LoC campaign rows
// 5+6). Every card used to hand-copy the same four param closures and a
// hand-typed PortDescriptor list restating its def's ports. Both are pure
// boilerplate: the def already carries the port ids/cable types in display
// order, and the closures were byte-identical across ~70 cards.
//
// ZERO-BEHAVIOR-CHANGE contract: these helpers reproduce the exact closure
// bodies the cards carried (same fallback semantics, same readParam path,
// same PatchPanel-rendered port grouping/labels — proven by a zero-diff VRT
// run when the cards migrated). Do not "improve" semantics here without
// treating it as a real rendering/behavior change.

import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
import type { ModuleNode, ParamDef, PortDef } from '$lib/graph/types';
import { setNodeParam } from '$lib/graph/mutate';
import { useEngine, type EngineContext } from '$lib/audio/engine-context';

/**
 * Derive PatchPanel PortDescriptors straight from a def's port list, so the
 * card can never drift out of sync with the contract (ids, cable types and
 * declared order all come from the def).
 *
 * `labels` carries the card's DISPLAY overrides only — ports omitted from the
 * map fall through to the shared verbose-label derivation in
 * patch-panel-labels (which is what an omitted `label` always meant).
 */
export function portsFromDef(
  ports: readonly PortDef[],
  labels: Record<string, string> = {},
): PortDescriptor[] {
  return ports.map((p) =>
    labels[p.id] !== undefined
      ? { id: p.id, label: labels[p.id], cable: p.type }
      : { id: p.id, cable: p.type },
  );
}

export interface CardParamHelpers {
  /** The def's declared defaultValue for a param id (0 when unknown). */
  defaultFor: (k: string) => number;
  /** Stored param value, else `fallback`, else the def default. */
  paramVal: (k: string, fallback?: number) => number;
  /** Curried setter: `onchange={set('cutoff')}`. */
  set: (k: string) => (v: number) => void;
  /** Curried live reader for motorized controls: `readLive={live('cutoff')}`. */
  live: (k: string) => () => number | undefined;
  /** The engine context handle, for cards that need direct engine access. */
  engineCtx: EngineContext;
}

/**
 * The four copy-pasted param closures every card carried, built once from
 * the def + the card's reactive node getter. MUST be called during component
 * init (it reads the Svelte engine context, exactly like the per-card
 * `useEngine()` line it replaces).
 *
 * `getId`/`getNode` are closures over the card's `$props()` id and `$derived`
 * node so every read sees the current values, matching the old inline
 * closures' capture semantics (and keeping the svelte compiler's
 * state_referenced_locally analysis happy).
 */
export function cardParams(
  def: { params: ReadonlyArray<ParamDef> },
  getId: () => string,
  getNode: () => ModuleNode | undefined,
): CardParamHelpers {
  const engineCtx = useEngine();
  const defaultFor = (k: string): number =>
    def.params.find((p) => p.id === k)?.defaultValue ?? 0;
  const paramVal = (k: string, fallback?: number): number => {
    const v = getNode()?.params?.[k];
    if (typeof v === 'number') return v;
    return fallback ?? defaultFor(k);
  };
  const set = (k: string) => (v: number) => {
    setNodeParam(getId(), k, v);
  };
  const live = (k: string) => () => {
    const e = engineCtx.get();
    const node = getNode();
    if (!e || !node) return undefined;
    return e.readParam(node, k);
  };
  return { defaultFor, paramVal, set, live, engineCtx };
}
