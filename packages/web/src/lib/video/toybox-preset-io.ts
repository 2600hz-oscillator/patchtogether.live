// packages/web/src/lib/video/toybox-preset-io.ts
//
// TOYBOX user-preset EXPORT / IMPORT — a self-contained `.zip` bundle of a
// TOYBOX node's full state PLUS its loaded media, so a patch can be shared or
// re-loaded on another machine.
//
// The zip layout (format `toybox-preset-v1`):
//   preset.json          — { format, label, savedAt, data, videos[] }
//                          `data` is the VERBATIM toybox node.data blob (layers
//                          + combine + cvRoutes + cvInputs). Images, custom
//                          shader source, and custom OBJ source already live
//                          INLINE in node.data (base64 / text), so they ride
//                          along for free — no separate handling needed.
//   media/video-<i>-...  — raw bytes for each layer's loaded VIDEO. Videos are
//                          the ONE media kind NOT persisted in node.data (the
//                          card holds them as ephemeral object URLs), so the
//                          caller resolves their bytes at export time and we
//                          store them as separate (large) zip entries.
//
// PURE: `fflate` function-form API only (zipSync/unzipSync) — no DOM, no Worker
// — so it is fully unit-testable + safe to call anywhere. Round-trips exactly.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

/** Arbitrarily reject videos larger than this on upload/import (per spec). */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB

const FORMAT = 'toybox-preset-v1';
const PRESET_JSON = 'preset.json';
const MEDIA_DIR = 'media/';

/** A single layer's loaded video, resolved to raw bytes for the bundle. */
export interface ToyboxPresetVideo {
  /** Layer index (0..3) this video belongs to. */
  layer: number;
  /** Original filename (for the in-zip path + restore display). */
  name: string;
  /** Raw video bytes. */
  bytes: Uint8Array;
}

/** Everything needed to reconstruct a TOYBOX node: its node.data blob + the
 *  out-of-band video bytes. */
export interface ToyboxPresetBundle {
  /** The VERBATIM toybox node.data (layers/combine/cvRoutes/cvInputs/…). */
  data: Record<string, unknown>;
  /** Per-layer loaded videos (empty if none). */
  videos: ToyboxPresetVideo[];
  /** Human label for the preset. */
  label?: string;
  /** Epoch-ms stamp (caller supplies; this module never reads the clock). */
  savedAt?: number;
}

interface VideoEntry {
  layer: number;
  name: string;
  path: string;
}
interface PresetManifest {
  format: string;
  label: string;
  savedAt: number;
  data: Record<string, unknown>;
  videos: VideoEntry[];
}

/** Filesystem-safe in-zip filename fragment. */
function sanitize(name: string): string {
  return (name || 'video').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/** Build the `.zip` bytes for a TOYBOX preset bundle. Deterministic for a fixed
 *  input (no clock/random read here — `savedAt` is taken from the bundle). */
export function exportToyboxPreset(bundle: ToyboxPresetBundle): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const videos: VideoEntry[] = bundle.videos.map((v, i) => ({
    layer: v.layer,
    name: v.name,
    // include `i` so two videos with the same name on different layers don't collide
    path: `${MEDIA_DIR}video-${v.layer}-${i}-${sanitize(v.name)}`,
  }));
  const manifest: PresetManifest = {
    format: FORMAT,
    label: bundle.label ?? 'TOYBOX preset',
    savedAt: bundle.savedAt ?? 0,
    data: bundle.data,
    videos,
  };
  files[PRESET_JSON] = strToU8(JSON.stringify(manifest));
  bundle.videos.forEach((v, i) => {
    files[videos[i]!.path] = v.bytes;
  });
  return zipSync(files);
}

/** Parse a TOYBOX preset `.zip` back into a bundle. Throws a user-surfaceable
 *  message on an empty/corrupt/foreign zip. Oversized videos are rejected. */
export function importToyboxPreset(zip: ArrayBuffer | Uint8Array): ToyboxPresetBundle {
  const bytes = zip instanceof Uint8Array ? zip : new Uint8Array(zip);
  if (bytes.length === 0) throw new Error('TOYBOX preset zip is empty');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new Error(`TOYBOX preset zip is corrupt: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pj = entries[PRESET_JSON];
  if (!pj) throw new Error('TOYBOX preset zip is missing preset.json (not a TOYBOX preset?)');
  let manifest: PresetManifest;
  try {
    manifest = JSON.parse(strFromU8(pj)) as PresetManifest;
  } catch (e) {
    throw new Error(`TOYBOX preset.json is invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (manifest.format !== FORMAT) {
    throw new Error(`TOYBOX preset format '${manifest.format}' is unsupported (expected ${FORMAT})`);
  }
  if (!manifest.data || typeof manifest.data !== 'object') {
    throw new Error('TOYBOX preset.json has no `data` blob');
  }
  const videos: ToyboxPresetVideo[] = [];
  for (const v of manifest.videos ?? []) {
    const vbytes = entries[v.path];
    if (!vbytes) continue; // referenced media missing → skip (layer falls back to empty)
    if (vbytes.length > MAX_VIDEO_BYTES) {
      throw new Error(`TOYBOX preset video '${v.name}' is ${(vbytes.length / 1048576).toFixed(0)} MB — exceeds the 50 MB limit`);
    }
    videos.push({ layer: v.layer, name: v.name, bytes: vbytes });
  }
  return { data: manifest.data, videos, label: manifest.label, savedAt: manifest.savedAt };
}

/** True if `bytes` looks like a TOYBOX preset zip (cheap pre-check before a full
 *  import — peeks for the preset.json entry). */
export function isToyboxPresetZip(zip: ArrayBuffer | Uint8Array): boolean {
  try {
    const bytes = zip instanceof Uint8Array ? zip : new Uint8Array(zip);
    if (bytes.length === 0) return false;
    const entries = unzipSync(bytes);
    return !!entries[PRESET_JSON];
  } catch {
    return false;
  }
}
