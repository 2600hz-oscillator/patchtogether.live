// packages/web/src/lib/storage/local-scratch.test.ts
//
// The stable per-device scratch-replica id. Covers the contracts the design
// names: ONE id, stable across calls; a graceful ephemeral fallback when
// localStorage throws / is absent (private mode) — the same degrade posture as
// presence.ts's getOrCreateAnonTabId; and the MIGRATION off the two-mode keys.
//
// That last one is the point of this file after the dawless removal. A browser
// that last ran the two-shell build still holds `pt:local-scratch-id:dawless`,
// `pt:local-scratch-id:workflow` and `pt:last-scratch-mode`. Adopting either id
// would rehydrate a doc authored under a shell that no longer exists, so the
// keys are PRUNED, never read — and the tests below feed the real old shape in
// rather than asserting against a re-typed idea of it.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getOrCreateLocalScratchId,
  localScratchStorageKey,
  peekLocalScratchId,
  pruneLegacyModeKeys,
  readLastScratchRack,
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

/** THE OLD SHAPE, verbatim: exactly what a browser running the two-shell build
 *  wrote. Written through raw setItem (not through this module) so the fixture
 *  cannot drift into agreeing with the code under test. */
function seedTwoModeEraStorage(): Storage {
  const ls = makeMemoryStorage();
  ls.setItem('pt:local-scratch-id:dawless', 'local-scratch-dawless-old-uuid-1');
  ls.setItem('pt:local-scratch-id:workflow', 'local-scratch-workflow-old-uuid-2');
  ls.setItem('pt:last-scratch-mode', 'workflow');
  return ls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getOrCreateLocalScratchId', () => {
  it('is STABLE across calls (persisted in localStorage)', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const first = getOrCreateLocalScratchId();
    const second = getOrCreateLocalScratchId();
    expect(first).toBe(second);
    // Shape: local-scratch-<uuid>, with no mode segment.
    expect(first).toMatch(/^local-scratch-.+/);
    expect(first).not.toMatch(/^local-scratch-(dawless|workflow)-/);
    expect(localStorage.getItem(localScratchStorageKey())).toBe(first);
  });

  it('falls back to an EPHEMERAL id when localStorage is absent (never throws)', () => {
    vi.stubGlobal('localStorage', undefined);
    const a = getOrCreateLocalScratchId();
    const b = getOrCreateLocalScratchId();
    expect(a).toMatch(/^local-scratch-.+/);
    // Ephemeral ⇒ not stable, but the call must succeed rather than crash the
    // canvas: the hostile-environment contract is "no persistence", not "no page".
    expect(b).toMatch(/^local-scratch-.+/);
  });

  it('falls back to an EPHEMERAL id when localStorage THROWS (private mode)', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    vi.stubGlobal('localStorage', hostile);
    expect(() => getOrCreateLocalScratchId()).not.toThrow();
    expect(getOrCreateLocalScratchId()).toMatch(/^local-scratch-.+/);
  });
});

describe('peekLocalScratchId — read without minting', () => {
  it('returns null before any id has been created', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    expect(peekLocalScratchId()).toBeNull();
    // …and it did NOT side-effect one into existence.
    expect(localStorage.getItem(localScratchStorageKey())).toBeNull();
  });

  it('returns the persisted id once the scratch canvas has minted it', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const id = getOrCreateLocalScratchId();
    expect(peekLocalScratchId()).toBe(id);
  });
});

describe('resetLocalScratchId — the File → New rack primitive', () => {
  it('REPLACES the stored id so the next bind rehydrates an empty doc', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const before = getOrCreateLocalScratchId();
    const fresh = resetLocalScratchId();
    expect(fresh).not.toBe(before);
    expect(localStorage.getItem(localScratchStorageKey())).toBe(fresh);
    expect(getOrCreateLocalScratchId()).toBe(fresh);
  });
});

describe('readLastScratchRack — the landing "Return to last rack" card', () => {
  it('is null with no prior session', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    expect(readLastScratchRack()).toBeNull();
  });

  it('resolves the persisted id and the single rack route', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const id = getOrCreateLocalScratchId();
    expect(readLastScratchRack()).toEqual({ id, href: '/rack' });
  });

  it('the href carries NO mode querystring (there is one rack kind)', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    getOrCreateLocalScratchId();
    expect(readLastScratchRack()?.href).not.toContain('mode=');
  });
});

