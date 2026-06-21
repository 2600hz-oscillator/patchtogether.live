// packages/web/src/lib/graph/performance-zip.ts
//
// PORTABLE Performance Bundle — a self-contained `.zip` of an ENTIRE rackspace
// so it can be moved to another MACHINE and reloaded for a live show.
//
// This is the cross-machine sibling of graph/performance-bundle.ts +
// performance-store.ts (the IndexedDB "Save/Load Local Performance"), which is
// same-browser-profile ONLY because it relies on FileSystemFileHandles that
// can't leave the machine. Here we carry the actual asset BYTES inside the zip.
//
// WHAT NEEDS OUT-OF-BAND BYTES (everything else is INLINE in the patch
// envelope and rides along for free — see performance-bundle.ts):
//   * the patch graph (nodes/edges/params/positions) — base64 Yjs update;
//   * PICTUREBOX images, TOYBOX layer images / custom shader / custom OBJ,
//     SAMSLOOP samples — all base64/text inline on node.data;
//   * CV routes, control-surface bindings, module custom names — node.data;
//   * MIDI Learn CC maps + device/gamepad descriptors — in the manifest.
// The ONE thing the envelope can't carry is a VIDEOBOX (or TOYBOX layer) VIDEO:
// the card holds it as an ephemeral object URL, only fileMeta (name/size/
// duration/handleId) is persisted. So the caller resolves those bytes at export
// time and we store them as separate (large) zip entries — exactly as
// video/toybox-preset-io.ts does for a single TOYBOX, generalised to the rack.
//
// PURE: `fflate` function-form API only (zipSync/unzipSync) — no DOM, no Worker
// — so it is fully unit-testable + safe to call anywhere. Round-trips exactly.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { PerformanceBundle } from './performance-bundle';

/** Reject any single bundled video larger than this on import. This is a
 *  per-FILE sanity guard, NOT a per-bundle cap: a perf with 7 VIDEOVARISPEED
 *  slots is intended to be large (the owner explicitly accepts large bundles),
 *  so we never cap the bundle total or silently drop a populated slot. The
 *  ceiling matches VIDEOVARISPEED_MAX_SLOT_BYTES (the per-slot load limit the
 *  card enforces) so any file the card ACCEPTED into a slot also survives the
 *  round-trip — a 50 MB cap (the old value) would have rejected a legal slot. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB (== per-slot load cap)

export const PERFORMANCE_ZIP_FORMAT = 'pt-performance-v1';
const MANIFEST_JSON = 'performance.json';
const MEDIA_DIR = 'media/';

/** One out-of-band media asset, resolved to raw bytes for the zip. Two kinds:
 *  - 'video' — a loaded VIDEOBOX / VIDEOVARISPEED clip (the bytes are seeded
 *    back into the video-file-store under `handleId` so the card re-acquires it);
 *  - 'audio' — a TWOTRACKS reel tape (recorded PCM with no source file; the
 *    loader re-sends it to the reel's worklet via `load-tape`). The `handleId`
 *    encodes the reel (`<nodeId>:a` / `<nodeId>:b`) so the loader routes it. */
export interface PerformanceMedia {
  /** Patch node id this asset belongs to. */
  nodeId: string;
  /** The stable id under which the restore side seeds/routes the bytes. For
   *  VIDEOBOX/VIDEOVARISPEED this is the node's fileMeta.handleId (so the card's
   *  tryReloadFromHandle picks it up); for TWOTRACKS it is `<nodeId>:<reel>`. */
  handleId: string;
  /** Asset role. */
  role: 'video' | 'audio';
  /** Original filename (display + restored File name + in-zip path). */
  name: string;
  /** Raw asset bytes. */
  bytes: Uint8Array;
  /** Asset slot index (0..6) for the 7-slot VIDEOVARISPEED selector. Omitted /
   *  0 = the single-video slot (VIDEOBOX, or VIDEOVARISPEED slot 0). Restored
   *  into the matching slot so all 7 videos come back in the right positions. */
  slot?: number;
}

/** Everything needed to reconstruct a whole performance: the manifest (patch
 *  envelope + mappings) + the out-of-band media bytes. */
export interface PerformanceZipBundle {
  /** The existing PerformanceBundle manifest (graph envelope + assets +
   *  midiBindings + midiDevices + gamepadBindings). */
  bundle: PerformanceBundle;
  /** Out-of-band video bytes (empty if the rack has no loaded videos). */
  media: PerformanceMedia[];
  /** Epoch-ms stamp (caller supplies; this module never reads the clock). */
  savedAt?: number;
}

/** In-manifest descriptor for one stored media entry (the bytes live at `path`). */
interface MediaEntry {
  nodeId: string;
  handleId: string;
  role: 'video' | 'audio';
  name: string;
  path: string;
  /** Asset slot (0..6); omitted ⇒ 0 (single-video back-compat). */
  slot?: number;
}

