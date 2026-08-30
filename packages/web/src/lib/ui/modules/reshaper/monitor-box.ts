// packages/web/src/lib/ui/modules/reshaper/monitor-box.ts
//
// THE RESHAPER MONITOR BOX — the geometry of "hide the controls and watch the
// picture", in ONE place because TWO surfaces need it: `ReshaperCard.svelte`
// (the legacy lane card) and `./ReshaperOutputBody.svelte` (the faced dock
// body). Both read `node.data.resizedWidth` / `resizedHeight`, so both need the
// same floors and the same starting size.
//
// ⚠ IT LIVES HERE AND NOT ON THE DEF — the fleet convention since 2026-08-21
// (#2081), and `../ruttetra/monitor-box.ts` carries the full argument. Short
// version: the one-source rule (backdraft) decides that there is exactly ONE
// module for these numbers; the WebGL attest basis decides WHERE it lives.
// `scripts/webgl-attest-lib.ts` sweeps ALL of `packages/web/src/lib/video` into
// the basis, so six layout numbers on a video def would charge a real-GPU
// re-attest for values that cannot change a rendered GL pixel. A co-located
// `.ts` under `ui/modules` is outside the basis by construction — the sweep
// takes `.svelte` files that create a GL context and skips `.ts` outright.
//
// Because of that, this whole face costs ZERO attest: `face`, `docs`,
// `controlFamilies` and `noUserControl` are stripped by
// `scripts/attest-code-basis.ts`, and nothing else in `reshaper.ts` changes.
//
// The VALUES are the card's own, moved rather than re-chosen (#759: floors
// rounded to whole-u 180 px rack tiles), so no rack saved before this promotion
// reopens at a different size than it was left at.
//
// ⚠ `w`/`h` MEAN DIFFERENT BOXES ON THE TWO SURFACES, deliberately, and the key
// is shared anyway so a rack reopens at the size its author chose. On the CARD
// they size the whole xyflow node, and the canvas inside is that minus chrome
// (`headerPx` / `padPx`). On the FACE there is no card chrome and no xyflow node
// to resize, so they size the PICTURE directly.

export const RESHAPER_MONITOR_BOX = {
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
