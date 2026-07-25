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

/**
 * The uniform RACKLINE lane-tile WIDTH (px) EVERY shell/placeholder tile renders
 * at under the `?shell=1` preview — the owner "same-size all modules HORIZONTALLY"
 * premise. The mock's exact 192px tile (ux-proposal-b.html:598 "uniform 192×180
 * tile"). Shared by the CSS (`_module-card.css` pins the tile `width` to
 * `var(--shell-tile-w)`) and by Canvas's `wcolCardWidthPx` short-circuit, so the
 * RESERVED column slot equals the RENDERED tile → the band-centering (card center
 * == channel-number center) stays exact. Mirrors the `--shell-tile-w` token
 * (tokens.css); a unit gate locks them together.
 *
 * NOTE the tile is CENTERED in the app's 765px (34hp) channel-column band, so it
 * sits with wide gutters rather than filling the lane the way the mock's narrow
 * 216px lane does — the column pitch is app-scale and shared with the persisted
 * video-zone spawn geometry, so narrowing it is a separate (non-preview-gated)
 * follow-up. Uniformity + the mock tile dimensions are what this pass locks. */
export const SHELL_TILE_W = 192;

/**
 * The RACKLINE lane-slot HEIGHT (px) — ONE FIXED height at EVERY LOD tier (the
 * owner zoom-reposition fix, roundup option (c)). The OUTER slot box never
 * changes with zoom: only the CONTENT INSIDE the tile varies per tier (mini =
 * name + glyph centred in the fixed box; compact = the body knob row; full = the
 * denser face). A per-tier box height made flush-stack Y positions cascade-shift
 * whenever the zoom crossed a tier boundary; a tier-invariant slot means the
 * flow POSITIONS are byte-identical at every zoom. Pinned to the compact/full
 * design height — the mock's 180px .mod/.plate tile (ux-proposal-b.html).
 * Shared by the CSS (`_module-card.css` pins the tile box to `--shell-tile-h`,
 * tier-invariant) and by Canvas's `wcolCardHeightPx` (returns this SAME constant
 * at every zoom under the preview, so the RESERVED lane slot == the rendered
 * tile and the baseline number badge caps every tile flush). Mirrors the
 * `--shell-tile-h` token (tokens.css); a unit gate locks CSS↔TS. */
export const SHELL_TILE_H_SLOT = 180;

/** Back-compat alias for the fixed slot height (historical `SHELL_TILE_H` name). */
export const SHELL_TILE_H = SHELL_TILE_H_SLOT;

/**
 * Flow-space Y inset (px) applied to a VIDEO-ZONE default tile's TOP under the
 * `?shell=1` preview so the whole tile sits INSIDE the darker video area instead
 * of straddling its top edge. The zone's dashed border + "VIDEO" label are drawn
 * AT `COLUMN_BASELINE_Y` (`videoAreaBand` y0 == the tile's un-inset top), so a
 * tile anchored flush at the baseline puts its top jack-rail on the dashed line
 * and collides with the lane-number badges just above it. Nudging the tile down
 * by this inset clears the label + border with room to spare (the fixed slot is
 * SHELL_TILE_H_SLOT = 180, and 48 + 180 << the 540px video area). Applied ONLY in
 * the Canvas render override under the preview — the pure `videoZoneSlotPos`
 * default (used by the persisted spawn geometry) is UNCHANGED, so preview-OFF is
 * byte-identical and no Y.Doc position moves. */
export const SHELL_VIDEO_ZONE_TILE_INSET_Y = 48;

/** The minimal def shape the shell/placeholder model reads. */
export interface ShellDefLike {
  domain?: string;
  inputs?: readonly { id: string; type: string }[];
  outputs?: readonly { id: string; type: string }[];
  /** The def's concise role string ('modulation' / 'effects' / 'sources' …) —
   *  every Audio/Video/MetaModuleDef carries one. */
  category?: string;
  /** The def's palette classification (top/sub) — the role-line fallback. */
  palette?: { top: string; sub: string };
}

/** The five signal DOMAINS the RACKLINE kit colours chrome by (spine, jack dots,
 *  faceplate accent). */
export type SignalDomain = 'audio' | 'cv' | 'gate' | 'video' | 'poly';

/** Map a live CABLE type to its signal DOMAIN class (the kit's .audio/.cv/.gate/
 *  .video/.poly setters). Secondary cable types fold into their parent domain
 *  (pitch→cv, keys→poly, image/mono-video→video). Unknown → audio. Pure. */
export function domainClassForCable(cable: string | undefined): SignalDomain {
  switch (cable) {
    case 'gate':
      return 'gate';
    case 'cv':
    case 'pitch':
      return 'cv';
    case 'polyPitchGate':
    case 'keys':
      return 'poly';
    case 'video':
    case 'image':
    case 'mono-video':
      return 'video';
    case 'audio':
    default:
      return 'audio';
  }
}

