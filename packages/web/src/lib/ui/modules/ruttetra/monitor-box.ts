// packages/web/src/lib/ui/modules/ruttetra/monitor-box.ts
//
// THE RUTTETRA MONITOR BOX — the geometry of "hide the controls and watch the
// picture", in ONE place because TWO surfaces need it: `RuttetraCard.svelte`
// (the legacy lane card) and `./RuttetraOutputBody.svelte` (the faced dock
// body). Both read `node.data.resizedWidth` / `resizedHeight`, so both need the
// same floors and the same starting size.
//
// ⚠ IT LIVES HERE AND NOT ON THE DEF, AND THE REASON IS THE WEBGL ATTEST.
// It shipped on `ruttetra.ts` (#2053) for the backdraft reason — a constant
// re-typed on two surfaces is a constant that will disagree on one of them, and
// nothing at runtime can see the disagreement because each surface is
// self-consistent. That argument is untouched and is why this is still ONE
// module. What changed is WHERE the one module lives.
//
// `scripts/webgl-attest-lib.ts` sweeps ALL of `packages/web/src/lib/video` into
// the attest basis, so six layout numbers sitting on a video def made every
// monitor-box edit a REAL-GPU RE-ATTEST on a shared machine. MEASURED on the
// monoglitch branch (#2078's sibling finding): normalising the def before and
// after showed the ONLY hash contribution from that whole face was the eight
// lines of this constant — the 150-line `face` block and the docs rewrite are
// stripped by `attest-code-basis.ts` and cost nothing. So the window was buying
// re-certification of numbers that cannot change a rendered GL pixel.
//
// The basis takes `.svelte` files under `ui/modules` only when they create a
// WebGL context, and skips `.ts` entirely (`webgl-attest-lib.ts`: `if
// (!f.endsWith('.svelte')) continue;`). A co-located `.ts` module is therefore
// outside the basis by construction, not by an exemption someone has to
// maintain.
//
// ⚠ AND THE DEF WAS NEVER UNIQUELY QUALIFIED. Its stated claim was "the one
// place neither surface has to import the other to reach" — but this directory
// is equally such a place, and it is the one BOTH consumers already live in or
// beside. The def does not use these numbers; it only re-exported them.
//
// ⚠ `w`/`h` MEAN DIFFERENT BOXES ON THE TWO SURFACES, deliberately, and the key
// is shared anyway so a rack reopens at the size its author chose. On the CARD
// they size the whole xyflow node, and the canvas inside is that minus chrome
// (`headerPx` / `padPx`). On the FACE there is no card chrome and no xyflow node
// to resize, so they size the PICTURE directly — the same meaning shift
// `bentbox` and `videoOut` both document for their own resize keys.

export const RUTTETRA_MONITOR_BOX = {
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
