// packages/web/src/lib/video/video-file-store.ts
//
// Per-browser persistence for File System Access `FileSystemFileHandle`s.
//
// Browsers can't serialize a file path into a patch (sandboxing) — but
// Chromium-family browsers CAN persist a `FileSystemFileHandle` (the
// object returned by `showOpenFilePicker()` / a drag-drop
// `DataTransferItem.getAsFileSystemHandle()`) into IndexedDB. A handle
// stored this way survives a reload and can be re-permissioned with a
// single user click (`handle.requestPermission()`), giving VIDEOBOX the
// "reopen the patch and the video comes back" behaviour on the same
// machine + browser.
//
// This module is the IDB side of that story: put / get / delete a handle
// keyed by a stable id (the same id we stamp into the patch JSON's
// fileMeta.handleId). It is deliberately:
//   * dependency-free (raw IndexedDB, no idb-keyval / no uuid lib),
//   * feature-detected (every entry point no-ops or returns null when
//     IndexedDB / File System Access is unavailable — Firefox / Safari /
//     SSR / unit tests in node), and
//   * never-throws on the missing-API path (callers can `await` it
//     unconditionally and fall back to the re-link prompt).
//
// The handle itself is per-browser/per-peer: it lives in THIS browser's
// IndexedDB only. The patch only carries the id + file metadata, which
// is shared across peers. A peer that doesn't have the handle (different
// machine, different browser, or never loaded the file) simply gets a
// `null` back from `getVideoFileHandle` and shows the re-link prompt —
// consistent with VIDEOBOX's existing "peers without a local copy show
// the placeholder" behaviour. We never sync handles across peers.

const DB_NAME = 'patchtogether-video-handles';
const DB_VERSION = 1;
const STORE = 'handles';

/**
 * The structural subset of `FileSystemFileHandle` we depend on. Declared
 * locally (rather than relying on lib.dom's `FileSystemFileHandle`, which
 * isn't present in every TS lib target) so this module type-checks in the
 * node-based unit build too. The browser's real handle satisfies this.
 */
export interface StoredFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  // Permission API — Chromium only. Optional so a structurally-typed mock
  // (or an older handle) still satisfies the interface.
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/**
 * True when this runtime can persist file handles: IndexedDB exists AND
 * the File System Access entry point (`showOpenFilePicker`) is present.
 * We gate on BOTH because there's no point storing a handle in IDB if the
 * browser can never produce one. Firefox/Safari fail this and use the
 * re-link prompt path exclusively.
 */
export function canPersistVideoHandles(): boolean {
  return (
    typeof indexedDB !== 'undefined' &&
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function'
  );
}

/** True when IndexedDB itself is usable (the storage half only). */
function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** Generate a stable id for a freshly-picked file. */
export function newVideoFileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for runtimes without crypto.randomUUID (very old / partial
  // environments). Collision-resistant enough for a per-browser keyspace.
  return `vfh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

/**
 * Store a handle under `id`. No-op (resolves) when IndexedDB is absent so
 * callers don't have to guard. Swallows store errors — a failure to
 * persist the handle just degrades to the re-link prompt next time, which
 * is the safe fallback, not a crash.
 */
export async function putVideoFileHandle(id: string, handle: StoredFileHandle): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('put aborted'));
    });
    db.close();
  } catch {
    // Structured-clone refusal (some embedded webviews can't clone a
    // handle) or quota errors land here — degrade silently.
  }
}

/**
 * Look up a handle by `id`. Returns `null` when IndexedDB is unavailable,
 * the id isn't present in THIS browser, or any read error occurs. A null
 * result is the signal for the card to show the re-link prompt.
 */
export async function getVideoFileHandle(id: string): Promise<StoredFileHandle | null> {
  if (!hasIndexedDB()) return null;
  try {
    const db = await openDb();
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('get failed'));
    });
    db.close();
    if (!result || typeof result !== 'object') return null;
    // Structural sanity check — a persisted handle exposes getFile().
    if (typeof (result as StoredFileHandle).getFile !== 'function') return null;
    return result as StoredFileHandle;
  } catch {
    return null;
  }
}

/**
 * Remove a stored handle. No-op when IndexedDB is absent. Used when a
 * file is replaced (so a stale handle doesn't linger) — best-effort.
 */
export async function deleteVideoFileHandle(id: string): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('delete failed'));
    });
    db.close();
  } catch {
    // best-effort
  }
}

/**
 * Format a byte count for the re-link prompt ("12.4 MB"). Pure; exported
 * for the card + unit tests. Uses binary units (1024) to match what file
 * managers show. Returns "0 B" for 0 / undefined / non-finite input.
 */
export function formatFileSize(bytes: number | undefined | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // Whole bytes show no decimal; KB+ show one decimal place.
  const formatted = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted} ${units[unit]}`;
}

/**
 * Read the current read-permission state of a handle without prompting.
 * Returns 'granted' / 'prompt' / 'denied'. Falls back to 'prompt' when the
 * Permissions-on-handle API is missing (so the card surfaces the one-click
 * re-allow affordance rather than assuming access).
 */
export async function queryHandleReadPermission(handle: StoredFileHandle): Promise<PermissionState> {
  if (typeof handle.queryPermission !== 'function') return 'prompt';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch {
    return 'prompt';
  }
}

/**
 * Request read permission for a handle. MUST be called inside a user
 * gesture (click). Returns the resulting state. Falls back to 'denied'
 * when the API is missing or the request rejects — the caller then shows
 * the re-link prompt.
 */
export async function requestHandleReadPermission(handle: StoredFileHandle): Promise<PermissionState> {
  if (typeof handle.requestPermission !== 'function') return 'denied';
  try {
    return await handle.requestPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}
