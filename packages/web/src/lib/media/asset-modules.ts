// packages/web/src/lib/media/asset-modules.ts
//
// WORKFLOW MODE P3 — the PURE mapping + layout core for asset-backed
// modules (the Loaded Assets Picker's click-to-patch flow):
//
//   * which module type a media kind spawns (video→VIDEOVARISPEED,
//     image→PICTUREBOX, audio→SAMSLOOP — the owner's spec),
//   * which output port the auto-wire leaves from, and which CABLE TYPE
//     the dangling virtual-port drag renders,
//   * the MEDIA DESCRIPTOR persisted on the node (`node.data.mediaDesc`)
//     — the durable half of the asset↔module link (see asset-links
//     .svelte.ts for the local half + the placement rationale),
//   * the RIGHT-RAIL layout math: auto-created asset modules stack in a
//     single column at the FAR RIGHT of the canvas.
//
// PURE + framework-free (no Svelte, no Yjs, no DOM) so every rule is
// unit-testable against plain fixtures; the imperative spawn/load driver
// lives in asset-spawn.ts.

import type { MediaKind } from './ingest';

// ---------------------------------------------------------------------------
// Kind → module mapping
// ---------------------------------------------------------------------------

export interface AssetModuleSpec {
  /** Registered module type id the asset spawns. */
  type: string;
  /** Registry domain the type lives in. */
  domain: 'audio' | 'video';
  /** The output port the auto-wire leaves from (def port id). */
  outputPortId: string;
  /** Cable type the virtual-port drag renders while dangling
   *  ('video' for images+videos, 'audio' for sounds — owner spec).
   *  The COMMITTED edge still derives its types from the def ports
   *  (picturebox `out` is `image`, upcast to `video` by canConnect). */
  dragCableType: 'video' | 'audio';
}

/** The owner's kind→module table. Port ids are pinned by each def's
 *  contract (contract-lock.txt); the unit test cross-checks them against
 *  the live registries so a def rename can't silently strand this map. */
export const ASSET_MODULE_SPECS: Readonly<Record<MediaKind, AssetModuleSpec>> = {
  video: { type: 'videovarispeed', domain: 'video', outputPortId: 'video', dragCableType: 'video' },
  image: { type: 'picturebox', domain: 'video', outputPortId: 'out', dragCableType: 'video' },
  audio: { type: 'samsloop', domain: 'audio', outputPortId: 'out', dragCableType: 'audio' },
} as const;

export function assetModuleSpecFor(kind: MediaKind): AssetModuleSpec {
  return ASSET_MODULE_SPECS[kind];
}

// ---------------------------------------------------------------------------
// Media descriptor — the durable (synced) half of the asset link
// ---------------------------------------------------------------------------

/**
 * Persisted on the auto-created node as `node.data.mediaDesc`. Media blobs
 * are SESSION-LOCAL (object URLs — lib/media/library.svelte.ts), so after a
 * reload — or on a collaborator's machine without the file — the module
 * renders its normal empty/unloaded state. The descriptor is the REBIND
 * key: when the library later holds a file matching (name, size,
 * lastModified) — the library's own dupe-key identity — the sweep in
 * asset-spawn.ts re-links (and re-drives the module's load path if its
 * media is missing) automatically.
 *
 * REVERSIBLE DEFAULT (plan Q2): "normal empty state + silent auto-rebind"
 * was chosen over a bespoke "missing media" placeholder card; upgrading to
 * a placeholder later only touches the cards, not this descriptor.
 */
export interface MediaDescriptor {
  name: string;
  size: number;
  lastModified: number;
  kind: MediaKind;
}

/** Minimal item shape the descriptor helpers need (MediaItem satisfies it). */
export interface MediaItemLike {
  name: string;
  size: number;
  lastModified: number;
  kind: MediaKind;
}

export function mediaDescriptorOf(item: MediaItemLike): MediaDescriptor {
  return {
    name: item.name,
    size: item.size,
    lastModified: item.lastModified,
    kind: item.kind,
  };
}

/** Dupe-key match — the SAME identity the media library uses to skip
 *  duplicate adds, so "matching file" means exactly "the file the library
 *  would have refused as a duplicate". */
export function descriptorMatches(desc: MediaDescriptor, item: MediaItemLike): boolean {
  return (
    desc.name === item.name &&
    desc.size === item.size &&
    desc.lastModified === item.lastModified &&
    desc.kind === item.kind
  );
}

/** Safe read of a node's persisted descriptor (`data.mediaDesc`).
 *  Returns null for absent/malformed values (untrusted synced data). */
export function readMediaDescriptor(node: {
  data?: Record<string, unknown> | null;
}): MediaDescriptor | null {
  const raw = node.data?.mediaDesc;
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (
    typeof d.name !== 'string' ||
    typeof d.size !== 'number' ||
    typeof d.lastModified !== 'number' ||
    (d.kind !== 'video' && d.kind !== 'image' && d.kind !== 'audio')
  ) {
    return null;
  }
  return {
    name: d.name,
    size: d.size,
    lastModified: d.lastModified,
    kind: d.kind as MediaKind,
  };
}

// ---------------------------------------------------------------------------
// Right-rail layout — a single auto-stacked column at the FAR RIGHT
// ---------------------------------------------------------------------------

/** Flow-space box (positions from node.position; sizes measured from the
 *  DOM — offsetWidth/Height is zoom-independent — with a default for
 *  not-yet-mounted cards, mirroring organize.ts). */
export interface RailBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Horizontal clearance between the rightmost ordinary card and the rail
 *  column. Generous so the rail reads as ITS OWN band, not a next card. */
export const RIGHT_RAIL_GAP_X = 160;
/** Vertical gap between stacked rail cards. */
export const RIGHT_RAIL_GAP_Y = 24;
/** Rail top edge when the rail is empty. */
export const RIGHT_RAIL_TOP_Y = 40;
/** Rail x on a canvas with no other cards at all. */
export const RIGHT_RAIL_EMPTY_X = 600;

/**
 * Where the NEXT auto-created asset module lands.
 *
 * Rules (unit-locked):
 *  1. Column x: existing rail members define the column — new cards
 *     left-align to the column's min x (a stable column even when card
 *     widths differ). With no rail members yet, the column opens
 *     RIGHT_RAIL_GAP_X to the right of the rightmost ORDINARY card's
 *     right edge; on an empty canvas it opens at RIGHT_RAIL_EMPTY_X.
 *  2. Stack y: below the LOWEST rail member (+RIGHT_RAIL_GAP_Y);
 *     an empty rail starts at RIGHT_RAIL_TOP_Y.
 *
 * `otherBoxes` = every ordinary (non-rail, canvas-visible) card;
 * `railBoxes` = the current rail members (asset-created nodes).
 */
export function nextRightRailPosition(
  otherBoxes: readonly RailBox[],
  railBoxes: readonly RailBox[],
): { x: number; y: number } {
  let x: number;
  if (railBoxes.length > 0) {
    x = Math.min(...railBoxes.map((b) => b.x));
  } else if (otherBoxes.length > 0) {
    x = Math.max(...otherBoxes.map((b) => b.x + b.w)) + RIGHT_RAIL_GAP_X;
  } else {
    x = RIGHT_RAIL_EMPTY_X;
  }
  const y =
    railBoxes.length > 0
      ? Math.max(...railBoxes.map((b) => b.y + b.h)) + RIGHT_RAIL_GAP_Y
      : RIGHT_RAIL_TOP_Y;
  return { x, y };
}
