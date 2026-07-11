// packages/web/src/lib/media/asset-spawn.ts
//
// WORKFLOW MODE P3 — the imperative driver behind the Loaded Assets
// Picker: create an asset-backed module in the RIGHT RAIL, load the
// asset into it THROUGH THE MODULE'S OWN LOAD PATH (never a parallel
// loader), keep the local assetId↔nodeId links, unload-deletes, and the
// descriptor rebind sweep.
//
// HOW EACH MODULE'S OWN LOAD PATH IS DRIVEN (audited against the cards):
//
//   * SAMSLOOP — the card decodes via `loadSamsloopWav(file, audioCtx)`
//     then persists the ORIGINAL bytes to `node.data.fileBytesB64` (+
//     fileSize/fileMime/fileName/sampleRate/sampleLength and the
//     start/end params). We call the SAME decode helper and write the
//     SAME fields; the module factory's 200 ms node.data poll decodes
//     and posts `loadSample` to the worklet exactly as for a card upload.
//
//   * PICTUREBOX — the card encodes via `encodePickedFile(file)` (640×480
//     downscale → JPEG; gif byte-preserved) and persists base64 to
//     `node.data.imageBytes`/`imageMime`/`imageName`; its $effect on
//     imageBytes decodes → extras.setImage. Same helper, same fields —
//     the card's own effect (which also serves remote peers) drives the
//     engine upload.
//
//   * VIDEOVARISPEED — media is session-local (objectURL on the card's
//     <video>), so we use the card's PERSISTENCE seam — the exact path
//     the performance-zip loader already drives (Canvas.svelte
//     loadPerformanceZipBytes): `putVideoFileBlob(handleId, file, name)`
//     into the IDB blob store + `node.data.fileMeta = {name, duration,
//     size, handleId}`. The card's $effect on fileMeta.handleId then
//     calls its own `loadFile`, which owns element/audio wiring.
//
// Node creation mirrors Canvas.spawnFromPalette's guards (per-user +
// workspace caps for PICTUREBOX/SAMSLOOP, generic maxInstances, creatorId
// stamping) without the cursor-anchored placement — asset modules stack
// in the right rail (asset-modules.ts nextRightRailPosition).

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { removePatchNode } from '$lib/graph/mutate';
import { wouldExceedCap } from '$lib/graph/cap';
import type { ModuleNode } from '$lib/graph/types';
import { nextDefaultName } from '$lib/multiplayer/module-naming';
import {
  pictureboxSpawnDecision,
  explainSpawnDenial,
  PICTUREBOX_TYPE,
} from '$lib/multiplayer/picturebox-limits';
import {
  samsloopSpawnDecision,
  SAMSLOOP_LIMIT_MESSAGE,
  SAMSLOOP_TYPE,
} from '$lib/multiplayer/samsloop-limits';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getActiveEngine } from '$lib/audio/engine-ref';
import type { AudioEngine } from '$lib/audio/engine';
import { loadSamsloopWav } from '$lib/audio/modules/samsloop';
import { bytesToBase64 } from '$lib/audio/modules/samsloop-record';
import { encodePickedFile } from '$lib/video/modules/picturebox-encode';
import {
  newVideoFileId,
  putVideoFileBlob,
  getVideoFileHandle,
} from '$lib/video/video-file-store';
import { isPinnedNode } from '$lib/graph/workflow-pins';
import type { MediaItem } from './library.svelte';
import { mediaLibrary } from './library.svelte';
import { assetLinks } from './asset-links.svelte';
import {
  assetModuleSpecFor,
  mediaDescriptorOf,
  descriptorMatches,
  readMediaDescriptor,
  nextRightRailPosition,
  type RailBox,
  type MediaItemLike,
} from './asset-modules';