interface PerformanceManifest {
  format: string;
  savedAt: number;
  bundle: PerformanceBundle;
  media: MediaEntry[];
}

/** Filesystem-safe in-zip filename fragment. */
function sanitize(name: string): string {
  return (name || 'video').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/** Build the `.zip` bytes for a whole-rack performance bundle. Deterministic
 *  for a fixed input (no clock/random read here — `savedAt` is supplied). */
export function buildPerformanceZip(input: PerformanceZipBundle): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const media: MediaEntry[] = input.media.map((m, i) => ({
    nodeId: m.nodeId,
    handleId: m.handleId,
    role: m.role,
    name: m.name,
    // include role + `i` + handleId so two assets on the same node (e.g. a
    // TWOTRACKS reel a + reel b, or 7 VIDEOVARISPEED slots) and same-named clips
    // on different nodes don't collide. (`i` is the global media index, so the
    // path is unique even before considering handleId/slot.)
    path: `${MEDIA_DIR}${m.role}-${i}-${sanitize(m.handleId)}-${sanitize(m.name)}`,
    // Only emit slot when non-zero so a single-video manifest stays byte-identical
    // to the pre-multi-slot format (back-compat + deterministic).
    ...(m.slot && m.slot > 0 ? { slot: m.slot } : {}),
  }));
  const manifest: PerformanceManifest = {
    format: PERFORMANCE_ZIP_FORMAT,
    savedAt: input.savedAt ?? 0,
    bundle: input.bundle,
    media,
  };
  files[MANIFEST_JSON] = strToU8(JSON.stringify(manifest));
  input.media.forEach((m, i) => {
    files[media[i]!.path] = m.bytes;
  });
  return zipSync(files);
}

/** Parse a performance `.zip` back into a bundle. Throws a user-surfaceable
 *  message on an empty/corrupt/foreign zip. Oversized videos are rejected;
 *  referenced-but-missing media is skipped (the node falls back to re-link). */
export function parsePerformanceZip(zip: ArrayBuffer | Uint8Array): PerformanceZipBundle {
  const bytes = zip instanceof Uint8Array ? zip : new Uint8Array(zip);
  if (bytes.length === 0) throw new Error('Performance zip is empty');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new Error(`Performance zip is corrupt: ${e instanceof Error ? e.message : String(e)}`);
  }
  const mj = entries[MANIFEST_JSON];
  if (!mj) {
    throw new Error('Performance zip is missing performance.json (not a performance bundle?)');
  }
  let manifest: PerformanceManifest;
  try {
    manifest = JSON.parse(strFromU8(mj)) as PerformanceManifest;
  } catch (e) {
    throw new Error(`performance.json is invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (manifest.format !== PERFORMANCE_ZIP_FORMAT) {
    throw new Error(
      `Performance bundle format '${manifest.format}' is unsupported (expected ${PERFORMANCE_ZIP_FORMAT})`,
    );
  }
  if (!manifest.bundle || typeof manifest.bundle !== 'object') {
    throw new Error('performance.json has no `bundle` manifest');
  }
  const media: PerformanceMedia[] = [];
  for (const m of manifest.media ?? []) {
    const mbytes = entries[m.path];
    if (!mbytes) continue; // referenced media missing → skip (node re-links)
    // The 50 MB cap guards the heavy out-of-band VIDEO assets. TWOTRACKS audio
    // tapes are bounded by the worklet's fixed buffer (≈20 s stereo, well under
    // the cap) but we apply the same ceiling defensively to any bundled asset.
    if (mbytes.length > MAX_VIDEO_BYTES) {
      throw new Error(
        `Bundled ${m.role} '${m.name}' is ${(mbytes.length / 1048576).toFixed(0)} MB — exceeds the ${(MAX_VIDEO_BYTES / 1048576).toFixed(0)} MB limit`,
      );
    }
    media.push({
      nodeId: m.nodeId,
      handleId: m.handleId,
      role: m.role,
      name: m.name,
      bytes: mbytes,
      // slot absent in older manifests ⇒ 0 (the single-video slot).
      slot: typeof m.slot === 'number' ? m.slot : 0,
    });
  }
  return { bundle: manifest.bundle, media, savedAt: manifest.savedAt };
}

/** True if `bytes` looks like a performance zip (cheap pre-check — peeks for
 *  the performance.json entry). */
export function isPerformanceZip(zip: ArrayBuffer | Uint8Array): boolean {
  try {
    const bytes = zip instanceof Uint8Array ? zip : new Uint8Array(zip);
    if (bytes.length === 0) return false;
    const entries = unzipSync(bytes);
    return !!entries[MANIFEST_JSON];
  } catch {
    return false;
  }
}
