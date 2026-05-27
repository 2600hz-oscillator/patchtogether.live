// packages/web/src/lib/graph/performance-store.test.ts
//
// Unit tests for the named-slot IndexedDB wrapper. Vitest runs in node (no
// real IndexedDB / File System Access), so we:
//   * exercise the missing-API fallbacks (no indexedDB) directly, and
//   * install an in-memory IndexedDB shim that supports the slice this module
//     uses (multi-store tx, put/get/delete/getAll/getAllKeys).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  canPersistPerformances,
  canReacquireFileHandles,
  canPickDirectory,
  savePerformanceSlot,
  loadPerformanceSlot,
  listPerformanceSlots,
  deletePerformanceSlot,
  putSlotDirHandle,
  getSlotDirHandle,
  queryDirReadPermission,
  requestDirReadPermission,
  sanitizeSlotName,
  type StoredDirHandle,
} from './performance-store';
import type { PerformanceBundle } from './performance-bundle';

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

  function objectStore(name: string, tx: { oncomplete?: () => void; onerror?: () => void }) {
    const s = stores.get(name);
    if (!s) throw new Error(`no store ${name}`);
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
      getAll() {
        const r: { result?: unknown[]; onsuccess?: () => void; onerror?: () => void } = {};
        queueMicrotask(() => {
          r.result = [...s.data.values()];
          r.onsuccess?.();
        });
        return r;
      },
      getAllKeys() {
        const r: { result?: unknown[]; onsuccess?: () => void; onerror?: () => void } = {};
        queueMicrotask(() => {
          r.result = [...s.data.keys()];
          r.onsuccess?.();
        });
        return r;
      },
    };
  }

  return {
    open(_name: string, _version?: number) {
      const db = {
        objectStoreNames: { contains: (n: string) => stores.has(n) },
        createObjectStore(n: string) {
          stores.set(n, { data: new Map() });
          return {};
        },
        transaction(storeNames: string | string[], _mode?: string) {
          const tx: {
            oncomplete?: () => void;
            onerror?: () => void;
            onabort?: () => void;
            objectStore: (n: string) => unknown;
          } = {
            objectStore(n: string) {
              return objectStore(n, tx);
            },
          };
          void storeNames;
          return tx;
        },
        close() {},
      };
      const req = makeRequest(() => db);
      queueMicrotask(() => {
        if (!stores.has('slots') || !stores.has('dirHandles')) {
          req.onupgradeneeded?.();
        }
      });
      return req;
    },
  };
}

function makeBundle(savedAt: string, assetCount = 0): PerformanceBundle {
  return {
    bundleVersion: 1,
    savedAt,
    patch: { envelopeVersion: 1, savedAt, moduleSchemas: {}, update: 'AA' },
    assets: Array.from({ length: assetCount }, (_, i) => ({
      handleId: `h-${i}`,
      role: 'video' as const,
      nodeId: `v${i}`,
      filename: `c${i}.mp4`,
    })),
    midiBindings: [],
    midiDevices: [],
    gamepadBindings: [],
  };
}

function fakeDirHandle(perm: PermissionState = 'granted'): StoredDirHandle {
  return {
    kind: 'directory',
    name: 'assets',
    async getFileHandle(name: string) {
      return {
        kind: 'file' as const,
        name,
        async getFile() { return new File([], name); },
      };
    },
    async queryPermission() { return perm; },
    async requestPermission() { return perm; },
  };
}

const g = globalThis as Record<string, unknown>;

describe('performance-store: feature detection', () => {
  afterEach(() => {
    delete g.indexedDB;
    delete g.showOpenFilePicker;
    delete g.showDirectoryPicker;
  });

  it('canPersistPerformances tracks indexedDB presence', () => {
    delete g.indexedDB;
    expect(canPersistPerformances()).toBe(false);
    g.indexedDB = {};
    expect(canPersistPerformances()).toBe(true);
  });

  it('canReacquireFileHandles needs indexedDB AND showOpenFilePicker', () => {
    g.indexedDB = {};
    delete g.showOpenFilePicker;
    expect(canReacquireFileHandles()).toBe(false);
    g.showOpenFilePicker = () => {};
    expect(canReacquireFileHandles()).toBe(true);
  });

  it('canPickDirectory tracks showDirectoryPicker', () => {
    delete g.showDirectoryPicker;
    expect(canPickDirectory()).toBe(false);
    g.showDirectoryPicker = () => {};
    expect(canPickDirectory()).toBe(true);
  });
});

describe('performance-store: missing-IDB fallbacks never throw', () => {
  beforeEach(() => { delete g.indexedDB; });

  it('save returns false, load/list/get return null/[]', async () => {
    expect(await savePerformanceSlot('s', makeBundle('t'))).toBe(false);
    expect(await loadPerformanceSlot('s')).toBeNull();
    expect(await listPerformanceSlots()).toEqual([]);
    await expect(deletePerformanceSlot('s')).resolves.toBeUndefined();
    await expect(putSlotDirHandle('s', fakeDirHandle())).resolves.toBeUndefined();
    expect(await getSlotDirHandle('s')).toBeNull();
  });
});

