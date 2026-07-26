// packages/web/src/lib/ui/workflow/curated-face.ts
//
// The PURE top-N selector for the workflow-mode ModuleShell's semantic-zoom
// (STRATA) tiers. Given a module def's co-located `face` (see ModuleFace in
// $lib/graph/types) and a curation TIER, it resolves each ranked control key to
// a lightweight descriptor and returns the first N controls for that tier:
//
//   mini    → 1   (the hero control + live glyph)
//   compact → 2 with a glyph / 3 without  (the design-point lane tile — the
//                 cap RECONCILED with laneBodyPlan's fit, see faceTierCap)
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
import { LANE_ROW_MAX_CELLS, LANE_ROW_MAX_CELLS_WITH_GLYPH } from './module-shell-model';

/** The curation LADDER — the tiers a face is sliced into. Distinct from the
 *  LOD zoom tiers (mini/compact/full/native in lod.ts): 'dock' is the sectioned
 *  full faceplate (view = 'dock-full'), which renders ALL controls + pages. The
 *  LOD 'native' tier maps to 'full' or 'dock' at the call site (a P1 concern). */
export type FaceTier = 'mini' | 'compact' | 'full' | 'dock';

/**
 * How many controls each tier surfaces. `dock` = every ranked control.
 *
 * `compact` is the GLYPH-LESS ceiling. The compact tile is the one tier whose
 * cap is decided by GEOMETRY rather than by the curation ladder: the fixed
 * 192×180 lane tile fits three whole md knob columns, or TWO plus the glyph
 * (laneBodyPlan's LANE_ROW_MAX_CELLS / LANE_ROW_MAX_CELLS_WITH_GLYPH). Use
 * `faceTierCap(tier, hasGlyph)` — never `FACE_TIER_CAPS.compact` directly — so
 * the SELECTED count and the RENDERED count are the same number by
 * construction (the authored-intent mismatch: faces documented a 3-control
 * compact tile the shell then truncated to 2, silently).
 */
export const FACE_TIER_CAPS: Record<FaceTier, number> = {
  mini: 1,
  compact: LANE_ROW_MAX_CELLS,
  full: 8,
  dock: Infinity,
};

/**
 * The EFFECTIVE cap for a tier — the ladder, reconciled with the lane fit plan
 * at 'compact': a glyph-bearing face surfaces two cells there (the glyph takes
 * the third column's room), a glyph-less face three. Every other tier is the
 * plain ladder value. Pure.
 */
export function faceTierCap(tier: FaceTier, hasGlyph: boolean): number {
  if (tier === 'compact') return hasGlyph ? LANE_ROW_MAX_CELLS_WITH_GLYPH : LANE_ROW_MAX_CELLS;
  return FACE_TIER_CAPS[tier];
}

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
  controlFamilies?: readonly { id: string; label?: string }[];
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
  const families = def.controlFamilies ?? [];

  const fam = key.match(FAMILY_TEMPLATE);
  if (fam) {
    // The DECLARED family label is the authored name ('Preset / voice
    // selector'); humanizing the id would print the raw key back at the user
    // ('Dx7 preset select'). Fall back to humanize only for a family with no
    // label (the type makes it optional for hand-built fixtures).
    const declared = families.find((f) => f.id === fam[1]);
    if (declared) {
      return {
        key,
        kind: 'family',
        familyId: fam[1],
        label: declared.label?.trim() || humanize(fam[1]),
      };
    }
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

  const glyph = face.glyph ?? 'none';
  const cap = faceTierCap(tier, glyph !== 'none');
  const ranked = face.order.map((k) => resolveFaceControl(k, def));
  const controls = Number.isFinite(cap) ? ranked.slice(0, cap) : ranked;

  const out: CuratedFace = {
    tier,
    controls,
    glyph,
  };
  if (tier === 'dock' && face.pages && face.pages.length) {
    out.pages = face.pages.map((p) => resolvePage(p, def));
  }
  return out;
}

// ── The DOCK RENDER PLAN — the "dock shows ALL" seam, made pure ─────────────
//
// ModuleShell's dock full-view renders EXACTLY this plan (one labeled section
// band per declared page + the defensive '__unpaged' tail band for any ranked
// control no page claimed; a page-less face renders one unlabeled '__all'
// band). Extracting the derivation makes the CONTROL-LOSS guarantee unit-
// testable WITHOUT a browser: the render-parity gate asserts the flattened
// plan covers every param + declared control family EXACTLY once (the tidyVco
// tune/fine loss class — a control that exists in the schema but silently
// never renders). The e2e faces-parity spec is the authoritative DOM-level
// twin of this seam.

/** The '__unpaged' defensive tail band id + the page-less '__all' band id. */
export const DOCK_UNPAGED_BAND_ID = '__unpaged';
export const DOCK_ALL_BAND_ID = '__all';

/** One dock section band: a declared face page, the '__unpaged' tail, or the
 *  page-less '__all' roster. `label` may be '' (rendered without a header). */
export interface DockFaceBand {
  id: string;
  label: string;
  controls: FaceControl[];
}

/**
 * The dock full-view SECTION-BAND plan for a module face — the exact bands
 * ModuleShell renders at view='dock-full'. Returns `null` for an un-faced def
 * (the caller falls back to the legacy card). INVARIANT (gated by
 * module-face-lint's render-parity test): the flattened plan contains every
 * `face.order` key exactly once — pages claim their keys, the tail sweeps the
 * rest, so nothing ranked can silently drop out of the dock.
 */
export function dockFacePlan(def: FaceDefLike): DockFaceBand[] | null {
  const dock = curatedFace(def, 'dock');
  if (!dock) return null;

  const pages = dock.pages ?? [];
  if (!pages.length) {
    return [{ id: DOCK_ALL_BAND_ID, label: '', controls: dock.controls }];
  }

  const bands: DockFaceBand[] = pages.map((p) => ({ id: p.id, label: p.label, controls: p.controls }));
  const claimed = new Set(pages.flatMap((p) => p.controls.map((c) => c.key)));
  const unpaged = dock.controls.filter((c) => !claimed.has(c.key));
  if (unpaged.length) {
    bands.push({ id: DOCK_UNPAGED_BAND_ID, label: 'more', controls: unpaged });
  }
  return bands;
}
