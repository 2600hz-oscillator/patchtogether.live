// packages/web/src/lib/graph/performance-store.ts
//
// Named "performance slot" persistence for the Save/Load Local Performance
// feature (.myrobots/plans/save-load-local-performance.md §4b).
//
// A performance slot is the whole "complete track": the PerformanceBundle
// (patch envelope + positions + inline images/samples + midi/gamepad
// metadata), stored in IndexedDB keyed by a user-chosen slot NAME. The actual
// file-backed VIDEOBOX handles are NOT duplicated here — they already live in
// the existing `patchtogether-video-handles` DB (video-file-store.ts) keyed by
// `handleId`, and the bundle's envelope carries that handleId. So a slot just
// references them; re-loading a slot on the SAME browser profile re-acquires
// the video via the existing #102 handle + re-grant path automatically.
//
// We optionally also store ONE FileSystemDirectoryHandle per slot (the
// design's "single dir handle" recommendation) for a future one-permission
// re-resolve of all assets under a folder. Phase 1 records it when the user
// opts in but the per-file #102 handle path remains the working default, so
// the dir handle is forward-looking plumbing, not a hard dependency.
//
// Discipline mirrors video-file-store.ts exactly:
//   * dependency-free raw IndexedDB,
//   * feature-detected (no-ops / returns empty when IDB is unavailable —
//     Firefox-without-IDB / SSR / node unit tests), and
//   * never-throws on the storage path (callers await unconditionally).

import type { PerformanceBundle } from './performance-bundle';
import type { StoredFileHandle } from '$lib/video/video-file-store';

const DB_NAME = 'patchtogether-performances';
const DB_VERSION = 1;
const SLOTS_STORE = 'slots';
const DIRS_STORE = 'dirHandles';

/** Structural subset of FileSystemDirectoryHandle we depend on. Declared
 *  locally so this module type-checks under the node unit build (lib.dom may
 *  not expose it). The browser's real handle satisfies it. */
