// packages/web/src/lib/video/video-file-store.test.ts
//
// Unit tests for the FileSystemFileHandle IndexedDB helper. Vitest runs in
// node (no real IndexedDB / no File System Access), so we:
//   * exercise the missing-API fallbacks directly (no indexedDB defined), and
//   * install a tiny in-memory IndexedDB shim to drive the put/get/delete
//     round-trip + the permission-query helpers.
//
// The shim implements just the slice of the IDB API this module touches
// (open → onupgradeneeded → createObjectStore; transaction → objectStore →
// put/get/delete; oncomplete/onsuccess/onerror). It is intentionally NOT a
// general-purpose fake — keeping it inline avoids a fake-indexeddb dep that
// isn't installed in this package.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  canPersistVideoHandles,
  newVideoFileId,
  putVideoFileHandle,
  getVideoFileHandle,
  deleteVideoFileHandle,
  queryHandleReadPermission,
  requestHandleReadPermission,
  formatFileSize,
  type StoredFileHandle,
} from './video-file-store';

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
    // Resolve on a microtask so handlers attached after the call still fire,
    // matching real IDB's async dispatch.
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
        transaction(storeName: string, _mode?: string) {
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
      // The store is created during the "upgrade" — fire it before success.
      queueMicrotask(() => {
        if (!stores.has('handles')) {
          req.onupgradeneeded?.();
        }
      });
      return req;
    },
  };
}

// A structurally-typed FileSystemFileHandle stand-in.
function fakeHandle(
  name: string,
  perm: PermissionState = 'granted',
  fileBytes = 10,
): StoredFileHandle {
  return {
    kind: 'file',
    name,
    async getFile() {
      return new File([new Uint8Array(fileBytes)], name, { type: 'video/mp4' });
    },
    async queryPermission() { return perm; },
    async requestPermission() { return perm; },
  };
}

const g = globalThis as Record<string, unknown>;

describe('video-file-store: missing-API fallbacks', () => {
  beforeEach(() => {
    delete g.indexedDB;
    delete g.showOpenFilePicker;
  });

  it('canPersistVideoHandles is false without indexedDB + showOpenFilePicker', () => {
    expect(canPersistVideoHandles()).toBe(false);
  });

  it('get/put/delete never throw when indexedDB is absent', async () => {
    await expect(putVideoFileHandle('x', fakeHandle('a.mp4'))).resolves.toBeUndefined();
    await expect(getVideoFileHandle('x')).resolves.toBeNull();
    await expect(deleteVideoFileHandle('x')).resolves.toBeUndefined();
  });

  it('queryHandleReadPermission falls back to prompt when the API is missing', async () => {
    const handle: StoredFileHandle = {
      kind: 'file',
      name: 'a.mp4',
      async getFile() { return new File([], 'a.mp4'); },
    };
    expect(await queryHandleReadPermission(handle)).toBe('prompt');
  });

  it('requestHandleReadPermission falls back to denied when the API is missing', async () => {
    const handle: StoredFileHandle = {
      kind: 'file',
      name: 'a.mp4',
      async getFile() { return new File([], 'a.mp4'); },
    };
    expect(await requestHandleReadPermission(handle)).toBe('denied');
  });
});

describe('video-file-store: with a fake IndexedDB', () => {
  beforeEach(() => {
    g.indexedDB = makeFakeIndexedDB() as unknown as IDBFactory;
    g.showOpenFilePicker = () => Promise.resolve([]);
  });
  afterEach(() => {
    delete g.indexedDB;
    delete g.showOpenFilePicker;
  });

  it('canPersistVideoHandles is true when both APIs exist', () => {
    expect(canPersistVideoHandles()).toBe(true);
  });

  it('round-trips a handle by id (put → get)', async () => {
    const handle = fakeHandle('movie.mp4');
    await putVideoFileHandle('id-1', handle);
    const got = await getVideoFileHandle('id-1');
    expect(got).not.toBeNull();
    expect(got?.name).toBe('movie.mp4');
    // The retrieved object exposes getFile (structural sanity check).
    const file = await got!.getFile();
    expect(file.name).toBe('movie.mp4');
  });

  it('returns null for an id never stored', async () => {
    expect(await getVideoFileHandle('nope')).toBeNull();
  });

  it('deletes a stored handle', async () => {
    await putVideoFileHandle('id-2', fakeHandle('b.mp4'));
    expect(await getVideoFileHandle('id-2')).not.toBeNull();
    await deleteVideoFileHandle('id-2');
    expect(await getVideoFileHandle('id-2')).toBeNull();
  });

  it('rejects a stored value that is not handle-shaped (no getFile)', async () => {
    // Simulate corruption: stash a plain object under the key directly via put.
    await putVideoFileHandle('id-3', { kind: 'file', name: 'x' } as unknown as StoredFileHandle);
    expect(await getVideoFileHandle('id-3')).toBeNull();
  });

  it('queries + requests handle permission through the handle API', async () => {
    expect(await queryHandleReadPermission(fakeHandle('a', 'granted'))).toBe('granted');
    expect(await queryHandleReadPermission(fakeHandle('a', 'prompt'))).toBe('prompt');
    expect(await requestHandleReadPermission(fakeHandle('a', 'granted'))).toBe('granted');
    expect(await requestHandleReadPermission(fakeHandle('a', 'denied'))).toBe('denied');
  });
});

describe('newVideoFileId', () => {
  it('returns a non-empty string each call', () => {
    const a = newVideoFileId();
    const b = newVideoFileId();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('falls back to a non-crypto id when randomUUID is unavailable', () => {
    const orig = (globalThis.crypto as { randomUUID?: unknown })?.randomUUID;
    // @ts-expect-error — intentionally clobber for the fallback path.
    if (globalThis.crypto) globalThis.crypto.randomUUID = undefined;
    try {
      const id = newVideoFileId();
      expect(id.startsWith('vfh-')).toBe(true);
    } finally {
      if (globalThis.crypto && orig) {
        (globalThis.crypto as { randomUUID?: unknown }).randomUUID = orig;
      }
    }
  });
});

describe('formatFileSize', () => {
  it('handles zero / nullish / non-finite', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(undefined)).toBe('0 B');
    expect(formatFileSize(null)).toBe('0 B');
    expect(formatFileSize(Number.NaN)).toBe('0 B');
  });

  it('formats bytes / KB / MB / GB', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(13_001_000)).toBe('12.4 MB');
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});