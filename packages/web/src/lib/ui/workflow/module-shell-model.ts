// packages/web/src/lib/ui/workflow/module-shell-model.ts
//
// PURE display helpers for the RACKLINE <ModuleShell> + <ModuleShellPlaceholder>
// (P0.3b). Everything a shell/placeholder needs to paint its frame that can be
// computed WITHOUT the DOM or the live registry lives here, so it is
// unit-testable + zero-flake and the components stay thin.
//
// Two things it decides:
//   1. the module's SPINE / domain colour — per the owner decision there is NO
//      separate --spine-* token: a module's spine IS its cable-domain hue, so we
//      resolve it to a `var(--cable-<type>)` reference off the module's primary
//      port (falling back to its domain). The cable is the patch language; the
//      spine paints the same hue as a lane reading aid.
//   2. the LANE face TIER — the LOD engine ($lib/ui/canvas/lod) emits the same
//      four-tier union the curation ladder consumes ('mini'|'compact'|'full'|
//      'dock'), but the LANE never shows the 'dock' full faceplate: that opens in
//      the bottom dock. So in the lane the richest LOD band ('dock', z≥0.95)
//      renders the 'full' (full-in-lane) face; only the dock-full VIEW uses 'dock'.

import type { Tier } from '$lib/ui/canvas/lod';
import type { FaceTier } from './curated-face';

/** The minimal def shape the shell/placeholder model reads. */
export interface ShellDefLike {
  domain?: string;
  inputs?: readonly { id: string; type: string }[];
  outputs?: readonly { id: string; type: string }[];
}

/** Map a module DOMAIN to a representative cable type (used only when a module
 *  declares no ports). Meta/unknown domains fall back to audio's hue. */
function cableTypeForDomain(domain: string | undefined): string {
  switch (domain) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    default:
      return 'audio';
  }
}

/**
 * The module's PRIMARY cable type — the hue its spine is painted. Prefers the
 * first OUTPUT's cable type (what the module emits reads as its identity), then
 * the first INPUT, then the domain fallback. Pure.
 */
export function cableTypeForDef(def: ShellDefLike | undefined): string {
  const out = def?.outputs?.[0]?.type;
  if (out) return out;
  const inp = def?.inputs?.[0]?.type;
  if (inp) return inp;
  return cableTypeForDomain(def?.domain);
}

/** The CSS colour reference for a module's spine/domain chrome:
 *  `var(--cable-<primaryType>)`. Consumed as the `--spine`/`--domain` custom
 *  property on the shell + placeholder roots. */
export function spineCableVar(def: ShellDefLike | undefined): string {
  return `var(--cable-${cableTypeForDef(def)})`;
}

/**
 * The FaceTier a module shows in its LANE for a given LOD tier. Identity for
 * mini/compact/full; the richest LOD band 'dock' collapses to 'full' in the lane
 * (the true 'dock' full faceplate is a separate VIEW rendered in the bottom
 * dock, never in the lane). Pure.
 */
export function laneFaceTier(tier: Tier): FaceTier {
  return tier === 'dock' ? 'full' : tier;
}

/** True when the shell should offer an "Expand · full view" affordance at this
 *  LOD tier — always in-lane (the dock faceplate is reachable at every tier);
 *  kept as a named predicate so the policy has one home if it tightens. */
export function offersFullView(_tier: Tier): boolean {
  return true;
}
