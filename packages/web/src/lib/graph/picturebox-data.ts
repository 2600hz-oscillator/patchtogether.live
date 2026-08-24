// packages/web/src/lib/graph/picturebox-data.ts
//
// PICTUREBOX's 7-slot asset bank — the node.data read/write seam, in ONE place.
//
// ⚠ WHY THIS FILE EXISTS. The pad-and-slice that keeps `assets` / `assetNames` /
// `assetMimes` parallel and exactly ASSET_SLOTS long was written TWICE in
// `PictureboxCard.svelte` — the load path (`onSlotFileChange`) and the clear path
// (`clearSlot`) were the same eighteen lines with one assignment different. The
// dock faceplate's `fullViewBody` would have been the THIRD copy, so the copies
// were folded into these two writers before the third was added rather than
// after.
//
// It is the `matrixmix.ts` `mutateMatrix` shape (a single LOCAL_ORIGIN
// transaction per user action, resolving the live node inside it), for the
// reason `mutate.ts:13-18` states: an untagged write is silently NOT undoable,
// because `store.ts` configures `trackedOrigins: new Set([LOCAL_ORIGIN])`. All
// three of picturebox's pre-existing writers already passed the origin — this
// module is what keeps that correct in two SURFACES instead of one, and the
// unit test drives the origin explicitly so a dropped tag is red rather than
// merely undocumented.
//
// ⚠ THE THREE ARRAYS ARE REASSIGNED, NOT MUTATED IN PLACE, AND THAT IS
// DELIBERATE — it is exactly what the card already did. They hold PRIMITIVES
// (base64 strings, filenames, MIME strings, nulls), never a live Y type, so the
// "Type already integrated" trap that forces in-place writes on a Y map holding
// Y children does not apply. A face PR is the wrong place to change persistence
// semantics, so the behaviour here is byte-for-byte the card's.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { ASSET_SLOTS } from '$lib/video/asset-select';

/** The three parallel per-slot arrays a picturebox node persists. */
export const PICTUREBOX_SLOT_KEYS = ['assets', 'assetNames', 'assetMimes'] as const;
export type PictureboxSlotKey = (typeof PICTUREBOX_SLOT_KEYS)[number];

/**
 * Coerce whatever is on `node.data[key]` into a fresh, exactly-ASSET_SLOTS-long
 * array of `string | null`. Absent / wrong-typed / short / over-long all resolve
 * to the same shape, which is what makes a v2 or v3 node readable without a
 * migration step (the def's header is explicit that the forward-compat
 * behaviour lives in the READERS — there is no `migrate` function anywhere).
 *
 * Pure: takes the raw value, returns a new array, touches no Y.Doc.
 */
export function padSlotArray(raw: unknown): (string | null)[] {
  const out: (string | null)[] = Array.isArray(raw)
    ? (raw as (string | null)[]).slice(0, ASSET_SLOTS)
    : new Array<string | null>(ASSET_SLOTS).fill(null);
  while (out.length < ASSET_SLOTS) out.push(null);
  return out;
}

/** True iff `slot` is a real slot index. Both writers below are no-ops outside
 *  the range rather than throwing — a bad index from a render loop must never
 *  take the faceplate down mid-drag. */
export function isSlotIndex(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < ASSET_SLOTS;
}

/** One LOCAL_ORIGIN transaction over a node's `data`, resolving the LIVE node
 *  inside it (the node may have been deleted between the click and the commit).
 *  `origin` is a parameter only so the unit test can prove the default is the
 *  tracked one; product code never passes it. */
function mutatePictureboxData(
  nodeId: string,
  fn: (data: Record<string, unknown>) => void,
  origin: unknown = LOCAL_ORIGIN,
): void {
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return; // node gone → safe no-op
    if (!target.data) target.data = {};
    fn(target.data as Record<string, unknown>);
  }, origin);
}

/** What a picked file contributes to one slot — the fields of `EncodedPick`
 *  this seam actually persists. Declared structurally rather than imported so
 *  `$lib/graph` does not depend on the video encoder for a type. */
export interface PictureboxSlotAsset {
  /** base64 image bytes: a downscaled JPEG still, or a byte-preserved gif. */
  base64: string;
  /** 'image/jpeg' | 'image/gif' — which decode path the slot takes. */
  mime: string;
}

/**
 * Write one slot's image + filename + MIME, keeping all three arrays padded and
 * parallel. One transaction, so peers see a single update carrying the bytes,
 * the name and the MIME together (a split write can render a slot whose name
 * and picture disagree).
 */
export function setSlotAsset(
  nodeId: string,
  slot: number,
  asset: PictureboxSlotAsset,
  filename: string | null,
): void {
  if (!isSlotIndex(slot)) return;
  mutatePictureboxData(nodeId, (d) => {
    const assets = padSlotArray(d.assets);
    assets[slot] = asset.base64;
    d.assets = assets;
    const names = padSlotArray(d.assetNames);
    names[slot] = filename;
    d.assetNames = names;
    const mimes = padSlotArray(d.assetMimes);
    mimes[slot] = asset.mime;
    d.assetMimes = mimes;
  });
}

/** Clear one slot — the exact inverse of `setSlotAsset`, nulling the same three
 *  entries in one transaction so a half-cleared slot never syncs. */
export function clearSlotAsset(nodeId: string, slot: number): void {
  if (!isSlotIndex(slot)) return;
  mutatePictureboxData(nodeId, (d) => {
    const assets = padSlotArray(d.assets);
    assets[slot] = null;
    d.assets = assets;
    const names = padSlotArray(d.assetNames);
    names[slot] = null;
    d.assetNames = names;
    const mimes = padSlotArray(d.assetMimes);
    mimes[slot] = null;
    d.assetMimes = mimes;
  });
}

/**
 * Write the SINGLE-image fields (`imageBytes` / `imageMime` / `imageName`) in one
 * transaction. The "Choose image…" path, shared by the legacy card and the dock
 * faceplate body for the same reason the slot writers are.
 */
export function setSingleImage(
  nodeId: string,
  asset: PictureboxSlotAsset,
  filename: string | null,
): void {
  mutatePictureboxData(nodeId, (d) => {
    d.imageBytes = asset.base64;
    d.imageMime = asset.mime;
    d.imageName = filename;
  });
}
