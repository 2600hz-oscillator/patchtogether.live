// packages/web/src/lib/storage/local-scratch.test.ts
//
// The stable per-device scratch-replica id. Covers the three contracts the
// design names: stable across calls per mode, distinct per mode, and a
// graceful ephemeral fallback when localStorage throws / is absent (private
// mode) — the same degrade posture as presence.ts's getOrCreateAnonTabId.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getOrCreateLocalScratchId, localScratchStorageKey } from './local-scratch';

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
