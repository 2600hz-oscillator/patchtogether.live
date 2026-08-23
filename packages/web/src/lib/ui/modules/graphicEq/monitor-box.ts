// packages/web/src/lib/ui/modules/graphicEq/monitor-box.ts
//
// THE GRAPHIC EQ MONITOR BOX — the geometry of "hide the controls and watch the
// meters", in ONE place because TWO surfaces need it: `GraphicEqCard.svelte`
// (the legacy lane card) and `./GraphicEqOutputBody.svelte` (the faced dock
// body). Both read `node.data.resizedWidth` / `resizedHeight`, so both need the
// same floors and the same starting size.
//
// ⚠ IT LIVES HERE AND NOT ON THE DEF — the fleet convention since 2026-08-21
// (#2081); `../ruttetra/monitor-box.ts` carries the full argument. Short
// version: the one-source rule (backdraft) decides there is exactly ONE home for
// these numbers; the WebGL attest basis decides WHERE. `scripts/webgl-attest-lib.ts`
// sweeps ALL of `packages/web/src/lib/video` into the basis, so six layout
// numbers on a video def would charge a real-GPU re-attest for values that
// cannot change a rendered GL pixel. A co-located `.ts` under `ui/modules` is
// outside the basis by construction.
//
// ⚠ UNLIKE reshaper's, THIS FACE STILL COSTS AN ATTEST, and the reason is NOT
// this file. `face`, `docs`, `controlFamilies` and `noUserControl` are stripped
// from the basis, and moving these numbers here keeps them out too — but
// `graphicEq.ts` also gains `options` rosters on `style` and `display`, and
// `params` IS in the basis. Keeping the box out here is still worth doing: it
// means a later tweak to the monitor's floors is free, rather than dragging a
// GPU window along with it.
//
// The VALUES are the card's own, MOVED rather than re-chosen — read off
// `GraphicEqCard.svelte` (MIN_WIDTH 360 / MIN_HEIGHT 180 / DEFAULT_WIDTH 360 /
// DEFAULT_HEIGHT 360 / HEADER_PX 56 / PAD_PX 20), so no rack saved before this
// promotion reopens at a different size than it was left at. They happen to
// match reshaper's and ruttetra's; that is a shared lineage in the cards, not a
// number copied from a sibling here.
//
// ⚠ `w`/`h` MEAN DIFFERENT BOXES ON THE TWO SURFACES, deliberately, and the key
// is shared anyway so a rack reopens at the size its author chose. On the CARD
// they size the whole xyflow node and the canvas inside is that minus chrome
// (`headerPx` / `padPx`). On the FACE there is no card chrome and no xyflow node
// to resize, so they size the PICTURE directly.

export const GRAPHIC_EQ_MONITOR_BOX = {
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
