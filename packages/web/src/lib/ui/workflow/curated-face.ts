// packages/web/src/lib/ui/workflow/curated-face.ts
//
// The PURE top-N selector for the workflow-mode ModuleShell's semantic-zoom
// (STRATA) tiers. Given a module def's co-located `face` (see ModuleFace in
// $lib/graph/types) and a curation TIER, it resolves each ranked control key to
// a lightweight descriptor and returns the first N controls for that tier:
//
//   mini    → 1   (the hero control + live glyph)
//   compact → 3   (the design-point lane tile)
//   full    → 8   (the full-in-lane face)
//   dock    → ALL (the sectioned dock faceplate — order + pages)
//
// PURE + browser-safe (no fs, no registry import): it reads ONLY the passed
// `def` (its `face`, `params`, `controlFamilies`), so it is trivially
// unit-testable and zero-flake. Key resolution uses the SAME unified
// control-key space the docs system defines (control-doc-resolver.ts):
//   - a ParamDef.id                      → kind 'param'
//   - a control-family template `<f>-{n}` → kind 'family' (whole grid/cluster)
//   - anything else (a static button/select) → kind 'static'
// A 'static' key can only be VALIDATED against the numbered legend (an fs read)
// — that is the lint gate's job (module-face-lint.test.ts). The selector treats
// an unrecognized key as a humanized static control so it stays pure.

import type { ModuleFace, ModuleFacePage } from '$lib/graph/types';

/** The curation LADDER — the tiers a face is sliced into. Distinct from the
 *  LOD zoom tiers (mini/compact/full/native in lod.ts): 'dock' is the sectioned
 *  full faceplate (view = 'dock-full'), which renders ALL controls + pages. The
 *  LOD 'native' tier maps to 'full' or 'dock' at the call site (a P1 concern). */
export type FaceTier = 'mini' | 'compact' | 'full' | 'dock';

/** How many controls each tier surfaces. `dock` = every ranked control. */
export const FACE_TIER_CAPS: Record<FaceTier, number> = {
  mini: 1,
  compact: 3,
  full: 8,
  dock: Infinity,
};

export type FaceControlKind = 'param' | 'family' | 'static';

/** A resolved control from `face.order` — enough for the shell to pick a
 *  primitive (param → Knob/Fader, family → grid/cluster, static → select/
 *  button) and label it, WITHOUT the selector needing the live registry. */
export interface FaceControl {
  /** The raw `face.order` key this descriptor came from. */
  key: string;
  kind: FaceControlKind;
  /** Present iff kind === 'param' — the ParamDef id to bind. */
  paramId?: string;
  /** Present iff kind === 'family' — the declared ControlFamily id. */
  familyId?: string;
  /** Friendly display name (ParamDef.label / humanized family or static key). */
  label: string;
}

/** One resolved dock page — its control keys turned into descriptors. */
export interface ResolvedFacePage {
  id: string;
  label: string;
  controls: FaceControl[];
}

/** The selector's result. `pages` is present only for the 'dock' tier (and only
 *  when the face declares pages). `glyph` is resolved to a concrete value
 *  ('none' when unset). */
export interface CuratedFace {
  tier: FaceTier;
  /** Top-N resolved controls in priority order (all of them for 'dock'). */
  controls: FaceControl[];
  glyph: NonNullable<ModuleFace['glyph']>;
  pages?: ResolvedFacePage[];
}

/** Minimal def shape the selector reads — works for AudioModuleDef,
 *  VideoModuleDef, or a hand-built test fixture. */
export interface FaceDefLike {
  face?: ModuleFace;
  params?: readonly { id: string; label?: string }[];
  controlFamilies?: readonly { id: string }[];
}

const FAMILY_TEMPLATE = /^(.+)-\{n\}$/;

/** Humanize a raw key into a display label: `sub_decay` → 'Sub decay',
 *  `filter-type` → 'Filter type'. */
function humanize(key: string): string {
  const pretty = key.replace(/[-_]/g, ' ').trim();
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

/** Resolve ONE face key to a control descriptor using only the def's params +
 *  declared families (pure). A `<prefix>-{n}` template whose prefix is a
 *  declared family → 'family'; an exact param-id match → 'param'; anything else
 *  → 'static' (a card-only button/select — validated against the legend by the
 *  lint gate, not here). */
export function resolveFaceControl(key: string, def: FaceDefLike): FaceControl {
  const params = def.params ?? [];
  const familyIds = new Set((def.controlFamilies ?? []).map((f) => f.id));

  const fam = key.match(FAMILY_TEMPLATE);
  if (fam && familyIds.has(fam[1])) {
    return { key, kind: 'family', familyId: fam[1], label: humanize(fam[1]) };
  }
  const param = params.find((p) => p.id === key);
  if (param) {
    return { key, kind: 'param', paramId: key, label: param.label || humanize(key) };
  }
  return { key, kind: 'static', label: humanize(key) };
}

function resolvePage(page: ModuleFacePage, def: FaceDefLike): ResolvedFacePage {
  return {
    id: page.id,
    label: page.label,
    controls: page.controls.map((k) => resolveFaceControl(k, def)),
  };
}

/**
 * The curated face for a module at a given tier. Returns `null` for an
 * un-faced module (no `face`) — the caller reads that as "un-migrated" and
 * renders the legacy-fallback placeholder. Otherwise returns the top-N resolved
 * controls (all for 'dock'), the resolved glyph, and — for the 'dock' tier —
 * the resolved pages when the face declares them.
 */
export function curatedFace(def: FaceDefLike, tier: FaceTier): CuratedFace | null {
  const face = def.face;
  if (!face) return null;

  const cap = FACE_TIER_CAPS[tier];
  const ranked = face.order.map((k) => resolveFaceControl(k, def));
  const controls = Number.isFinite(cap) ? ranked.slice(0, cap) : ranked;

  const out: CuratedFace = {
    tier,
    controls,
    glyph: face.glyph ?? 'none',
  };
  if (tier === 'dock' && face.pages && face.pages.length) {
    out.pages = face.pages.map((p) => resolvePage(p, def));
  }
  return out;
}