/** The module's signal DOMAIN class — derived from its primary cable type (the
 *  same hue its spine is painted). Consumed by DockFullView to add the kit
 *  domain setter class to the `.faceplate` root. Pure. */
export function domainClassForDef(def: ShellDefLike | undefined): SignalDomain {
  return domainClassForCable(cableTypeForDef(def));
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

/**
 * The MIGRATED tile's header ROLE line — what the badge row says instead of
 * repeating the type (the name row already identifies the module; "VCA / vca"
 * was redundant). Uses the def's own concise metadata, no new field: the
 * `category` role string ('modulation', 'effects', 'sources', 'utilities' …),
 * falling back to the palette sub-category ('Utility', 'VCOs', …). Returns
 * undefined for a def with neither — the caller keeps its current fallback
 * (the type). The un-migrated placeholder is NOT routed through this: it keeps
 * showing the raw type. Pure.
 */
export function roleLineForDef(def: ShellDefLike | undefined): string | undefined {
  const category = def?.category?.trim();
  if (category) return category;
  const sub = def?.palette?.sub?.trim();
  if (sub) return sub;
  return undefined;
}

// ── The LANE BODY PLAN — the no-clip guarantee ──────────────────────────────
//
// The RACKLINE lane tile is a FIXED 192×180 box (zoom no-op invariant), so how
// many WHOLE control cells fit is a design-time constant, not a runtime
// measurement. The plan renders ONLY whole cells — a ranked control (or the
// glyph) that cannot fit entirely inside the tile is simply not rendered
// in-lane (the dock faceplate always shows everything). Derivation, from the
// tile vocabulary (_rackline-tile.css):
//
//   body inner width = 192 − 11 (left pad) − 9 (right pad) = 172px
//   ROW  (mini/compact + small full faces): md knob columns capped at 46px
//     (--kcol-max), 9px gaps, glyph min 40px (the mock .tile-scope floor):
//       with glyph: n·46 + n·9 + 40 ≤ 172 → n ≤ 2  (glyph then FILLS the rest)
//       no glyph:   n·46 + (n−1)·9 ≤ 172 → n ≤ 3
//   PLATE (the 'full' tier when the row can't hold the face): the mock full
//     'plate' 3-col grid of sm knob cells, 42px rows (26 knob + 5 gap + 11
//     label), 4px row gaps in a ~112px body → 2 whole rows = 6 cells max; the
//     full-width glyph strip renders only when a whole 42px strip still fits
//     (i.e. the cells needed ≤ one row).
export const LANE_ROW_MAX_CELLS_WITH_GLYPH = 2;
export const LANE_ROW_MAX_CELLS = 3;
export const PLATE_COLS = 3;
export const PLATE_MAX_ROWS = 2;

export interface LaneBodyPlan {
  /** 'row' = the mock .mod inline body; 'plate' = the full-tier 3-col grid. */
  layout: 'row' | 'plate';
  /** How many ranked controls render in-lane (a prefix of the curated list). */
  cellCount: number;
  /** Whether the glyph renders in-lane at this tier. */
  glyph: boolean;
  /** Knob size for the rendered cells (mini's lg override stays a view concern). */
  knobSize: 'sm' | 'md';
}

/**
 * The lane body plan for a curated face: which layout, how many WHOLE cells,
 * and whether the glyph fits. `controlCount` is the tier-curated control count
 * (curatedFace().controls.length); `hasGlyph` = face.glyph !== 'none'. Pure —
 * geometry constants only, so the guarantee is unit-testable. The 'dock' tier
 * never reaches this (the dock faceplate renders pages / wraps freely).
 */
export function laneBodyPlan(controlCount: number, hasGlyph: boolean, tier: FaceTier): LaneBodyPlan {
  const rowMax = hasGlyph ? LANE_ROW_MAX_CELLS_WITH_GLYPH : LANE_ROW_MAX_CELLS;
  if (tier === 'mini') {
    return { layout: 'row', cellCount: Math.min(controlCount, 1), glyph: hasGlyph, knobSize: 'md' };
  }
  if (tier === 'compact' || controlCount <= rowMax) {
    // The design-point row: whole md cells + the glyph filling the remainder.
    return { layout: 'row', cellCount: Math.min(controlCount, rowMax), glyph: hasGlyph, knobSize: 'md' };
  }
  // 'full' with a face too big for the row → the 3-col plate grid, whole rows
  // only. Ranked controls outrank the glyph: the strip renders only when the
  // cells need just one row, leaving a whole strip-row free.
  const cellCount = Math.min(controlCount, PLATE_COLS * PLATE_MAX_ROWS);
  const rows = Math.ceil(cellCount / PLATE_COLS);
  return { layout: 'plate', cellCount, glyph: hasGlyph && rows <= 1, knobSize: 'sm' };
}