describe('performance-store: slot CRUD with a fake IndexedDB', () => {
  beforeEach(() => { g.indexedDB = makeFakeIndexedDB() as unknown as IDBFactory; });
  afterEach(() => { delete g.indexedDB; });

  it('save → load round-trips the bundle', async () => {
    const bundle = makeBundle('2026-05-27T01:00:00.000Z', 2);
    expect(await savePerformanceSlot('My Set', bundle)).toBe(true);
    const rec = await loadPerformanceSlot('My Set');
    expect(rec).not.toBeNull();
    expect(rec!.name).toBe('My Set');
    expect(rec!.bundle.assets).toHaveLength(2);
    expect(rec!.savedAt).toBe('2026-05-27T01:00:00.000Z');
  });

  it('overwrites an existing slot of the same name', async () => {
    await savePerformanceSlot('S', makeBundle('t1', 1));
    await savePerformanceSlot('S', makeBundle('t2', 3));
    const rec = await loadPerformanceSlot('S');
    expect(rec!.bundle.assets).toHaveLength(3);
    expect(rec!.savedAt).toBe('t2');
  });

  it('list returns slots newest-first with asset counts + dir flag', async () => {
    await savePerformanceSlot('old', makeBundle('2026-01-01T00:00:00.000Z', 0));
    await savePerformanceSlot('new', makeBundle('2026-12-01T00:00:00.000Z', 2));
    await putSlotDirHandle('new', fakeDirHandle());
    const list = await listPerformanceSlots();
    expect(list.map((s) => s.name)).toEqual(['new', 'old']);
    expect(list[0]).toMatchObject({ name: 'new', assetCount: 2, hasDirHandle: true });
    expect(list[1]).toMatchObject({ name: 'old', assetCount: 0, hasDirHandle: false });
  });

  it('delete removes a slot + its dir handle', async () => {
    await savePerformanceSlot('Z', makeBundle('t'));
    await putSlotDirHandle('Z', fakeDirHandle());
    await deletePerformanceSlot('Z');
    expect(await loadPerformanceSlot('Z')).toBeNull();
    expect(await getSlotDirHandle('Z')).toBeNull();
    expect(await listPerformanceSlots()).toEqual([]);
  });

  it('returns null for an absent slot', async () => {
    expect(await loadPerformanceSlot('nope')).toBeNull();
  });
});

describe('performance-store: directory handle lifecycle', () => {
  beforeEach(() => { g.indexedDB = makeFakeIndexedDB() as unknown as IDBFactory; });
  afterEach(() => { delete g.indexedDB; });

  it('put → get round-trips a directory handle', async () => {
    await putSlotDirHandle('Set', fakeDirHandle());
    const h = await getSlotDirHandle('Set');
    expect(h).not.toBeNull();
    expect(h!.kind).toBe('directory');
  });

  it('rejects a stored value that is not a dir handle', async () => {
    // Put a non-handle object directly via savePerformanceSlot's store is the
    // slots store; here we just confirm get returns null when getFileHandle
    // is missing by storing a plain object.
    g.indexedDB = makeFakeIndexedDB() as unknown as IDBFactory;
    await putSlotDirHandle('X', { kind: 'directory', name: 'x' } as unknown as StoredDirHandle);
    expect(await getSlotDirHandle('X')).toBeNull();
  });
});

describe('performance-store: dir permission helpers', () => {
  it('query falls back to prompt when the API is missing', async () => {
    const h: StoredDirHandle = {
      kind: 'directory',
      name: 'x',
      async getFileHandle(n) { return { kind: 'file' as const, name: n, async getFile() { return new File([], n); } }; },
    };
    expect(await queryDirReadPermission(h)).toBe('prompt');
  });

  it('request falls back to denied when the API is missing', async () => {
    const h: StoredDirHandle = {
      kind: 'directory',
      name: 'x',
      async getFileHandle(n) { return { kind: 'file' as const, name: n, async getFile() { return new File([], n); } }; },
    };
    expect(await requestDirReadPermission(h)).toBe('denied');
  });

  it('query/request pass through a real handle', async () => {
    expect(await queryDirReadPermission(fakeDirHandle('granted'))).toBe('granted');
    expect(await requestDirReadPermission(fakeDirHandle('granted'))).toBe('granted');
    expect(await requestDirReadPermission(fakeDirHandle('denied'))).toBe('denied');
  });
});

describe('sanitizeSlotName', () => {
  it('trims and rejects empties', () => {
    expect(sanitizeSlotName('  Live Set  ')).toBe('Live Set');
    expect(sanitizeSlotName('')).toBeNull();
    expect(sanitizeSlotName('   ')).toBeNull();
    expect(sanitizeSlotName(null)).toBeNull();
    expect(sanitizeSlotName(undefined)).toBeNull();
  });
});
