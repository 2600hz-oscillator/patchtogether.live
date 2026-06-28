// packages/web/src/lib/blood/blood-data-store.ts
//
// Per-browser persistence for USER-SUPPLIED Blood game data.
//
// Blood's game files (BLOOD.RFF / GUI.RFF / SOUNDS.RFF / *.ART / *.DAT) are
// proprietary + NOT redistributable (Warner Bros. owns the IP), so they can
// NEVER live on the server — locally `task setup:blood` drops them into
// static/blood/, but on the HOSTED preview the owner can't put them there.
//
// So the BLOOD card lets the owner pick their own data folder/files in the
// browser; we cache the raw bytes in IndexedDB keyed by (uppercased) filename
// so they only ever pick ONCE. On reload the runtime auto-restores from IDB
// and boots straight into the game — no re-pick.
//
// Mirrors the deliberate shape of video-file-store.ts:
//   * dependency-free raw IndexedDB (no idb-keyval),
//   * feature-detected (no-ops / returns empty when IndexedDB is absent —
//     SSR, node unit tests), and
//   * never-throws (callers can `await` unconditionally + fall back to the
//     in-card picker).
//
// We store INERT bytes (Uint8Array), which structured-clone into IDB fine
// (unlike a method-bearing FileSystemFileHandle). The bytes are
// per-browser/per-peer; we never sync them — exactly like the video handles.

const DB_NAME = 'patchtogether-blood-data';
const DB_VERSION = 1;
const STORE = 'files';

/** A user-supplied Blood data file: its (canonical) name + raw bytes. */
export interface BloodStoredFile {
  name: string; // canonical (uppercased) — e.g. 'BLOOD.RFF'
  bytes: Uint8Array;
}

/** Canonicalise a picked filename to the engine's expected casing. The Build
 *  resource loader looks for UPPERCASE names (BLOOD.RFF), but pickers/OSes hand
 *  us whatever case is on disk (blood.rff). Also strips any directory prefix a
 *  `webkitdirectory` pick carries (e.g. "Blood/BLOOD.RFF"). */
export function canonicalBloodName(rawName: string): string {
  const base = rawName.split(/[\\/]/).pop() ?? rawName;
  return base.toUpperCase();
}

/** True when IndexedDB itself is usable (SSR / node return false). */
function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
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
 * Persist a set of Blood data files (keyed by canonical filename). No-op when
 * IndexedDB is absent so callers don't have to guard. Swallows store errors
 * (quota / clone refusal) — a failed persist just means the owner re-picks next
 * reload, which is the safe fallback, not a crash.
 */
export async function putBloodFiles(files: BloodStoredFile[]): Promise<void> {
  if (!hasIndexedDB() || files.length === 0) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      for (const f of files) {
        // Store a fresh, exactly-sized copy so a Uint8Array that is a view onto
        // a larger ArrayBuffer doesn't drag the whole buffer into IDB.
        const copy = f.bytes.slice();
        os.put(copy, canonicalBloodName(f.name));
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('put aborted'));
    });
    db.close();
  } catch {
    // Quota / structured-clone failure → degrade to the in-card picker.
  }
}

/**
 * Load all persisted Blood data files from IndexedDB. Returns an empty array
 * when IndexedDB is unavailable, nothing is stored, or any read error occurs —
 * the signal for the card to show the "load your data" picker prompt.
 */
export async function getBloodFiles(): Promise<BloodStoredFile[]> {
  if (!hasIndexedDB()) return [];
  try {
    const db = await openDb();
    const out = await new Promise<BloodStoredFile[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const os = tx.objectStore(STORE);
      const keysReq = os.getAllKeys();
      const valsReq = os.getAll();
      tx.oncomplete = () => {
        const keys = keysReq.result as IDBValidKey[];
        const vals = valsReq.result as unknown[];
        const files: BloodStoredFile[] = [];
        for (let i = 0; i < keys.length; i++) {
          const name = String(keys[i]);
          const v = vals[i];
          if (v instanceof Uint8Array) files.push({ name, bytes: v });
          else if (v instanceof ArrayBuffer) files.push({ name, bytes: new Uint8Array(v) });
        }
        resolve(files);
      };
      tx.onerror = () => reject(tx.error ?? new Error('getAll failed'));
    });
    db.close();
    return out;
  } catch {
    return [];
  }
}

/** True if any Blood data is persisted in THIS browser. Cheap key-count probe. */
export async function hasBloodFiles(): Promise<boolean> {
  if (!hasIndexedDB()) return false;
  try {
    const db = await openDb();
    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('count failed'));
    });
    db.close();
    return count > 0;
  } catch {
    return false;
  }
}

/** Clear all persisted Blood data (so the owner can swap a bad/partial copy).
 *  No-op when IndexedDB is absent; best-effort. */
export async function clearBloodFiles(): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('clear failed'));
    });
    db.close();
  } catch {
    // best-effort
  }
}