// ---------------------------------------------------------------------------
// THE MIGRATION. A stale two-mode entry must not resurrect a dead shell.
// ---------------------------------------------------------------------------

describe('the two-mode era keys are PRUNED, never adopted', () => {
  it('getOrCreateLocalScratchId ignores both old ids and mints a fresh one', () => {
    vi.stubGlobal('localStorage', seedTwoModeEraStorage());
    const id = getOrCreateLocalScratchId();
    expect(id).not.toBe('local-scratch-dawless-old-uuid-1');
    expect(id).not.toBe('local-scratch-workflow-old-uuid-2');
    expect(id).toMatch(/^local-scratch-.+/);
  });

  it('every legacy key is REMOVED from storage on first touch', () => {
    vi.stubGlobal('localStorage', seedTwoModeEraStorage());
    getOrCreateLocalScratchId();
    expect(localStorage.getItem('pt:local-scratch-id:dawless')).toBeNull();
    expect(localStorage.getItem('pt:local-scratch-id:workflow')).toBeNull();
    expect(localStorage.getItem('pt:last-scratch-mode')).toBeNull();
  });

  it('the landing card does NOT offer a rack from a legacy-only browser', () => {
    // The old keys alone are not a session: nothing has minted the new id yet,
    // so "Return to last rack" must stay hidden rather than link to a doc that
    // will come back empty.
    vi.stubGlobal('localStorage', seedTwoModeEraStorage());
    expect(readLastScratchRack()).toBeNull();
  });

  it('peekLocalScratchId does not read a legacy id through the new key', () => {
    vi.stubGlobal('localStorage', seedTwoModeEraStorage());
    expect(peekLocalScratchId()).toBeNull();
  });

  it('pruneLegacyModeKeys is idempotent and safe on empty storage', () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    expect(() => {
      pruneLegacyModeKeys();
      pruneLegacyModeKeys();
    }).not.toThrow();
  });

  it('pruning never throws on a hostile localStorage', () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    vi.stubGlobal('localStorage', hostile);
    expect(() => pruneLegacyModeKeys()).not.toThrow();
  });

  // NEGATIVE CONTROL on the fixture itself: if seedTwoModeEraStorage stopped
  // writing the old keys, every assertion above would pass vacuously.
  it('NEGATIVE CONTROL: the fixture really does write the old shape', () => {
    const ls = seedTwoModeEraStorage();
    expect(ls.getItem('pt:local-scratch-id:dawless')).toBe('local-scratch-dawless-old-uuid-1');
    expect(ls.getItem('pt:local-scratch-id:workflow')).toBe('local-scratch-workflow-old-uuid-2');
    expect(ls.getItem('pt:last-scratch-mode')).toBe('workflow');
  });
});

describe('scratchReplicaDbName', () => {
  it('mirrors local-replica.ts REPLICA_DB_PREFIX', () => {
    expect(scratchReplicaDbName('local-scratch-abc')).toBe('pt-rack-v1-local-scratch-abc');
  });
});

describe('resolveLastScratchRack — gated on the replica DB actually existing', () => {
  it('is null when there is no prior session', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    await expect(resolveLastScratchRack()).resolves.toBeNull();
  });

  it('returns the rack when its replica DB is present', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const id = getOrCreateLocalScratchId();
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: scratchReplicaDbName(id) }],
    });
    await expect(resolveLastScratchRack()).resolves.toEqual({ id, href: '/rack' });
  });

  it('is null when the replica DB is ABSENT (a stale localStorage entry)', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    getOrCreateLocalScratchId();
    vi.stubGlobal('indexedDB', { databases: async () => [{ name: 'pt-rack-v1-something-else' }] });
    await expect(resolveLastScratchRack()).resolves.toBeNull();
  });

  it('degrades to the localStorage signal when databases() is unavailable', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const id = getOrCreateLocalScratchId();
    vi.stubGlobal('indexedDB', {});
    await expect(resolveLastScratchRack()).resolves.toEqual({ id, href: '/rack' });
  });
});
