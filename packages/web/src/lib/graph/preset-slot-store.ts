// packages/web/src/lib/graph/preset-slot-store.ts
//
// IndexedDB persistence for the quick-switch PRESET SLOT bar (the five
// numbered buttons in the top-left of the menu bar).
//
// Each slot holds the raw bytes of a whole-rack performance `.zip`
// (buildPerformanceZip output). Performance zips can be MANY MB (they carry
// embedded images / video / samples), so they MUST NOT go in localStorage
// (which is ~5 MB total + synchronous + string-only). IndexedDB stores the
// Uint8Array bytes directly and asynchronously.
//
// This is APP / browser-PROFILE-level state — NOT node.data, NOT synced across
// peers. It is the performer's personal quick-switch bar, persisted so the
// loaded presets survive a reload on THIS browser.
//
// Mirrors the video-file-store.ts discipline:
//   * dependency-free (raw IndexedDB, no idb-keyval),
//   * feature-detected (no-ops / returns null when IndexedDB is absent — SSR,
//     unit tests in node), and
//   * never-throws on the missing-API / quota path (callers `await`
//     unconditionally and degrade gracefully).

import { SLOT_COUNT } from './preset-set';

const DB_NAME = 'patchtogether-preset-slots';
const DB_VERSION = 1;
const STORE = 'slots';

/** One persisted slot record (the perf-zip bytes + display meta). */
export interface SlotRecord {
  /** The whole-rack performance `.zip` bytes. */
  zipBytes: Uint8Array;
  /** Optional human label (original filename), display only. */
  label?: string;
  /** Epoch-ms the slot was stored. */
  savedAt: number;
}

/** True when IndexedDB itself is usable. */
function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** Validate a 0-based slot index (0..SLOT_COUNT-1). */
function validIndex(i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < SLOT_COUNT;
}

/** Per-slot IDB key. */
function keyFor(index: number): string {
  return `slot-${index}`;
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
 * Store the perf-zip bytes for a slot. No-op (resolves) when IndexedDB is
 * absent or the index is out of range. Swallows store errors (quota etc.) —
 * a failure just means the slot won't persist across reloads, not a crash.
 */
export async function putSlot(index: number, zipBytes: Uint8Array, label?: string): Promise<void> {
  if (!hasIndexedDB() || !validIndex(index)) return;
  try {
    const db = await openDb();
    const record: SlotRecord = { zipBytes, label, savedAt: Date.now() };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, keyFor(index));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('put aborted'));
    });
    db.close();
  } catch {
    // Quota / clone failure — degrade silently (slot just won't persist).
  }
}

/**
 * Read one slot's record. Returns null when IndexedDB is unavailable, the
 * index is out of range, the slot is empty, or any read error occurs.
 */
export async function getSlot(index: number): Promise<SlotRecord | null> {
  if (!hasIndexedDB() || !validIndex(index)) return null;
  try {
    const db = await openDb();
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(keyFor(index));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('get failed'));
    });
    db.close();
    if (!result || typeof result !== 'object') return null;
    const rec = result as { zipBytes?: unknown; label?: unknown; savedAt?: unknown };
    if (!(rec.zipBytes instanceof Uint8Array) || rec.zipBytes.length === 0) return null;
    return {
      zipBytes: rec.zipBytes,
      label: typeof rec.label === 'string' ? rec.label : undefined,
      savedAt: typeof rec.savedAt === 'number' ? rec.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Remove one slot's record. No-op when IndexedDB is absent. Best-effort. */
export async function clearSlot(index: number): Promise<void> {
  if (!hasIndexedDB() || !validIndex(index)) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(keyFor(index));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('delete failed'));
    });
    db.close();
  } catch {
    // best-effort
  }
}

/**
 * Read which slots are occupied, as a fixed-length boolean array (length
 * SLOT_COUNT). Cheap one-shot for the UI to colour the bar (red/green) on
 * mount without pulling the (potentially large) bytes. All-false when
 * IndexedDB is unavailable.
 */
export async function listOccupied(): Promise<boolean[]> {
  const occupied = new Array<boolean>(SLOT_COUNT).fill(false);
  if (!hasIndexedDB()) return occupied;
  try {
    const db = await openDb();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error ?? new Error('getAllKeys failed'));
    });
    db.close();
    for (const k of keys) {
      if (typeof k !== 'string') continue;
      const m = /^slot-(\d+)$/.exec(k);
      if (!m) continue;
      const i = Number(m[1]);
      if (validIndex(i)) occupied[i] = true;
    }
    return occupied;
  } catch {
    return occupied;
  }
}
