// packages/web/src/lib/video/recorderbox-store.ts
//
// RECORDERBOX crash-recovery store. Two cooperating pieces of per-browser,
// origin-local persistence:
//
//   1. OPFS (Origin Private File System) — the SCRATCH disk. While recording,
//      MP4 fragments are streamed to a real on-disk file under
//      `recorderbox/<nodeId>-<startEpoch>.mp4` via a dedicated Worker holding
//      a `FileSystemSyncAccessHandle` (the one browser API that writes real
//      disk synchronously + survives a tab crash). This module owns the
//      path-naming + directory bootstrap; the actual byte writes live in the
//      Worker (recorderbox-opfs-worker.ts) because SyncAccessHandle is
//      worker-only.
//
//   2. IndexedDB — the MANIFEST sidecar. One record per in-flight recording:
//      `{ nodeId, filename, startedAt, mime, opfsPath, status }`. On mount the
//      card scans for `status:'recording'` rows and offers a "recover unsaved
//      recording?" prompt — the manifest tells it WHICH OPFS file holds the
//      bytes + what to name the saved file. A fragmented MP4 is playable even
//      if the final `finalize()` never ran (the crash case), which is the
//      whole point of `fastStart:'fragmented'`.
//
// Everything here is:
//   * dependency-free (raw IndexedDB + the OPFS navigator API),
//   * feature-detected (no-ops / returns null where OPFS or IndexedDB is
//     absent — Firefox/Safari/SSR/node unit tests), and
//   * never-throws on the missing-API path (callers await unconditionally).
//
// Recovery is THIS-MACHINE/BROWSER ONLY: OPFS is origin-local and does NOT
// sync to collaborators, by design (recording a multi-megabyte MP4 into the
// Y.Doc would be absurd). A rack-mate who reloads sees no recovery prompt —
// only the browser that did the recording does.

export type RecorderboxManifestStatus = 'recording' | 'done';

export interface RecorderboxManifest {
  /** The RECORDERBOX node id this recording belongs to. */
  nodeId: string;
  /** The user-chosen output filename (without forced extension). */
  filename: string;
  /** Epoch ms when Record was toggled ON — also the OPFS path discriminator. */
  startedAt: number;
  /** Container MIME of the scratch file (e.g. 'video/mp4'). */
  mime: string;
  /** The OPFS path the fragments were streamed to. */
  opfsPath: string;
  /** 'recording' = in flight (recover candidate); 'done' = finalized + saved. */
  status: RecorderboxManifestStatus;
}

const DB_NAME = 'patchtogether-recorderbox';
const DB_VERSION = 1;
const STORE = 'manifests';
/** The OPFS sub-directory all scratch recordings live under. */
export const OPFS_DIR = 'recorderbox';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no browser API touched)
// ---------------------------------------------------------------------------

/** Build the per-recording OPFS scratch path. Deterministic from
 *  (nodeId, startEpoch) so the Worker + the manifest + the recovery scan all
 *  agree on the same file. The nodeId is sanitized to a filesystem-safe slug
 *  (node ids are uuid-ish but we never assume). */
export function opfsScratchPath(nodeId: string, startEpoch: number): string {
  const slug = String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'node';
  return `${OPFS_DIR}/${slug}-${startEpoch}.mp4`;
}

/** Sanitize a user-typed filename into a safe download name with the right
 *  extension. Strips path separators + control chars, collapses whitespace,
 *  caps length, and appends the container extension if missing. Empty / all-
 *  stripped input falls back to a timestamped default. */
