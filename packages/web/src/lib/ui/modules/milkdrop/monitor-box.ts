// packages/web/src/lib/ui/modules/milkdrop/monitor-box.ts
//
// THE MILKDROP MONITOR BOX — the geometry of "hide the controls and watch the
// picture", in ONE place because TWO surfaces need it: `MilkdropCard.svelte`
// (the legacy lane card) and `./MilkdropOutputBody.svelte` (the faced dock
// body). Both read `node.data.resizedWidth` / `resizedHeight`, so both need the
// same floors and the same starting size.
//
// ⚠ SAME HOME AND SAME ARGUMENT AS `../ruttetra/monitor-box.ts`, which carries
// the full writeup. The short version: the one-source rule (backdraft) decides
// that there is exactly ONE module; the WebGL attest basis decides WHERE it
// lives. `lib/video/**` is swept into the basis wholesale, so six layout numbers
// on a video def turned every monitor-box edit into a real-GPU re-attest — for
// values that cannot change a rendered GL pixel. A co-located `.ts` under
// `ui/modules` is outside the basis by construction (the sweep takes `.svelte`
// files that create a GL context, and skips `.ts` outright).
//
// ⚠ ONE SPELLING, FLEET-WIDE. Both adopters of MONITOR MODE were relocated in
// the same commit precisely so a reader never meets two conventions and has to
// guess which is current — the failure this file's own history is an example of.
//
// The VALUES are the card's own, moved rather than re-chosen (#759: floors
// rounded to whole-u 180 px rack tiles), so no rack saved before the promotion
// reopens at a different size than it was left at.
//
// ⚠ `w`/`h` MEAN DIFFERENT BOXES ON THE TWO SURFACES, deliberately, and the key
// is shared anyway so a rack reopens at the size its author chose. On the CARD
// they size the whole xyflow node, and the canvas inside is that minus chrome
// (`headerPx` / `padPx`). On the FACE there is no card chrome and no xyflow node
// to resize, so they size the PICTURE directly.

export const MILKDROP_MONITOR_BOX = {
  /** Floors, rounded to whole-u (180 px) rack tiles (#759). */
  minW: 360,
  minH: 180,
  /** The size MONITOR mode opens at before anyone drags the corner. */
  defW: 360,
  defH: 360,
  /** CARD-ONLY chrome the canvas is inset by; the faced body has neither. */
  headerPx: 56,
  padPx: 20,
} as const;
