// packages/web/src/lib/ui/workflow/dock-tabs-model.ts
//
// PF-16 — the DOCK TAB plan: when does a curated faceplate stop being ONE
// scrolling column of section bands and become a TAB RAIL, and which band is
// showing?
//
// PURE (no DOM, no registry): it reads only the band list `dockFacePlan`
// already derived, so both surfaces that need the answer — DockFullView, which
// paints the rail, and ModuleShell, which hides the inactive bands — go through
// the SAME function and cannot disagree about whether a face is tabbed. (A rail
// with no matching hide, or a hide with no rail, is a blank faceplate; that is
// precisely the kind of two-sided contract this repo keeps failing on when each
// side computes its own answer.)
//
// ── WHY A THRESHOLD, AND WHY THIS ONE ───────────────────────────────────────
//
// Tabs are not free: they trade "everything at once, scroll for the rest" for
// "one page at a time, click for the rest". A 2-band face loses by that trade,
// so the rail must engage only where the column genuinely cannot be read.
//
// MEASURED off the committed darwin baselines (the VRT dock scene, a 1220px
// pane):
//   * `face-cloudseed-dock.png` — band headers land at y≈202 / 293 / 382, i.e.
//     a ~90px band PITCH, and the content region runs y≈130..425, so ~3.3
//     bands are on screen. cloudseed's EIGHT bands are ~720px of content in a
//     ~295px window.
//   * `face-filter-dock.png` / `face-mixer-dock.png` — 2 bands each, both fully
//     visible with room to spare. Those faces must not change.
//
// The pane's own ceiling is `max-height: min(60vh, 680px)` (DockFullView), and
// the chrome above the bands (grip + title bar + tab rail + hero glyph + the
// editor's padding) costs ~130px — so the TALLEST a dock pane ever gets holds
// ~(680 − 130) / 90 ≈ 6 bands. A face with SEVEN or more therefore cannot be
// read as one column at ANY window height, which is the only condition under
// which the trade is unambiguous.
//
// Lowering this number is a deliberate design decision that MOVES EVERY DOCK
// BASELINE it newly captures — do it in its own PR, with the regen.
//
// ⚠ PF-21 (ROW PACKING) DOES NOT CHANGE THIS THRESHOLD, and the reason is worth
// stating because the arithmetic above now has a second reading. Bands may
// share a ROW (dock-row-plan.ts), so N bands no longer means N × 90 px — but a
// RAILED face never packs (a rail shows one band at a time, so there is no
// "beside" to pack into), and this predicate is evaluated on the BAND count
// before any packing. Re-checked against both current adopters at the packing
// rule: cloudseed's eight bands still pack to SIX rows and pentemelodica's to
// SIX, both far past the ~3.3 the window holds. The rail is still the right
// trade for them, so the number stays where it is.

import type { DockFaceBand } from './curated-face';

/** Measured section-band pitch in the dock faceplate (px). See the header. */
export const DOCK_BAND_PX = 90;

/** Bands at or above which the dock faceplate switches to a TAB RAIL. */
export const DOCK_TAB_MIN_BANDS = 7;

/** One dock tab — a section band, addressed by its band id. */
export interface DockTab {
  /** The `DockFaceBand.id` (a `face.pages` page id, or a defensive band id). */
  id: string;
  /** The rail caption — the band's own label, falling back to its id. */
  label: string;
}

/**
 * The tab roster for a dock plan, or `null` when the face renders as ONE
 * scrolling column (the overwhelming majority — every face below the
 * threshold). `null` is the "no tabs" answer both consumers branch on. Pure.
 */
export function dockTabPlan(bands: readonly DockFaceBand[] | null | undefined): DockTab[] | null {
  if (!bands || bands.length < DOCK_TAB_MIN_BANDS) return null;
  return bands.map((b) => ({ id: b.id, label: b.label || b.id }));
}

/**
 * Resolve the ACTIVE tab id: the requested one when the roster still contains
 * it, else the first tab.
 *
 * The fallback is load-bearing, not defensive noise: the requested id is UI
 * state that outlives a face edit (a re-paged module, a swapped dock occupant),
 * and a stale id with no fallback hides EVERY band — a blank faceplate that
 * reads exactly like a broken module. Pure.
 */
export function activeDockTab(tabs: readonly DockTab[], requested?: string): string {
  if (requested && tabs.some((t) => t.id === requested)) return requested;
  return tabs[0]?.id ?? '';
}

/**
 * Does this band RENDER VISIBLY right now? An untabbed face shows every band;
 * a tabbed one shows the active band only.
 *
 * ⚠ "Not visible" must mean CSS-HIDDEN, never unmounted. The faces-parity gate
 * asserts one `control-<paramId>` per def param and one cell per curated
 * control across the WHOLE faceplate (`evaluateAll`, which matches hidden
 * elements); unmounting the inactive pages would make a tabbed face read as a
 * face that LOST 40 controls. Hiding also keeps knob/scroll/panel state alive
 * across a tab flip. Pure.
 */
export function dockBandVisible(
  bandId: string,
  tabs: readonly DockTab[] | null,
  active?: string,
): boolean {
  if (!tabs) return true;
  return bandId === activeDockTab(tabs, active);
}
