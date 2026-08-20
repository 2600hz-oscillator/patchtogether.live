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

// ── THE PER-FACE OPT-IN (`face.tabbed`) — AND ITS FENCE ─────────────────────
//
// A face may force the rail on regardless of band count. ⚠ THIS IS NOT A
// SECOND WAY TO ASK THE THRESHOLD QUESTION, and the fence is the whole point:
//
//   * IT IS DECLARED ONLY ON EXPLICIT OWNER INSTRUCTION, PER MODULE. Not
//     "this face feels crowded", not "three pages read better as tabs".
//   * THE DEFAULT STANDS UNCHANGED: author honest pages, and the rail engages
//     at `DOCK_TAB_MIN_BANDS`. A 3-6 page face renders as one column and that
//     is CORRECT — the owner separately ruled `ruttetra` ships UNTABBED
//     ("2 - a"), so this opt-in does not reopen that question for it or for
//     any other face.
//   * EVERY ADOPTER IS NAMED, WITH PROVENANCE. `FACE_TAB_OPT_IN` in
//     `dock-tabs-model.test.ts` carries the owner instruction VERBATIM per
//     module; a declaration with no entry is RED and an entry whose module no
//     longer declares is RED. An agent cannot quietly opt a face in, which is
//     the failure mode that matters here — a plausible-sounding "the owner
//     wanted tabs" is exactly the fabrication class this repo has already been
//     bitten by, so the instruction has to be written down next to the licence.
//
// WHY AN OPT-IN RATHER THAN LOWERING THE THRESHOLD. Lowering
// `DOCK_TAB_MIN_BANDS` re-pins EVERY dock baseline it newly captures (68 faces
// today) and changes how every 3-6 page face reads, to solve one module's
// structure. The opt-in moves exactly the face that declares it and leaves the
// measured argument above intact.
//
// WHY spirographs EARNS IT, stated so the next reader can judge the precedent:
// its three spiros are INDEPENDENT FIGURES, not three sections of one idea —
// its own legacy card shipped a `role="tablist"` with a `1 / 2 / 3` selector
// and edited one spiro at a time. The rail here restores a structure the module
// already had, rather than compressing a column that was merely tall.

import type { DockFaceBand } from './curated-face';
import type { ShellView } from './module-shell-model';

/** The slice of a def this model reads: the per-face tab opt-in. */
export interface TabDefLike {
  face?: { tabbed?: boolean };
}

/** Does this def force the rail on? ONE authority, read by all three consumers
 *  (DockFullView's rail, ModuleShell's hide, dock-row-plan's packing) so they
 *  cannot disagree — a rail with no matching hide is a blank faceplate. */
export function faceForcesTabs(def: TabDefLike | undefined): boolean {
  return def?.face?.tabbed === true;
}

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
 *
 * ⚠ `view` IS PART OF THE ANSWER, NOT A FILTER THE CALLER APPLIES (#1739). The
 * file header's whole argument is that a RAIL WITH NO MATCHING HIDE, OR A HIDE
 * WITH NO RAIL, IS A BLANK FACEPLATE — which is exactly what the pinned `m`
 * tray would be. `DockCardHost` has no title bar and paints no tab rail, so a
 * `'drawer'` face is NEVER tabbed however many bands it has: it renders as the
 * one scrolling column its host can actually scroll (`.dock-rail-cards` is
 * `overflow:auto`, and the drawer is drag-resizable). Answering it here rather
 * than at the shell's hide site is the same single-authority argument the
 * header already makes for the two full-view consumers.
 *
 * Today's pinned occupant (mixmstrs, 4 bands) is under the threshold either
 * way, so this is currently a NO-OP on the live roster — which is why
 * `dock-tabs-model.test.ts` drives the drawer arm at a band count ABOVE the
 * threshold, where the two answers actually differ.
 */
export function dockTabPlan(
  bands: readonly DockFaceBand[] | null | undefined,
  view: ShellView = 'dock-full',
  def?: TabDefLike,
): DockTab[] | null {
  if (view === 'drawer') return null;
  if (!bands || !bands.length) return null;
  // ⚠ THE OPT-IN IS CHECKED AFTER THE `drawer` ARM, DELIBERATELY. The pinned
  // tray paints no rail at all, so a forced-tabs face there would be a hide
  // with no rail — the blank faceplate this file exists to prevent. The opt-in
  // overrides the THRESHOLD, never the host's ability to show a rail.
  if (!faceForcesTabs(def) && bands.length < DOCK_TAB_MIN_BANDS) return null;
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
