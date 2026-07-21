// packages/web/src/lib/storage/local-scratch.test.ts
//
// The stable per-device scratch-replica id. Covers the three contracts the
// design names: stable across calls per mode, distinct per mode, and a
// graceful ephemeral fallback when localStorage throws / is absent (private
// mode) — the same degrade posture as presence.ts's getOrCreateAnonTabId.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getOrCreateLocalScratchId,
  localScratchStorageKey,
  peekLocalScratchId,
  readLastScratchMode,
  readLastScratchRack,
  recordLastScratchMode,
  resetLocalScratchId,
  resolveLastScratchRack,
  scratchReplicaDbName,
} from './local-scratch';

/** A Map-backed Storage stand-in (jsdom's real localStorage is process-global
 *  and shared across tests; a fresh stub per test keeps them isolated). */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  } as Storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getOrCreateLocalScratchId', () => {
  it('is STABLE across calls for the same mode (persisted in localStorage)', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const first = getOrCreateLocalScratchId('dawless');
    const second = getOrCreateLocalScratchId('dawless');
    expect(first).toBe(second);
    // Shape: local-scratch-<mode>-<uuid>.
    expect(first).toMatch(/^local-scratch-dawless-.+/);
    // Actually stored under the mode-scoped key.
    expect(localStorage.getItem(localScratchStorageKey('dawless'))).toBe(first);
  });

  it('is DISTINCT per mode (dawless and workflow do not cross-load)', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const dawless = getOrCreateLocalScratchId('dawless');
    const workflow = getOrCreateLocalScratchId('workflow');
    expect(dawless).not.toBe(workflow);
    expect(dawless).toMatch(/^local-scratch-dawless-.+/);
    expect(workflow).toMatch(/^local-scratch-workflow-.+/);
    // Each stays stable under its own key.
    expect(getOrCreateLocalScratchId('dawless')).toBe(dawless);
    expect(getOrCreateLocalScratchId('workflow')).toBe(workflow);
  });

  it('reads back an id an earlier session already persisted', () => {
    const storage = makeMemoryStorage();
    storage.setItem(localScratchStorageKey('workflow'), 'local-scratch-workflow-preexisting');
    vi.stubGlobal('localStorage', storage);
    expect(getOrCreateLocalScratchId('workflow')).toBe('local-scratch-workflow-preexisting');
  });

  it('a THROWING localStorage → ephemeral fallback id, never throws', () => {
    const hostile = {
      getItem: () => {
        throw new DOMException('access denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('access denied', 'SecurityError');
      },
    } as unknown as Storage;
    vi.stubGlobal('localStorage', hostile);
    let id!: string;
    expect(() => {
      id = getOrCreateLocalScratchId('dawless');
    }).not.toThrow();
    expect(id).toMatch(/^local-scratch-dawless-.+/);
    // Not persisted (storage threw) → each call mints a fresh ephemeral id.
    expect(getOrCreateLocalScratchId('dawless')).not.toBe(id);
  });

  it('no localStorage at all (SSR / hardened) → ephemeral fallback id, no throw', () => {
    vi.stubGlobal('localStorage', undefined);
    let id!: string;
    expect(() => {
      id = getOrCreateLocalScratchId('workflow');
    }).not.toThrow();
    expect(id).toMatch(/^local-scratch-workflow-.+/);
  });
});

describe('peekLocalScratchId', () => {
  it('returns null when no id has been minted (never side-effects one in)', () => {
    const storage = makeMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(peekLocalScratchId('dawless')).toBeNull();
    // Peeking must NOT create an id (unlike getOrCreate).
    expect(storage.getItem(localScratchStorageKey('dawless'))).toBeNull();
  });

  it('returns the stored id once one exists', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const id = getOrCreateLocalScratchId('workflow');
    expect(peekLocalScratchId('workflow')).toBe(id);
  });

  it('null (never throws) when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Storage);
    expect(() => peekLocalScratchId('dawless')).not.toThrow();
    expect(peekLocalScratchId('dawless')).toBeNull();
  });
});

