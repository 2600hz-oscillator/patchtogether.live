// packages/web/src/lib/graph/preset-slot-store.test.ts
//
// Unit tests for the preset-slot IndexedDB store. Vitest runs in node (no real
// IndexedDB), so — exactly like video-file-store.test.ts — we:
//   * exercise the missing-API fallbacks (no indexedDB defined), and
//   * install a tiny in-memory IndexedDB shim (put/get/delete + getAllKeys, the
//     slice this module touches) to drive the put/get/clear/list round-trip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  putSlot,
  getSlot,
  clearSlot,
  listOccupied,
  type SlotRecord,
} from './preset-slot-store';
import { SLOT_COUNT } from './preset-set';

// ---------------- Minimal in-memory IndexedDB shim ----------------

interface ShimStore {
  data: Map<string, unknown>;
}

function makeFakeIndexedDB() {
  const stores = new Map<string, ShimStore>();

  function makeRequest<T>(run: () => T) {
    const req: {
      result?: T;
      error?: unknown;
      onsuccess?: () => void;
      onerror?: () => void;
      onupgradeneeded?: () => void;
    } = {};
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (e) {
        req.error = e;
        req.onerror?.();
      }
    });
    return req;
  }

  return {
    open(_name: string, _version?: number) {
      const db = {
        objectStoreNames: { contains: (n: string) => stores.has(n) },
        createObjectStore(n: string) {
          stores.set(n, { data: new Map() });
          return {};
        },
        transaction(_storeName: string, _mode?: string) {
          const tx: {
            oncomplete?: () => void;
            onerror?: () => void;
            onabort?: () => void;
            error?: unknown;
            objectStore: (n: string) => unknown;
          } = {
            objectStore(n: string) {
              const s = stores.get(n);
              if (!s) throw new Error(`no store ${n}`);
              return {
                put(value: unknown, key: string) {
                  s.data.set(key, value);
                  queueMicrotask(() => tx.oncomplete?.());
                  return {};
                },
                delete(key: string) {
                  s.data.delete(key);
                  queueMicrotask(() => tx.oncomplete?.());
                  return {};
                },
                get(key: string) {
                  const r: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
                  queueMicrotask(() => { r.result = s.data.get(key); r.onsuccess?.(); });
                  return r;
                },
                getAllKeys() {
                  const r: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
                  queueMicrotask(() => { r.result = [...s.data.keys()]; r.onsuccess?.(); });
                  return r;
                },
              };
            },
          };
          return tx;
        },
        close() { /* no-op */ },
      };
      const req = makeRequest(() => db);
      queueMicrotask(() => { if (!stores.has('slots')) req.onupgradeneeded?.(); });
      return req;
    },
  };
}

const g = globalThis as Record<string, unknown>;

function bytes(seed: number, len = 16): Uint8Array {
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = (seed + i) % 256;
  return a;
}

describe('preset-slot-store: missing-API fallbacks', () => {
  beforeEach(() => { delete g.indexedDB; });

  it('put/get/clear/list never throw when indexedDB is absent', async () => {
    await expect(putSlot(0, bytes(1))).resolves.toBeUndefined();
    await expect(getSlot(0)).resolves.toBeNull();
    await expect(clearSlot(0)).resolves.toBeUndefined();
    await expect(listOccupied()).resolves.toEqual(new Array(SLOT_COUNT).fill(false));
  });
});

describe('preset-slot-store: round-trip with the IDB shim', () => {
  beforeEach(() => { g.indexedDB = makeFakeIndexedDB(); });
  afterEach(() => { delete g.indexedDB; });

  it('stores + reads a slot byte-exactly with label', async () => {
    await putSlot(2, bytes(42, 64), 'show.ptperf.zip');
    const rec = await getSlot(2);
    expect(rec).not.toBeNull();
    expect((rec as SlotRecord).zipBytes).toEqual(bytes(42, 64));
    expect((rec as SlotRecord).label).toBe('show.ptperf.zip');
    expect((rec as SlotRecord).savedAt).toBeGreaterThan(0);
  });

  it('returns null for an empty slot', async () => {
    expect(await getSlot(4)).toBeNull();
  });

  it('clearSlot removes a stored slot (→ null)', async () => {
    await putSlot(1, bytes(7));
    expect(await getSlot(1)).not.toBeNull();
    await clearSlot(1);
    expect(await getSlot(1)).toBeNull();
  });

  it('listOccupied reflects which slots have content', async () => {
    await putSlot(0, bytes(1));
    await putSlot(3, bytes(2));
    const occ = await listOccupied();
    expect(occ).toEqual([true, false, false, true, false]);
  });

  it('rejects out-of-range indices (no write, null read)', async () => {
    await putSlot(-1, bytes(1));
    await putSlot(SLOT_COUNT, bytes(2));
    expect(await getSlot(-1)).toBeNull();
    expect(await getSlot(SLOT_COUNT)).toBeNull();
    expect(await listOccupied()).toEqual(new Array(SLOT_COUNT).fill(false));
  });

  it('overwrites a slot in place (put again)', async () => {
    await putSlot(0, bytes(1));
    await putSlot(0, bytes(99, 32), 'replaced');
    const rec = await getSlot(0);
    expect((rec as SlotRecord).zipBytes).toEqual(bytes(99, 32));
    expect((rec as SlotRecord).label).toBe('replaced');
  });
});
