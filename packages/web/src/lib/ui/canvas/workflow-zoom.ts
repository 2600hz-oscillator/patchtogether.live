// packages/web/src/lib/ui/canvas/workflow-zoom.ts
//
// The ONE shared workflow-mode viewport-zoom signal + the derived LOD tier
// context (STRATA reactive plumbing). This is the thin reactive wrapper around
// the pure `lodTier` in ./lod: Canvas.svelte writes the live zoom here from the
// SvelteFlow `onmove`/`onmoveend` handlers, and descendant module cards read the
// current content tier via `getLodTier()` context (in P0.3 — nothing consumes it
// yet).
//
// Ride the EXISTING viewport signal — one store, not a per-card xyflow
// subscription. `setWorkflowZoom` is called from the same `onViewportMove`
// handler that already ticks the channel-columns overlay, so there is no new
// per-frame listener.

import { writable, derived, type Readable } from 'svelte/store';
import { getContext, setContext } from 'svelte';
import { lodTier, type Tier } from './lod';

/** The live workflow viewport zoom. Seeded to 1 (xyflow's default zoom); the
 *  first pan/zoom overwrites it with the real `flowApi.getViewport().zoom`. */
export const workflowZoom = writable(1);

// Last value we actually pushed — used to DEDUPE. `onmove` fires per animation
// frame (xyflow-coalesced) but a pure PAN leaves zoom unchanged, so most frames
// carry the same zoom; quantizing to 3 decimals also collapses sub-perceptual
// float jitter. Both mean we don't churn the store (and its derived tier) 60×/s.
let lastPushed = 1;

/**
 * Publish a new viewport zoom to the shared store, deduped + quantized. Safe to
 * call every `onmove` frame: non-finite is ignored, and an unchanged (to 3dp)
 * zoom is dropped WITHOUT touching the store, so panning and float-noise frames
 * are free.
 */
export function setWorkflowZoom(zoom: number): void {
  if (!Number.isFinite(zoom)) return;
  const q = Math.round(zoom * 1000) / 1000;
  if (q === lastPushed) return;
  lastPushed = q;
  workflowZoom.set(q);
}

/** Build a hysteretic tier store from a zoom store: it threads the PREVIOUS
 *  emitted tier back into `lodTier` so a boundary-parked zoom doesn't flip-flop
 *  the content tier (the ±hysteresis deadband lives in lod.ts). Stateful via the
 *  closure `prev`; there is exactly one workflow canvas, so one instance. */
function makeLodTierStore(zoom: Readable<number>): Readable<Tier> {
  let prev: Tier | undefined;
  return derived(zoom, ($zoom) => (prev = lodTier($zoom, prev)));
}

/** The derived LOD content tier for the live workflow zoom (mini/compact/full/
 *  dock), with boundary hysteresis. This is what the canvas provides on context
 *  and what P0.3 module cards will read. */
export const lodTierStore: Readable<Tier> = makeLodTierStore(workflowZoom);

// Context key for the LOD tier store. A Symbol so it can't collide with any
// string-keyed context.
const LOD_TIER_CONTEXT = Symbol('workflow-lod-tier');

/**
 * Provide the LOD tier store on the current component's context (call from
 * Canvas.svelte init). Descendant cards read it with `getLodTier()`. Defaults to
 * the shared `lodTierStore` singleton; a custom store can be injected for tests.
 */
export function provideLodTier(store: Readable<Tier> = lodTierStore): Readable<Tier> {
  setContext(LOD_TIER_CONTEXT, store);
  return store;
}

/**
 * Read the LOD tier store from context (call from a module card's init). Falls
 * back to the shared `lodTierStore` singleton when no provider is present (e.g.
 * a card mounted standalone in a VRT scene), so it never returns undefined.
 */
export function getLodTier(): Readable<Tier> {
  return getContext<Readable<Tier> | undefined>(LOD_TIER_CONTEXT) ?? lodTierStore;
}
