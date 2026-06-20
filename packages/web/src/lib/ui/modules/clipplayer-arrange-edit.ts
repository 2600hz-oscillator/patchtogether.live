// clipplayer-arrange-edit.ts — store-aware edit helpers for the CLIP PLAYER
// arrangement, shared by the in-card timeline AND the full-window pop-out
// editor so the Yjs in-place mutation discipline lives in ONE place. (Mirrors
// mappy-edit.ts.)
//
// Yjs RULE (repo memory yjs-save-load-real-ydoc + cv-modulation-live-store-
// write-storm): the arrangement is a synced Y.Doc field at node.data.arrangement.
// ALL edits go through ONE transactional write (writeArrange → ydoc.transact).
// During a DRAG we keep LOCAL render state for the live preview and commit ONE
// moveBlock write on DROP — never a write per pointermove.

import { patch, ydoc } from '$lib/graph/store';
import {
  coerceArrangeData,
  moveBlock,
  setBlockSlot,
  deleteBlock,
  setArrangeLength,
  snapBeat,
  type ArrangeData,
} from '$lib/audio/modules/clip-arrange';
import type { ClipPlayerData } from '$lib/audio/modules/clip-types';

/** ONE transactional ydoc write that maps the live arrangement through `mut`.
 *  Seeds node.data + coerces the (possibly absent/garbage) arrangement, then
 *  assigns the mutated plain result back as a single field write. */
export function writeArrange(id: string, mut: (a: ArrangeData) => ArrangeData): void {
  const t = patch.nodes[id];
  if (!t) return;
  ydoc.transact(() => {
    if (!t.data) t.data = {};
    const d = t.data as ClipPlayerData;
    d.arrangement = mut(coerceArrangeData(d.arrangement));
  });
}

/** px-x within the timeline → song-beat (clamped to [0, lengthBeats]). */
export function xToBeat(x: number, widthPx: number, lengthBeats: number): number {
  if (widthPx <= 0 || lengthBeats <= 0) return 0;
  return Math.min(lengthBeats, Math.max(0, (x / widthPx) * lengthBeats));
}

/** Commit a drag: retime lane's block from `fromBeat` to a snapped `toBeat`.
 *  Skips the write entirely when the snapped target equals the source beat (a
 *  pure click / no-move drop), so a tap never burns a ydoc transaction. */
export function commitMove(
  id: string,
  lane: number,
  fromBeat: number,
  toBeat: number,
  snapTo: number,
): void {
  const snapped = snapBeat(toBeat, snapTo);
  if (Math.abs(snapped - fromBeat) < 1e-6) return; // no-op, skip the write
  writeArrange(id, (a) => moveBlock(a, lane, fromBeat, snapped));
}

// re-export the existing pure ops so card + editor import from one place.
export { moveBlock, setBlockSlot, deleteBlock, setArrangeLength, snapBeat };
