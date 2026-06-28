// packages/web/src/lib/blood/blood-data-store.test.ts
//
// Unit tests for the in-browser Blood DATA IndexedDB cache (the hosted-preview
// loader: the owner picks proprietary RFFs in the browser; we persist the raw
// bytes so they only pick once). Vitest runs in node (no real IndexedDB), so we
//   * exercise the missing-API fallbacks directly (no indexedDB defined), and
//   * install a tiny in-memory IndexedDB shim covering exactly the slice this
//     module uses: open→onupgradeneeded→createObjectStore; transaction→
//     objectStore→put/getAll/getAllKeys/count/clear; oncomplete/onerror.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  canonicalBloodName,
  putBloodFiles,
  getBloodFiles,
  hasBloodFiles,
  clearBloodFiles,
} from './blood-data-store';

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
                clear() {
                  s.data.clear();
                  queueMicrotask(() => tx.oncomplete?.());
                  return {};
                },
                getAllKeys() {
                  const r: { result?: unknown } = {};
                  // Set the result synchronously so it is present whenever
                  // tx.oncomplete fires (real IDB guarantees results are ready
                  // before oncomplete). The module calls getAllKeys() then
                  // getAll() in the same tx and reads both inside oncomplete.
                  r.result = Array.from(s.data.keys());
                  return r;
                },
                getAll() {
                  const r: { result?: unknown } = {};
                  r.result = Array.from(s.data.values());
                  // getAll is the last read queued in the tx → fire completion.
                  queueMicrotask(() => tx.oncomplete?.());
                  return r;
                },
                count() {
                  const r: { result?: number; onsuccess?: () => void; onerror?: () => void } = {};
                  queueMicrotask(() => {
                    r.result = s.data.size;
                    r.onsuccess?.();
                  });
                  return r;
                },
              };
            },
          };
          return tx;
        },
        close() {
          /* no-op */
        },
      };
      const req = makeRequest(() => db);
      queueMicrotask(() => {
        if (!stores.has('files')) req.onupgradeneeded?.();
      });
      return req;
    },
  };
}

const g = globalThis as Record<string, unknown>;

describe('blood-data-store: canonicalBloodName', () => {
  it('uppercases the filename', () => {
    expect(canonicalBloodName('blood.rff')).toBe('BLOOD.RFF');
    expect(canonicalBloodName('Gui.Rff')).toBe('GUI.RFF');
  });

  it('strips any directory prefix a webkitdirectory pick carries', () => {
    expect(canonicalBloodName('Blood/BLOOD.RFF')).toBe('BLOOD.RFF');
    expect(canonicalBloodName('my games\\blood\\sounds.rff')).toBe('SOUNDS.RFF');
  });
});

describe('blood-data-store: missing-API fallbacks', () => {
  beforeEach(() => {
    delete g.indexedDB;
  });

  it('never throws when indexedDB is absent', async () => {
    await expect(putBloodFiles([{ name: 'BLOOD.RFF', bytes: new Uint8Array([1]) }])).resolves.toBeUndefined();
    await expect(getBloodFiles()).resolves.toEqual([]);
    await expect(hasBloodFiles()).resolves.toBe(false);
    await expect(clearBloodFiles()).resolves.toBeUndefined();
  });
});

describe('blood-data-store: with a fake IndexedDB', () => {
  beforeEach(() => {
    g.indexedDB = makeFakeIndexedDB() as unknown as IDBFactory;
  });
  afterEach(() => {
    delete g.indexedDB;
  });

  it('round-trips files by canonical name (put → getAll)', async () => {
    await putBloodFiles([
      { name: 'blood.rff', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'GUI.RFF', bytes: new Uint8Array([4, 5]) },
    ]);
    const got = await getBloodFiles();
    const byName = new Map(got.map((f) => [f.name, f.bytes]));
    expect(byName.has('BLOOD.RFF')).toBe(true); // canonicalised on store
    expect(byName.has('GUI.RFF')).toBe(true);
    expect(Array.from(byName.get('BLOOD.RFF')!)).toEqual([1, 2, 3]);
    expect(Array.from(byName.get('GUI.RFF')!)).toEqual([4, 5]);
  });

  it('hasBloodFiles reflects presence', async () => {
    expect(await hasBloodFiles()).toBe(false);
    await putBloodFiles([{ name: 'BLOOD.RFF', bytes: new Uint8Array([1]) }]);
    expect(await hasBloodFiles()).toBe(true);
  });

  it('clearBloodFiles wipes the cache', async () => {
    await putBloodFiles([{ name: 'BLOOD.RFF', bytes: new Uint8Array([1]) }]);
    expect(await hasBloodFiles()).toBe(true);
    await clearBloodFiles();
    expect(await hasBloodFiles()).toBe(false);
    expect(await getBloodFiles()).toEqual([]);
  });

  it('stores an exactly-sized copy (a subarray view does not drag its parent)', async () => {
    const parent = new Uint8Array([10, 20, 30, 40, 50]);
    const view = parent.subarray(1, 3); // [20, 30]
    await putBloodFiles([{ name: 'SOUNDS.RFF', bytes: view }]);
    const got = await getBloodFiles();
    const f = got.find((x) => x.name === 'SOUNDS.RFF')!;
    expect(Array.from(f.bytes)).toEqual([20, 30]);
  });
});