export interface AssetSpawnContext {
  /** Multiplayer user id (creatorId stamping + per-user caps); null in
   *  single-user mode — mirrors spawnFromPalette. MUST be a plain string
   *  or null — callers snapshot it (never a live Svelte prop accessor:
   *  a destroyed component's prop read yields an internal sentinel
   *  SYMBOL, and a symbol on node.data blows up the CRDT write). The
   *  spawn path re-guards with `typeof === 'string'` regardless. */
  currentUserId: string | null;
  /** Boot/get the engine (SAMSLOOP decode needs an AudioContext). */
  ensureEngine?: (() => Promise<unknown>) | null;
  /** Surface a user-facing refusal (cap hit, decode failure). Optional —
   *  absent callers get the silent-discard gesture semantics. */
  onError?: (message: string) => void;
}

export interface AssetSpawnResult {
  nodeId: string;
  /** The def output port the auto-wire leaves from. */
  portId: string;
}

// ---------------------------------------------------------------------------
// Right-rail placement (DOM-measured footprints, organize.ts precedent)
// ---------------------------------------------------------------------------

/** Fallbacks for cards that haven't mounted/measured yet. */
const DEFAULT_CARD_W = 320;
const DEFAULT_CARD_H = 220;

function nodeBox(node: ModuleNode): RailBox {
  let w = DEFAULT_CARD_W;
  let h = DEFAULT_CARD_H;
  if (typeof document !== 'undefined') {
    const el = document.querySelector<HTMLElement>(
      `.svelte-flow__node[data-id="${node.id}"]`,
    );
    // offsetWidth/Height are zoom-independent flow-space px (organize.ts).
    if (el && el.offsetWidth > 0) {
      w = el.offsetWidth;
      h = el.offsetHeight;
    }
  }
  return { x: node.position.x, y: node.position.y, w, h };
}

/** Compute where the next auto-created asset module lands (flow-space). */
export function computeRailPosition(): { x: number; y: number } {
  const others: RailBox[] = [];
  const rail: RailBox[] = [];
  for (const node of Object.values(patch.nodes) as (ModuleNode | undefined)[]) {
    if (!node) continue;
    if (isPinnedNode(node)) continue; // drawer/topbar pins render no card
    if (node.type === 'cadillac') continue; // transient drive-through car
    (readMediaDescriptor(node) ? rail : others).push(nodeBox(node));
  }
  return nextRightRailPosition(others, rail);
}

// ---------------------------------------------------------------------------
// Per-module media load drivers (see header — the modules' OWN paths)
// ---------------------------------------------------------------------------

async function loadAudioIntoSamsloop(
  nodeId: string,
  item: MediaItem,
  ctx: AssetSpawnContext,
): Promise<string | null> {
  try {
    await ctx.ensureEngine?.();
  } catch {
    /* engine boot failure surfaces below as the missing-ctx error */
  }
  const eng = getActiveEngine();
  const audioCtx = eng?.hasDomain('audio')
    ? eng.getDomain<AudioEngine>('audio').ctx
    : undefined;
  if (!audioCtx) return 'audio engine not ready — click the canvas once, then retry';
  const result = await loadSamsloopWav(item.file, audioCtx);
  if (!result.ok || !result.samples) return result.error ?? 'could not decode audio file';
  const samples = result.samples;
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return;
    if (!target.data) target.data = {};
    const d = target.data as Record<string, unknown>;
    if (result.fileBytes) {
      d.fileBytesB64 = bytesToBase64(result.fileBytes);
      d.fileSize = result.fileSize ?? result.fileBytes.byteLength;
      d.fileMime = result.fileMime ?? '';
    }
    if (d.samples) delete d.samples; // never persist decoded PCM (legacy key)
    d.sampleRate = result.sampleRate;
    d.sampleLength = samples.length;
    d.fileName = item.name;
    target.params.start = 0;
    target.params.end = samples.length;
  }, LOCAL_ORIGIN);
  return null;
}

async function loadImageIntoPicturebox(nodeId: string, item: MediaItem): Promise<string | null> {
  let enc: Awaited<ReturnType<typeof encodePickedFile>>;
  try {
    enc = await encodePickedFile(item.file);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return;
    if (!target.data) target.data = {};
    const d = target.data as Record<string, unknown>;
    d.imageBytes = enc.base64;
    d.imageMime = enc.mime;
    d.imageName = item.name;
  }, LOCAL_ORIGIN);
  return null;
}

