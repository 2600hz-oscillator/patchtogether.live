// crop-edit.ts — store-aware crop-rectangle edit helpers, shared by any card
// that exposes a Crop output (VIDEOVARISPEED first). Keeps the Yjs in-place
// mutation discipline in ONE testable place (crop-edit-ydoc.test.ts). Mirrors
// mappy-edit.ts.
//
// Yjs RULE (see control-surface #566 / [[yjs-save-load-real-ydoc]]): NEVER
// spread/re-insert a live Y child. node.data.crop is a small flat record, so we
// write a fresh PLAIN object into the Y map on every edit — the same safe shape
// as writeFileMeta / writeSlotMeta. The crop is a SEPARATE node.data key from
// slotMeta, so slot save/switch/clear ops (which rebuild only node.data.slotMeta)
// never touch it — ONE crop per node, per-node not per-slot.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { coerceCrop, type CropRect, type CropState } from '$lib/video/crop-core';

/** Persist node.data.crop as a fresh plain object (in-place Y-map discipline).
 *  `active` false ⇒ the Crop output passes the full frame through. */
export function writeCrop(id: string, active: boolean, rect: CropRect): void {
  ydoc.transact(() => {
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    (t.data as { crop?: { active: boolean; x: number; y: number; w: number } }).crop = {
      active,
      x: rect.x,
      y: rect.y,
      w: rect.w,
    };
  }, LOCAL_ORIGIN);
}

/** Read + coerce/fit node.data.crop for the given output aspect (the single
 *  reader — clamps + keeps the rect fully inside the frame at the locked
 *  aspect). For a module whose crop samples its own output frame, pass the live
 *  output aspect for BOTH frameAspect and regionAspect. */
export function readCrop(
  node: ModuleNode | undefined,
  frameAspect: number,
  regionAspect: number,
): CropState {
  return coerceCrop(
    (node?.data as { crop?: unknown } | undefined)?.crop,
    frameAspect,
    regionAspect,
  );
}
