// packages/web/src/lib/ui/modules/wavesculpt/monitor-box.ts
//
// THE WAVESCULPT MONITOR BOX — the geometry of "hide the controls and watch the
// picture".
//
// ⚠ IT IS A `.ts` BESIDE THE SURFACE, AND THAT IS DELIBERATE. The WebGL attest
// basis takes `.svelte` files under `ui/modules` only when they create a WebGL
// context, and skips `.ts` entirely. `WavesculptVizSurface.svelte` IS in the
// basis, so putting six layout numbers in it would make every future tweak to
// them cost a real-GPU re-attest on a shared machine. A co-located `.ts` is
// outside the basis by construction rather than by an exemption anyone has to
// maintain — the same move `ruttetra/monitor-box.ts` records for the same
// reason.
//
// ⚠ THESE KEYS ARE **NOT** THE LEGACY CARD'S SIZE, and the distinction is the
// whole reason this module gets its own box rather than reusing the card's.
// `WavesculptCard.svelte` stores `data.width` / `data.height` and those size
// the WHOLE CARD ELEMENT, at all times, controls visible. MONITOR mode means
// something different — "the size while the controls are HIDDEN" — so it rides
// `data.resizedWidth` / `data.resizedHeight`, the keys ruttetra established for
// exactly that meaning.
//
// MEASURED, not assumed (the build spec's §10.4 must-verify): `grep` for
// `resizedWidth` / `resizedHeight` across `WavesculptCard.svelte` returns
// NOTHING, and the card's only size writes are `target.data.width` /
// `target.data.height`. The two pairs are independent, so this surface can own
// its pair outright and turning monitor mode off cannot resize the legacy card.
//
// ⚠ AND THAT INDEPENDENCE IS WHY WE DIVERGE FROM RUTTETRA ON ONE POINT.
// `RuttetraOutputBody` DELETES `resizedWidth`/`resizedHeight` when monitor mode
// turns off, because ruttetra's CARD reads the same two keys and the two
// surfaces would otherwise disagree about whether a size is stored. Wavesculpt
// has no such second reader, so the size is KEPT: reopening the monitor returns
// it to the size its author chose, which is the friendlier behaviour and is
// available to us precisely because nothing else is looking at these keys.

export const WAVESCULPT_MONITOR_BOX = {
  /** Floors, rounded to whole-u (180 px) rack tiles (#759). */
  minW: 360,
  minH: 270,
  /**
   * The size MONITOR mode opens at before anyone drags the corner. 4:3, which
   * is the renderer's own aspect (RES_W 320 x RES_H 240) — opening at any other
   * ratio would letterbox on the first frame and invite a drag that only
   * corrects the surface's own default.
   */
  defW: 640,
  defH: 480,
} as const;

/** The picture's size at REST — controls visible, monitor mode off. Kept beside
 *  the monitor floors so the two cannot drift into disagreeing about which box
 *  is bigger, which is the only relationship between them that matters. */
export const WAVESCULPT_RESTING = { w: 400, h: 300 } as const;