export function sanitizeRecordingFilename(
  raw: string | undefined | null,
  ext: 'mp4' | 'webm' = 'mp4',
  now: Date = new Date(),
): string {
  const dotExt = `.${ext}`;
  let name = (raw ?? '').trim();
  // Strip directory separators + filesystem-hostile chars + control chars.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();
  // Drop a trailing extension the user may have typed (any case) so we can
  // re-append the canonical one without doubling it.
  name = name.replace(/\.(mp4|webm|mov|m4v)$/i, '');
  name = name.slice(0, 120).trim();
  if (!name) {
    const pad = (n: number) => String(n).padStart(2, '0');
    name = `recording-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }
  return `${name}${dotExt}`;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/** True when OPFS (the SCRATCH/recovery substrate) is available. Requires
 *  navigator.storage.getDirectory AND a Worker (the SyncAccessHandle writer
 *  is worker-only). Firefox has OPFS but historically lacked SyncAccessHandle
 *  off the main thread on some versions — the Worker probe inside the writer
 *  degrades gracefully if so. */
export function hasOpfs(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof Worker !== 'undefined'
  );
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** True when the browser can write the final file via the File System Access
 *  picker (Chromium). Firefox/Safari fall back to the <a download> blob path,
 *  mirroring VIDEOBOX's export. */
export function canSaveViaPicker(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
  );
}

// ---------------------------------------------------------------------------
// IndexedDB manifest CRUD (best-effort, never-throws)
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Keyed by opfsPath (the unique per-recording discriminator).
        db.createObjectStore(STORE, { keyPath: 'opfsPath' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

/** Write (or overwrite) a manifest record. No-op when IndexedDB is absent. */
export async function putManifest(m: RecorderboxManifest): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(m);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('put aborted'));
    });
    db.close();
  } catch {
    // Degrade silently — losing the manifest just means no recovery prompt,
    // not a crash.
  }
}

/** Mark a recording finalized (so the recovery scan ignores it). Best-effort. */
export async function markManifestDone(opfsPath: string): Promise<void> {
  const existing = await getManifest(opfsPath);
  if (!existing) return;
  await putManifest({ ...existing, status: 'done' });
}

/** Read one manifest by its OPFS path. Null when absent / unreadable. */
export async function getManifest(opfsPath: string): Promise<RecorderboxManifest | null> {
  if (!hasIndexedDB()) return null;
  try {
    const db = await openDb();
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(opfsPath);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('get failed'));
    });
    db.close();
    return (result as RecorderboxManifest) ?? null;
  } catch {
    return null;
  }
}

/** List all manifests still in `status:'recording'` — the recover candidates.
 *  Optionally filtered to a single nodeId (the card scans for its own id). */
export async function listRecoverable(nodeId?: string): Promise<RecorderboxManifest[]> {
  if (!hasIndexedDB()) return [];
  try {
    const db = await openDb();
    const all = await new Promise<RecorderboxManifest[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as RecorderboxManifest[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error('getAll failed'));
    });
    db.close();
    return all.filter(
      (m) => m && m.status === 'recording' && (nodeId === undefined || m.nodeId === nodeId),
    );
  } catch {
    return [];
  }
}

/** Delete a manifest record. Best-effort, no-op when IndexedDB absent. */
export async function deleteManifest(opfsPath: string): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(opfsPath);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('delete failed'));
    });
    db.close();
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// OPFS read / delete (main-thread side — reads are allowed on the main thread;
// only the SyncAccessHandle WRITE path must live in a Worker)
// ---------------------------------------------------------------------------

/** Resolve (creating intermediate dirs) the OPFS FileSystemFileHandle for a
 *  scratch path. Returns null when OPFS is unavailable or the file is missing
 *  (and create=false). */
async function resolveOpfsFile(
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle | null> {
  if (!hasOpfs()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return null;
    let dir: FileSystemDirectoryHandle = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return await dir.getFileHandle(fileName, { create });
  } catch {
    return null;
  }
}

/** Read the full bytes of an OPFS scratch recording. Null when absent. The
 *  recovery path reads this then hands it to the same save flow as a live
 *  finalize. */
export async function readOpfsBytes(path: string): Promise<Uint8Array | null> {
  const handle = await resolveOpfsFile(path, false);
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Delete an OPFS scratch recording (after a successful save, or when the user
 *  discards a recovery candidate). Best-effort. */
export async function deleteOpfsFile(path: string): Promise<void> {
  if (!hasOpfs()) return;
  try {
    const root = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return;
    let dir: FileSystemDirectoryHandle = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
    await dir.removeEntry(fileName);
  } catch {
    // already gone / unavailable — best-effort
  }
}