async function loadVideoIntoVarispeed(nodeId: string, item: MediaItem): Promise<string | null> {
  const handleId = newVideoFileId();
  try {
    await putVideoFileBlob(handleId, item.file, item.name);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return;
    if (!target.data) target.data = {};
    const d = target.data as Record<string, unknown>;
    d.fileMeta = {
      name: item.name,
      duration: item.meta.durationS ?? 0,
      size: item.size,
      handleId,
    };
  }, LOCAL_ORIGIN);
  return null;
}

/** Drive the module's own load path for `item`. Null = success. */
async function loadMediaIntoNode(
  nodeId: string,
  item: MediaItem,
  ctx: AssetSpawnContext,
): Promise<string | null> {
  switch (item.kind) {
    case 'audio':
      return loadAudioIntoSamsloop(nodeId, item, ctx);
    case 'image':
      return loadImageIntoPicturebox(nodeId, item);
    case 'video':
      return loadVideoIntoVarispeed(nodeId, item);
  }
}

// ---------------------------------------------------------------------------
// Create / ensure / unload
// ---------------------------------------------------------------------------

/** Cap guards mirroring spawnFromPalette (silent-discard callers get the
 *  message through ctx.onError). Null = allowed. */
function spawnRefusal(type: string, userId: string | null): string | null {
  if (type === PICTUREBOX_TYPE) {
    const d = pictureboxSpawnDecision(patch.nodes, userId);
    if (!d.ok) return explainSpawnDenial(d);
  }
  if (type === SAMSLOOP_TYPE) {
    const d = samsloopSpawnDecision(patch.nodes, userId);
    if (!d.ok) return SAMSLOOP_LIMIT_MESSAGE;
  }
  const def = getModuleDef(type) ?? getVideoModuleDef(type);
  if (def?.maxInstances !== undefined && wouldExceedCap(patch.nodes, def)) {
    return `${type} limit reached (${def.maxInstances} per rack)`;
  }
  return null;
}

/**
 * Create a NEW asset-backed module for `item` in the right rail, load the
 * media through the module's own path, and link it. Used by the virtual
 * drag's first commit AND the "add additional output module" context row
 * (which appends a secondary module — nodesFor()[0] stays primary).
 */
export async function createAssetModule(
  item: MediaItem,
  ctx: AssetSpawnContext,
): Promise<AssetSpawnResult | null> {
  const spec = assetModuleSpecFor(item.kind);
  // Type-guard, not just truthiness: everything stamped onto node.data
  // must be CRDT-serializable (see AssetSpawnContext.currentUserId).
  const userId = typeof ctx.currentUserId === 'string' ? ctx.currentUserId : null;
  const refusal = spawnRefusal(spec.type, userId);
  if (refusal) {
    ctx.onError?.(refusal);
    return null;
  }
  const id = `asset-${spec.type}-${crypto.randomUUID().slice(0, 8)}`;
  const position = computeRailPosition();
  const data: Record<string, unknown> = {
    name: nextDefaultName(patch.nodes, spec.type),
    mediaDesc: mediaDescriptorOf(item),
  };
  if ((spec.type === PICTUREBOX_TYPE || spec.type === SAMSLOOP_TYPE) && userId) {
    data.creatorId = userId;
  }
  ydoc.transact(() => {
    patch.nodes[id] = {
      id,
      type: spec.type,
      domain: spec.domain,
      position,
      params: {},
      data,
    };
  }, LOCAL_ORIGIN);

  const loadError = await loadMediaIntoNode(id, item, ctx);
  if (loadError) {
    // The module can't hold its media — don't leave an empty husk.
    removePatchNode(id);
    ctx.onError?.(loadError);
    return null;
  }
  assetLinks.register(item.id, id);
  return { nodeId: id, portId: spec.outputPortId };
}

/**
 * Resolve the drag-commit source for `item`: the EXISTING primary module's
 * output when one is linked (drag-from-existing never spawns a second
 * module), else a freshly created one. The virtual-port drag's `resolve`.
 */
