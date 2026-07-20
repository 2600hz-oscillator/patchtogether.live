// packages/web/src/lib/video/frametable-file-store.ts
//
// Per-browser persistence for FRAMETABLE atlas files (`.frametable.png` bytes).
//
// A loaded/saved frametable is ~45 MiB of frames encoded as a lossless PNG
// sprite-sheet — FAR too big for the Y.Doc (putting it there would storm the
// document with multi-megabyte updates + leak heap, the
// `cv-modulation-live-store-write-storm` / heavy-payload discipline). So the
// PNG BYTES live in THIS browser's IndexedDB, keyed by a stable id, and only a
// tiny (~120-byte) descriptor — `{ id, name, cols, rows, tileW, tileH, frames,
// size }` — goes into `node.data.frametableFile` (safe to sync). On mount the
// card re-hydrates from IndexedDB by that id (the VIDEOBOX pattern).
//
// Cloned from video-file-store.ts and deliberately:
//   * dependency-free (raw IndexedDB, no idb-keyval / no uuid lib),
//   * feature-detected (every entry point no-ops / returns null when IndexedDB
//     is unavailable — Firefox private mode / SSR / node unit tests), and
//   * never-throws on the missing-API path (callers `await` unconditionally and
//     fall back to the re-link drop-zone).
//
// The bytes are PER-BROWSER and NEVER synced across peers: a rack-mate who
// reloads on another machine gets `null` back and sees the file input to
// re-load the atlas locally — mirroring VIDEOBOX's "peers without a local copy
// show the placeholder". A blob record is structured-clone-safe (unlike a
// method-bearing FileSystemFileHandle), so it stores + reloads directly.

const DB_NAME = 'patchtogether-frametable-files';
const DB_VERSION = 1;
const STORE = 'frametables';

/** The tiny descriptor stamped into `node.data.frametableFile` (NO bytes). */
export interface FrametableFileMeta {
  /** IndexedDB key for the atlas PNG bytes in THIS browser. */
  id: string;
  /** Original / suggested file name (for the status line + re-save). */
  name: string;
  /** Fixed atlas grid (10×6). */
  cols: number;
  rows: number;
  /** Inferred tile size (atlasW/cols × atlasH/rows). */
  tileW: number;
  tileH: number;
  /** Frame count (= 60). */
  frames: number;
  /** PNG byte size (for the status line / diagnostics). */
  size: number;
}

/** A reloaded atlas record: the PNG blob + its name. */
export interface FrametableBlobRecord {
  blob: Blob;
  name: string;
}

/** True when IndexedDB itself is usable (the storage substrate). */
function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** True when frametable atlases can be persisted this session (IndexedDB present). */
export function canPersistFrametableFiles(): boolean {
  return hasIndexedDB();
}

/** Generate a stable id for a freshly-loaded / saved atlas. */
export function newFrametableFileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for runtimes without crypto.randomUUID (very old / partial envs).
  return `ftbl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
 * Store the atlas PNG `blob` under `id`. No-op (resolves) when IndexedDB is
 * absent so callers don't have to guard. Swallows store errors — a failed
 * persist just degrades to the re-load prompt next time (the safe fallback,
 * not a crash). Stored as a tagged, structured-clone-safe record.
 */
export async function putFrametableBlob(id: string, blob: Blob, name: string): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ __ftbl: true, blob, name }, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('put aborted'));
    });
    db.close();
  } catch {
    // Quota / structured-clone refusal → degrade silently.
  }
}

/**
 * Look up an atlas by `id`. Returns `null` when IndexedDB is unavailable, the
 * id isn't present in THIS browser, or any read error occurs — the signal for
 * the card to show the re-load drop-zone.
 */
export async function getFrametableBlob(id: string): Promise<FrametableBlobRecord | null> {
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
    const rec = result as { __ftbl?: unknown; blob?: unknown; name?: unknown };
    if (rec.__ftbl === true && rec.blob instanceof Blob) {
      const name = typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : 'frametable';
      return { blob: rec.blob, name };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove a stored atlas. No-op when IndexedDB is absent. Used when a file is
 * replaced (so a stale atlas doesn't linger) — best-effort.
 */
export async function deleteFrametableBlob(id: string): Promise<void> {
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
