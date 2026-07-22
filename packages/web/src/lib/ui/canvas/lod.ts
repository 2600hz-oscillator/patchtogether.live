// packages/web/src/lib/ui/canvas/lod.ts
//
// STRATA — the PURE semantic-zoom (LOD) tier function for the workflow-mode
// rack surface. Given the live viewport `zoom`, it returns the CONTENT tier the
// ModuleShell should render (mini → compact → full-in-lane → dock), NOT a CSS
// scale. xyflow scales flow-space DOM by the zoom for free; STRATA swaps which
// CONTENT is drawn as you cross zoom bands (§3.3/§3.4 of the UI-refactor plan).
//
// The returned `Tier` is DELIBERATELY the same string union as the curation
// ladder's `FaceTier` (workflow/curated-face.ts): the zoom tier feeds
// `curatedFace(def, tier)` directly, so the top band is named 'dock' (the
// sectioned full faceplate — the plan's NATIVE band, z ≥ 0.95) rather than a
// separate 'native'. Keeping the names identical means the LOD output is a
// drop-in `FaceTier` at the P0.3 call site with no re-mapping.
//
// PURE + import-free by design: no fs, no registry, no Svelte — trivially
// unit-testable and zero-flake (lod.test.ts). The reactive plumbing (the shared
// zoom store + the derived tier context) lives in workflow-zoom.ts, which wraps
// this function; nothing here touches the DOM or a store.

/** The LOD content tiers, poorest → richest. Structurally identical to
 *  `FaceTier` in $lib/ui/workflow/curated-face — the LOD engine emits exactly
 *  the tier `curatedFace` consumes. */
export type Tier = 'mini' | 'compact' | 'full' | 'dock';

/** Tiers in ascending richness — the canonical order for index comparisons. */
export const TIER_ORDER: readonly Tier[] = ['mini', 'compact', 'full', 'dock'];

/**
 * INCLUSIVE lower zoom bound of each tier (the §3.4 thresholds 0.30 / 0.52 /
 * 0.95). `mini` is the floor and has no lower bound. A tier owns `[LOWER[t],
 * LOWER[next]) `. These are the NOMINAL boundaries; `lodTier` applies the
 * ±`TIER_HYSTERESIS` deadband around them when a `prevTier` is threaded through.
 */
export const TIER_LOWER: Record<Tier, number> = {
  mini: -Infinity,
  compact: 0.3,
  full: 0.52,
  dock: 0.95,
};

/** Symmetric deadband (± this) around every boundary. A pinch parked ON a
 *  threshold must move at least this far past it to flip the content tier, so a
 *  per-frame `onmove` at the boundary can't thrash the DOM swap 60×/s. */
export const TIER_HYSTERESIS = 0.02;

/** The NOMINAL tier for a zoom, ignoring hysteresis: the richest tier whose
 *  inclusive lower bound is ≤ z. Monotonic non-decreasing in z. */
function nominalTier(z: number): Tier {
  let out: Tier = 'mini';
  for (const t of TIER_ORDER) {
    if (z >= TIER_LOWER[t]) out = t;
  }
  return out;
}

/**
 * The LOD tier for a viewport `zoom`, with boundary hysteresis.
 *
 * Without `prevTier` (first evaluation) it returns the nominal band. With a
 * `prevTier`, the tier is STICKY within a ±`TIER_HYSTERESIS` deadband so a zoom
 * dithering on a boundary keeps the current tier instead of oscillating:
 *   - to move UP a tier, `zoom` must clear the next boundary by +hysteresis;
 *   - to move DOWN, `zoom` must fall below the current tier's own lower bound by
 *     −hysteresis.
 * A zoom that jumps well past several boundaries snaps straight to the nominal
 * tier (hysteresis only bites at a boundary you're parked on).
 *
 * PURE: same inputs → same output, no side effects.
 */
export function lodTier(zoom: number, prevTier?: Tier): Tier {
  // Non-finite zoom (never expected from xyflow) collapses to the richest tier.
  const z = Number.isFinite(zoom) ? zoom : 1;
  const nominal = nominalTier(z);

  if (prevTier === undefined) return nominal;
  const prevIdx = TIER_ORDER.indexOf(prevTier);
  if (prevIdx < 0) return nominal; // defensive: unknown prevTier → nominal
  const nomIdx = TIER_ORDER.indexOf(nominal);
  if (nomIdx === prevIdx) return prevTier;

  if (nomIdx > prevIdx) {
    // Zoom wants a richer tier: only leave prev once we clear the immediate
    // upper boundary + hysteresis; then snap to the (possibly multi-step) nominal.
    const upperBoundary = TIER_LOWER[TIER_ORDER[prevIdx + 1]];
    return z >= upperBoundary + TIER_HYSTERESIS ? nominal : prevTier;
  }
  // Zoom wants a poorer tier: only leave prev once we drop below prev's own
  // lower boundary − hysteresis; then snap to the nominal.
  return z < TIER_LOWER[prevTier] - TIER_HYSTERESIS ? nominal : prevTier;
}
