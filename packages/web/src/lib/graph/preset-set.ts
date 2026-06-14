// packages/web/src/lib/graph/preset-set.ts
//
// The portable ".set" container — a ZIP-OF-ZIPS that bundles the five quick-
// switch preset SLOTS (each a whole-rack performance `.zip`, see
// performance-zip.ts) into ONE file, PLUS the global MIDI mapping.
//
// WHY a separate container (vs just the per-slot .zip): the slot bar lets a
// performer pre-load up to five performances and jump between them live. A
// `.set` lets them carry that WHOLE bar — all five performances + their shared
// MIDI Learn map — as a single file to another machine / show.
//
// FORMAT (versioned). The .set is itself a zip:
//   set.json                     — manifest (this module's SetManifest)
//   slots/slot-<i>.ptperf.zip    — the performance .zip bytes for slot i (0..4),
//                                   ONE entry per OCCUPIED slot (empty slots are
//                                   simply absent from the manifest + the zip).
// The manifest lists, per occupied slot: its index, the in-zip filename, and an
// optional display label; plus the device-agnostic MIDI Learn bindings (the same
// MidiBindingExport[] performance-bundle.ts carries) so the mapping rides along
// even if no single slot happened to capture it.
//
// PURE: `fflate` function-form only (zipSync / unzipSync) — no DOM, no IDB, no
// clock read (savedAt is supplied). Fully unit-testable; round-trips exactly.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { MidiBindingExport } from './performance-bundle';

/** Number of quick-switch slots in the bar (1..5, stored 0-indexed). */
export const SLOT_COUNT = 5;

export const SET_FORMAT = 'pt-set-v1';
const MANIFEST_JSON = 'set.json';
const SLOTS_DIR = 'slots/';

/** One occupied slot, as it lives in a `.set` (the perf-zip bytes + meta). */
export interface SetSlot {
  /** 0-based slot index (0..SLOT_COUNT-1). */
  index: number;
  /** The whole-rack performance `.zip` bytes for this slot (a buildPerformanceZip output). */
  zipBytes: Uint8Array;
  /** Optional human label (e.g. the original filename); display only. */
  label?: string;
}

/** Everything a `.set` carries: the occupied slots + the shared MIDI map. */
export interface PresetSet {
  /** Occupied slots ONLY (empty slots are omitted). Order is not significant —
   *  each slot carries its own `index`. */
  slots: SetSlot[];
  /** Global MIDI Learn bindings (device-agnostic). May be empty. */
  midiBindings: MidiBindingExport[];
  /** Epoch-ms stamp (caller supplies; this module never reads the clock). */
  savedAt?: number;
}

/** In-manifest descriptor for one occupied slot (bytes live at `path`). */
interface SlotEntry {
  index: number;
  label?: string;
  path: string;
}

interface SetManifest {
  format: string;
  savedAt: number;
  slots: SlotEntry[];
  midiBindings: MidiBindingExport[];
}

/** Filesystem-safe in-zip filename fragment. */
function sanitize(name: string): string {
  return (name || 'slot').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/**
 * Build the `.set` bytes from the occupied slots + MIDI map. Deterministic for
 * a fixed input (no clock/random read — `savedAt` is supplied). Slots are
 * de-duplicated by index (last one wins) and sorted by index for a stable zip.
 */
export function buildSet(input: PresetSet): Uint8Array {
  // De-dup by index, then sort, so the container is deterministic.
  const byIndex = new Map<number, SetSlot>();
  for (const s of input.slots) {
    if (!Number.isInteger(s.index) || s.index < 0 || s.index >= SLOT_COUNT) continue;
    if (!(s.zipBytes instanceof Uint8Array) || s.zipBytes.length === 0) continue;
    byIndex.set(s.index, s);
  }
  const slots = [...byIndex.values()].sort((a, b) => a.index - b.index);

  const files: Record<string, Uint8Array> = {};
  const entries: SlotEntry[] = slots.map((s) => {
    const path = `${SLOTS_DIR}slot-${s.index}-${sanitize(s.label ?? '')}.ptperf.zip`;
    files[path] = s.zipBytes;
    return { index: s.index, label: s.label, path };
  });

  const manifest: SetManifest = {
    format: SET_FORMAT,
    savedAt: input.savedAt ?? 0,
    slots: entries,
    midiBindings: input.midiBindings ?? [],
  };
  files[MANIFEST_JSON] = strToU8(JSON.stringify(manifest));
  return zipSync(files);
}

/**
 * Parse a `.set` back into its occupied slots + MIDI map. Throws a
 * user-surfaceable message on an empty / corrupt / foreign container. A slot
 * whose referenced perf-zip bytes are missing from the container is skipped
 * (the slot simply stays empty on load).
 */
export function parseSet(set: ArrayBuffer | Uint8Array): PresetSet {
  const bytes = set instanceof Uint8Array ? set : new Uint8Array(set);
  if (bytes.length === 0) throw new Error('Set file is empty');

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new Error(`Set file is corrupt: ${e instanceof Error ? e.message : String(e)}`);
  }

  const mj = entries[MANIFEST_JSON];
  if (!mj) {
    throw new Error('Set file is missing set.json (not a .set bundle?)');
  }
  let manifest: SetManifest;
  try {
    manifest = JSON.parse(strFromU8(mj)) as SetManifest;
  } catch (e) {
    throw new Error(`set.json is invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (manifest.format !== SET_FORMAT) {
    throw new Error(`Set format '${manifest.format}' is unsupported (expected ${SET_FORMAT})`);
  }

  const slots: SetSlot[] = [];
  const seen = new Set<number>();
  for (const e of manifest.slots ?? []) {
    if (!e || !Number.isInteger(e.index) || e.index < 0 || e.index >= SLOT_COUNT) continue;
    if (seen.has(e.index)) continue; // first wins on a duplicate index
    const zipBytes = entries[e.path];
    if (!zipBytes || zipBytes.length === 0) continue; // referenced slot bytes missing → skip
    seen.add(e.index);
    slots.push({ index: e.index, zipBytes, label: typeof e.label === 'string' ? e.label : undefined });
  }
  slots.sort((a, b) => a.index - b.index);

  return {
    slots,
    midiBindings: Array.isArray(manifest.midiBindings) ? manifest.midiBindings : [],
    savedAt: typeof manifest.savedAt === 'number' ? manifest.savedAt : undefined,
  };
}

/** True if `bytes` looks like a `.set` (cheap pre-check — peeks for set.json). */
export function isSet(set: ArrayBuffer | Uint8Array): boolean {
  try {
    const bytes = set instanceof Uint8Array ? set : new Uint8Array(set);
    if (bytes.length === 0) return false;
    const entries = unzipSync(bytes);
    return !!entries[MANIFEST_JSON];
  } catch {
    return false;
  }
}
