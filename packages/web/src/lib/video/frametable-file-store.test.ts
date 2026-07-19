// packages/web/src/lib/video/frametable-file-store.test.ts
//
// Unit tests for the FRAMETABLE atlas IndexedDB blob store. Vitest runs in node
// (no real IndexedDB), so we:
//   * exercise the missing-API fallbacks directly (no indexedDB defined), and
//   * install a tiny in-memory IndexedDB shim to drive the put/get/delete/miss
//     round-trip.
//
// The shim implements just the slice of IDB this module touches (open →
// onupgradeneeded → createObjectStore; transaction → objectStore →
// put/get/delete; oncomplete/onsuccess/onerror). Cloned from
// video-file-store.test.ts — intentionally NOT a general-purpose fake, to avoid
// a fake-indexeddb dep that isn't installed in this package.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  canPersistFrametableFiles,
  newFrametableFileId,
  putFrametableBlob,
  getFrametableBlob,
  deleteFrametableBlob,
} from './frametable-file-store';

const STORE_NAME = 'frametables';

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
        objectStoreNames: {
          contains: (n: string) => stores.has(n),
        },
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
                  queueMicrotask(() => {
                    r.result = s.data.get(key);
                    r.onsuccess?.();
                  });
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
      queueMicrotask(() => {
        if (!stores.has(STORE_NAME)) req.onupgradeneeded?.();
      });
      return req;
    },
  };
}

const g = globalThis as Record<string, unknown>;

describe('frametable-file-store: missing-API fallbacks', () => {
  beforeEach(() => {
    delete g.indexedDB;
  });

  it('canPersistFrametableFiles is false without indexedDB', () => {
    expect(canPersistFrametableFiles()).toBe(false);
  });

  it('put/get/delete never throw when indexedDB is absent', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await expect(putFrametableBlob('x', blob, 'a.frametable.png')).resolves.toBeUndefined();
    await expect(getFrametableBlob('x')).resolves.toBeNull();
    await expect(deleteFrametableBlob('x')).resolves.toBeUndefined();
  });
});

describe('frametable-file-store: with a fake IndexedDB', () => {
  beforeEach(() => {
    g.indexedDB = makeFakeIndexedDB() as unknown as IDBFactory;
  });
  afterEach(() => {
    delete g.indexedDB;
  });

  it('canPersistFrametableFiles is true when IndexedDB exists', () => {
    expect(canPersistFrametableFiles()).toBe(true);
  });

  it('round-trips a blob by id (put → get) preserving bytes + name', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
    const blob = new Blob([bytes], { type: 'image/png' });
    await putFrametableBlob('id-1', blob, 'my.frametable.png');
    const got = await getFrametableBlob('id-1');
    expect(got).not.toBeNull();
    expect(got?.name).toBe('my.frametable.png');
    const back = new Uint8Array(await got!.blob.arrayBuffer());
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it('returns null for an id never stored', async () => {
    expect(await getFrametableBlob('nope')).toBeNull();
  });

  it('deletes a stored blob', async () => {
    const blob = new Blob([new Uint8Array([9, 9])], { type: 'image/png' });
    await putFrametableBlob('id-2', blob, 'b.frametable.png');
    expect(await getFrametableBlob('id-2')).not.toBeNull();
    await deleteFrametableBlob('id-2');
    expect(await getFrametableBlob('id-2')).toBeNull();
  });

  it('falls back to a default name when the stored name is empty', async () => {
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    await putFrametableBlob('id-3', blob, '');
    const got = await getFrametableBlob('id-3');
    expect(got).not.toBeNull();
    expect(got?.name).toBe('frametable');
  });
});

describe('newFrametableFileId', () => {
  it('returns a distinct non-empty string each call', () => {
    const a = newFrametableFileId();
    const b = newFrametableFileId();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('falls back to a non-crypto id when randomUUID is unavailable', () => {
    const orig = (globalThis.crypto as { randomUUID?: unknown })?.randomUUID;
    // @ts-expect-error — intentionally clobber for the fallback path.
    if (globalThis.crypto) globalThis.crypto.randomUUID = undefined;
    try {
      const id = newFrametableFileId();
      expect(id.startsWith('ftbl-')).toBe(true);
    } finally {
      if (globalThis.crypto && orig) {
        (globalThis.crypto as { randomUUID?: unknown }).randomUUID = orig;
      }
    }
  });
});
