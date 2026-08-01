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

import { useStore } from '@xyflow/svelte';
import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
import type { KnobCurve, ModuleNode, ParamDef, PortDef } from '$lib/graph/types';
import { setNodeParam } from '$lib/graph/mutate';
import { useEngine, type EngineContext } from '$lib/audio/engine-context';

/** The SvelteFlow store handle (the plain context object `useStore` returns). */
export type CardFlowStore = ReturnType<typeof useStore>;

/**
 * Capture the SvelteFlow store when the card mounts INSIDE the provider (every
 * canvas card — identical behavior to a bare `useStore()`), else NULL: a card
 * PLAIN-MOUNTED outside the provider (the dock full-view / dock rail verbatim
 * mounts) must self-gate, not throw. An un-guarded `useStore()` in a card
 * init THREW during the DockFullView occupant swap, aborting the Svelte flush
 * mid-render — the faceplate kept showing the PREVIOUS module ("expand B while
 * A is open switched nothing"). Mirror of PatchPanel's captureFlowStore
 * self-gate. MUST be called during component init (it reads component
 * context). Zoom-aware consumers treat null as zoom 1 (card-resize.ts).
 */
export function captureFlowStore(): CardFlowStore | null {
  try {
    return useStore();
  } catch {
    return null; // outside the provider (dock full-view / rail plain-mount)
  }
}

/**
 * Derive PatchPanel PortDescriptors straight from a def's port list, so the
 * card can never drift out of sync with the contract (ids, cable types and
 * declared order all come from the def).
 *
 * THREE label tiers, most specific first:
 *   1. `labels[p.id]` — the CARD's display override (a per-card rename);
 *   2. `PortDef.label` — the DEF's co-located label, so a port's human name can
 *      be authored once beside the port instead of restated by every surface
 *      that draws it (the shell passes no overrides map at all, so this is the
 *      only way a migrated module's jack gets an authored name);
 *   3. neither — fall through to the shared verbose-label derivation in
 *      patch-panel-labels (which is what an omitted `label` always meant).
 */
export function portsFromDef(
  ports: readonly PortDef[],
  labels: Record<string, string> = {},
): PortDescriptor[] {
  return ports.map((p) => {
    const label = labels[p.id] ?? p.label;
    return label !== undefined ? { id: p.id, label, cable: p.type } : { id: p.id, cable: p.type };
  });
}

/** The four knob/fader props every control primitive takes (`Fader`,
 *  `KnobConic`), spreadable straight into the component. */
export interface CardParamProps {
  min: number;
  max: number;
  defaultValue: number;
  label: string;
  curve: KnobCurve;
}

/**
 * The range + label a control must use, READ OFF THE DEF.
 *
 * WHY THIS EXISTS. A card that re-types `min={-1} max={1}` beside a def that
 * declares something else is invisible to EVERY gate we have: `contract-lock`,
 * `module-docs-lint` and the range assertions all read the DEF, so the card can
 * write values the contract forbids and the model silently clamps them — the
 * BACKDRAFT XyPad failure (±1 pads on a ±0.2 param, most of the stick dead;
 * CLAUDE.md "A CARD can silently disagree with its DEF"). Spreading this makes
 * the divergence impossible rather than merely detectable:
 *
 *     <Fader {...paramProps(vcaDef, 'base')} value={base} onchange={…} />
 *
 * Throws on an unknown id — a typo must fail loudly at mount, not fall back to
 * a 0..1 default that looks plausible.
 */
export function paramProps(
  def: { params: ReadonlyArray<ParamDef> },
  id: string,
): CardParamProps {
  const p = def.params.find((d) => d.id === id);
  if (!p) throw new Error(`paramProps: no param '${id}' on this def`);
  return { min: p.min, max: p.max, defaultValue: p.defaultValue, label: p.label, curve: p.curve };
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