export interface StoredDirHandle {
  readonly kind: 'directory';
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<StoredFileHandle>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** A saved slot as returned to the UI (bundle + metadata, no handles). */
export interface PerformanceSlotRecord {
  name: string;
  bundle: PerformanceBundle;
  savedAt: string;
}

/** Lightweight slot listing entry for the Load picker. */
export interface PerformanceSlotInfo {
  name: string;
  savedAt: string;
  /** Count of file-backed (VIDEOBOX) assets, for the picker summary. */
  assetCount: number;
  /** True if a directory handle is stored for this slot. */
  hasDirHandle: boolean;
}

/** True when this runtime can persist performance slots at all (IndexedDB). */
export function canPersistPerformances(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** True when the browser can persist + re-acquire file handles — the full
 *  "video comes back on reload" path (Chromium). Mirrors
 *  video-file-store's `canPersistVideoHandles` gate. */
export function canReacquireFileHandles(): boolean {
  return (
    typeof indexedDB !== 'undefined' &&
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function'
  );
}

/** True when the browser supports the directory picker (single-dir-handle
 *  path). Chromium-only; absent in Firefox + most Safari. */
export function canPickDirectory(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SLOTS_STORE)) db.createObjectStore(SLOTS_STORE);
      if (!db.objectStoreNames.contains(DIRS_STORE)) db.createObjectStore(DIRS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

/**
 * Write (create or overwrite) a named performance slot. No-op when IndexedDB
 * is absent. Swallows store errors (degrades to "save didn't stick" rather
 * than a crash). Returns true on a confirmed write, false otherwise.
 */
export async function savePerformanceSlot(
  name: string,
  bundle: PerformanceBundle,
): Promise<boolean> {
  if (!hasIndexedDB()) return false;
  const record: PerformanceSlotRecord = { name, bundle, savedAt: bundle.savedAt };
  try {
    const db = await openDb();
    const ok = await new Promise<boolean>((resolve) => {
      const tx = db.transaction(SLOTS_STORE, 'readwrite');
      tx.objectStore(SLOTS_STORE).put(record, name);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
    db.close();
    return ok;
  } catch {
    return false;
  }
}

/** Load a named slot's full record. Returns null when absent / IDB missing. */
export async function loadPerformanceSlot(name: string): Promise<PerformanceSlotRecord | null> {
  if (!hasIndexedDB()) return null;
  try {
    const db = await openDb();
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(SLOTS_STORE, 'readonly');
      const req = tx.objectStore(SLOTS_STORE).get(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('get failed'));
    });
    db.close();
    if (!result || typeof result !== 'object') return null;
    const rec = result as PerformanceSlotRecord;
    if (!rec.bundle || typeof rec.bundle !== 'object') return null;
    return rec;
  } catch {
    return null;
  }
}

/** List all saved slots (newest first). Returns [] on any error / no IDB. */
export async function listPerformanceSlots(): Promise<PerformanceSlotInfo[]> {
  if (!hasIndexedDB()) return [];
  try {
    const db = await openDb();
    const [records, dirKeys] = await Promise.all([
      new Promise<PerformanceSlotRecord[]>((resolve, reject) => {
        const tx = db.transaction(SLOTS_STORE, 'readonly');
        const req = tx.objectStore(SLOTS_STORE).getAll();
        req.onsuccess = () => resolve((req.result ?? []) as PerformanceSlotRecord[]);
        req.onerror = () => reject(req.error ?? new Error('getAll failed'));
      }),
      new Promise<Set<string>>((resolve) => {
        const tx = db.transaction(DIRS_STORE, 'readonly');
        const req = tx.objectStore(DIRS_STORE).getAllKeys();
        req.onsuccess = () => resolve(new Set((req.result ?? []).map(String)));
        req.onerror = () => resolve(new Set());
      }),
    ]);
    db.close();
    return records
      .filter((r) => r && typeof r.name === 'string' && r.bundle)
      .map((r) => ({
        name: r.name,
        savedAt: r.savedAt ?? r.bundle.savedAt ?? '',
        assetCount: Array.isArray(r.bundle.assets) ? r.bundle.assets.length : 0,
        hasDirHandle: dirKeys.has(r.name),
      }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  } catch {
    return [];
  }
}

/** Delete a named slot + any directory handle stored for it. Best-effort. */
export async function deletePerformanceSlot(name: string): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction([SLOTS_STORE, DIRS_STORE], 'readwrite');
      tx.objectStore(SLOTS_STORE).delete(name);
      tx.objectStore(DIRS_STORE).delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    db.close();
  } catch {
    // best-effort
  }
}

// ---------------- Directory handle (single-dir-handle path) ----------------

/** Store a directory handle for a slot. Best-effort; structured-clone refusal
 *  or quota errors degrade silently to the per-file handle path. */
export async function putSlotDirHandle(name: string, handle: StoredDirHandle): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DIRS_STORE, 'readwrite');
      tx.objectStore(DIRS_STORE).put(handle, name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('put aborted'));
    });
    db.close();
  } catch {
    // degrade silently
  }
}

/** Get the directory handle for a slot, or null. */
export async function getSlotDirHandle(name: string): Promise<StoredDirHandle | null> {
  if (!hasIndexedDB()) return null;
  try {
    const db = await openDb();
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(DIRS_STORE, 'readonly');
      const req = tx.objectStore(DIRS_STORE).get(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('get failed'));
    });
    db.close();
    if (!result || typeof result !== 'object') return null;
    if (typeof (result as StoredDirHandle).getFileHandle !== 'function') return null;
    return result as StoredDirHandle;
  } catch {
    return null;
  }
}

/** Query a directory handle's read permission without prompting. */
export async function queryDirReadPermission(handle: StoredDirHandle): Promise<PermissionState> {
  if (typeof handle.queryPermission !== 'function') return 'prompt';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch {
    return 'prompt';
  }
}

/** Request read permission on a directory handle. MUST run in a user gesture. */
export async function requestDirReadPermission(handle: StoredDirHandle): Promise<PermissionState> {
  if (typeof handle.requestPermission !== 'function') return 'denied';
  try {
    return await handle.requestPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/** Sanitize a slot name (trim; reject empty). Returns null if unusable. */
export function sanitizeSlotName(input: string | null | undefined): string | null {
  const name = (input ?? '').trim();
  return name.length > 0 ? name : null;
}