describe('resetLocalScratchId', () => {
  it('mints a NEW id and REPLACES the stored one (fresh empty rack)', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const first = getOrCreateLocalScratchId('dawless');
    const reset = resetLocalScratchId('dawless');
    expect(reset).not.toBe(first);
    expect(reset).toMatch(/^local-scratch-dawless-.+/);
    // The new id is now the persisted one (getOrCreate reads it back).
    expect(getOrCreateLocalScratchId('dawless')).toBe(reset);
  });

  it('only resets the requested mode (leaves the sibling mode intact)', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const dawless = getOrCreateLocalScratchId('dawless');
    const workflow = getOrCreateLocalScratchId('workflow');
    resetLocalScratchId('workflow');
    expect(getOrCreateLocalScratchId('dawless')).toBe(dawless); // untouched
    expect(getOrCreateLocalScratchId('workflow')).not.toBe(workflow); // reset
  });

  it('never throws under a hostile localStorage', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Storage);
    let id!: string;
    expect(() => {
      id = resetLocalScratchId('dawless');
    }).not.toThrow();
    expect(id).toMatch(/^local-scratch-dawless-.+/);
  });
});

describe('last-scratch-mode + readLastScratchRack', () => {
  it('records and reads back the last opened mode', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    expect(readLastScratchMode()).toBeNull();
    recordLastScratchMode('workflow');
    expect(readLastScratchMode()).toBe('workflow');
    recordLastScratchMode('dawless');
    expect(readLastScratchMode()).toBe('dawless');
  });

  it('readLastScratchRack is null with no recorded session', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    expect(readLastScratchRack()).toBeNull();
  });

  it('readLastScratchRack is null when a mode is recorded but no id persisted', () => {
    const storage = makeMemoryStorage();
    storage.setItem('pt:last-scratch-mode', 'workflow');
    vi.stubGlobal('localStorage', storage);
    // No pt:local-scratch-id:workflow present.
    expect(readLastScratchRack()).toBeNull();
  });

  it('readLastScratchRack yields the id + reopen href for the last mode', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const wfId = getOrCreateLocalScratchId('workflow');
    recordLastScratchMode('workflow');
    expect(readLastScratchRack()).toEqual({
      mode: 'workflow',
      id: wfId,
      href: '/rack?mode=workflow',
    });

    const dawId = getOrCreateLocalScratchId('dawless');
    recordLastScratchMode('dawless');
    expect(readLastScratchRack()).toEqual({ mode: 'dawless', id: dawId, href: '/rack' });
  });
});

describe('scratchReplicaDbName', () => {
  it('builds the pinned replica DB name (mirrors local-replica REPLICA_DB_PREFIX)', () => {
    expect(scratchReplicaDbName('local-scratch-dawless-abc')).toBe(
      'pt-rack-v1-local-scratch-dawless-abc',
    );
  });
});

describe('resolveLastScratchRack (IndexedDB-verified)', () => {
  it('returns null with no recorded session', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    vi.stubGlobal('indexedDB', { databases: async () => [] } as unknown as IDBFactory);
    await expect(resolveLastScratchRack()).resolves.toBeNull();
  });

  it('returns the rack when its replica DB is present in IndexedDB', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const id = getOrCreateLocalScratchId('workflow');
    recordLastScratchMode('workflow');
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: scratchReplicaDbName(id) }],
    } as unknown as IDBFactory);
    await expect(resolveLastScratchRack()).resolves.toEqual({
      mode: 'workflow',
      id,
      href: '/rack?mode=workflow',
    });
  });

  it('returns null when the recorded id has NO replica DB (rack not in memory)', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    getOrCreateLocalScratchId('dawless');
    recordLastScratchMode('dawless');
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'pt-rack-v1-some-other-rack' }],
    } as unknown as IDBFactory);
    await expect(resolveLastScratchRack()).resolves.toBeNull();
  });

  it('degrades to the localStorage signal when databases() is unavailable', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const id = getOrCreateLocalScratchId('dawless');
    recordLastScratchMode('dawless');
    // No databases() method → cannot enumerate → trust the recorded session.
    vi.stubGlobal('indexedDB', {} as unknown as IDBFactory);
    await expect(resolveLastScratchRack()).resolves.toEqual({
      mode: 'dawless',
      id,
      href: '/rack',
    });
  });
});