export async function ensureAssetModule(
  item: MediaItem,
  ctx: AssetSpawnContext,
): Promise<AssetSpawnResult | null> {
  const primary = assetLinks.primaryFor(item.id);
  if (primary && patch.nodes[primary]) {
    return { nodeId: primary, portId: assetModuleSpecFor(item.kind).outputPortId };
  }
  return createAssetModule(item, ctx);
}

/**
 * Unload an asset: delete every linked module (removePatchNode — the P1
 * delete path; asset modules are never pinned, so it always succeeds),
 * drop the links, and remove the item (revoking its object URLs).
 */
export function unloadAsset(assetId: string): void {
  for (const nodeId of assetLinks.nodesFor(assetId)) {
    removePatchNode(nodeId);
  }
  assetLinks.unregisterAsset(assetId);
  mediaLibrary.remove(assetId);
}

// ---------------------------------------------------------------------------
// Rebind sweep (missing-media default — reversible, see asset-modules.ts)
// ---------------------------------------------------------------------------

/** Minimal node shape the pure planner needs. */
export interface RebindNodeLike {
  id: string;
  data?: Record<string, unknown> | null;
}

export interface RebindPlanEntry<TItem extends MediaItemLike & { id: string }> {
  nodeId: string;
  item: TItem;
}

/**
 * PURE: which unlinked descriptor-carrying nodes match a library item
 * (dupe-key)? `linkedNodeIds` = nodes already linked this session.
 */
export function planAssetRebinds<TItem extends MediaItemLike & { id: string }>(
  nodes: readonly RebindNodeLike[],
  items: readonly TItem[],
  linkedNodeIds: ReadonlySet<string>,
): RebindPlanEntry<TItem>[] {
  const plan: RebindPlanEntry<TItem>[] = [];
  for (const node of nodes) {
    if (linkedNodeIds.has(node.id)) continue;
    const desc = readMediaDescriptor(node);
    if (!desc) continue;
    const item = items.find((i) => descriptorMatches(desc, i));
    if (item) plan.push({ nodeId: node.id, item });
  }
  return plan;
}

let sweepInFlight = false;

/**
 * Re-link (and, where the media itself is missing, re-drive the module's
 * load path for) every node whose persisted descriptor matches a loaded
 * library item. Idempotent; safe to run on every nodes/items change.
 *
 *  - SAMSLOOP / PICTUREBOX persist their bytes IN the doc, so a rebind is
 *    normally link-only; the load path re-runs only when the bytes are
 *    absent (a node authored elsewhere without them).
 *  - VIDEOVARISPEED media is an IDB blob — present after a same-browser
 *    reload, absent for collaborators/new machines. When the blob is
 *    missing we re-put it under a FRESH handleId and update fileMeta so
 *    the card's own handle-reload effect fires.
 */
export async function runAssetRebindSweep(ctx: AssetSpawnContext): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const nodes = Object.values(patch.nodes).filter(Boolean) as ModuleNode[];
    const linked = new Set<string>();
    for (const item of mediaLibrary.items) {
      for (const nodeId of assetLinks.nodesFor(item.id)) linked.add(nodeId);
    }
    const plan = planAssetRebinds(nodes, mediaLibrary.items, linked);
    for (const { nodeId, item } of plan) {
      assetLinks.register(item.id, nodeId);
      const node = patch.nodes[nodeId];
      if (!node) continue;
      const d = (node.data ?? {}) as Record<string, unknown>;
      if (item.kind === 'audio' && !d.fileBytesB64) {
        await loadAudioIntoSamsloop(nodeId, item, ctx);
      } else if (item.kind === 'image' && !d.imageBytes) {
        await loadImageIntoPicturebox(nodeId, item);
      } else if (item.kind === 'video') {
        const meta = d.fileMeta as { handleId?: string } | undefined;
        const stored = meta?.handleId ? await getVideoFileHandle(meta.handleId) : null;
        if (!stored) await loadVideoIntoVarispeed(nodeId, item);
      }
    }
  } finally {
    sweepInFlight = false;
  }
}
