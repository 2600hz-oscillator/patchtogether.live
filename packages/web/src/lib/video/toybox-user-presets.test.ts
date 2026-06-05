// packages/web/src/lib/video/toybox-user-presets.test.ts
//
// Pure registry coverage for the TOYBOX *user* preset localStorage store. An
// injected fake Storage keeps this fully DOM-free + deterministic — the
// correctness guard for the SAVE-side of #61 (load/restore is exercised in the
// graph mutator + the e2e spec).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  USER_PRESETS_KEY,
  listUserPresets,
  getUserPreset,
  saveUserPreset,
  deleteUserPreset,
  type StorageLike,
} from './toybox-user-presets';

/** A minimal in-memory Storage that can be forced to throw (quota sim). */
class FakeStorage implements StorageLike {
  map = new Map<string, string>();
  throwOnSet = false;
  throwOnGet = false;
  getItem(k: string): string | null {
    if (this.throwOnGet) throw new Error('blocked');
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.throwOnSet) throw new DOMException('QuotaExceededError');
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

function sampleData(tag = 'a'): Record<string, unknown> {
  return {
    layers: [{ kind: 'gen', contentId: `noise-${tag}`, params: { speed: 0.4 } }],
    combine: { nodes: [], edges: [] },
    cvRoutes: { cv1: { target: 'layer', layer: 0, param: 'speed' } },
    cvInputs: { cv1: { scale: 2, offset: 0.1 } },
  };
}

describe('toybox-user-presets — registry round-trip', () => {
  let store: FakeStorage;
  beforeEach(() => {
    store = new FakeStorage();
  });

  it('save → list → get → delete', () => {
    expect(listUserPresets(store)).toEqual([]);

    const saved = saveUserPreset('My Patch', sampleData('x'), store);
    expect(saved).not.toBeNull();
    expect(saved!.label).toBe('My Patch');
    expect(saved!.id).toMatch(/^user-/);
    expect(typeof saved!.savedAt).toBe('number');

    const list = listUserPresets(store);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(saved!.id);

    const got = getUserPreset(saved!.id, store);
    expect(got).not.toBeNull();
    expect(got!.data).toEqual(sampleData('x')); // full blob incl. cvInputs preserved

    expect(deleteUserPreset(saved!.id, store)).toBe(true);
    expect(listUserPresets(store)).toEqual([]);
    expect(getUserPreset(saved!.id, store)).toBeNull();
  });

  it('stores a DEEP CLONE — mutating the live blob after save does not change the saved copy', () => {
    const live = sampleData('m');
    const saved = saveUserPreset('Clone Test', live, store)!;
    (live.layers as Array<Record<string, unknown>>)[0]!.contentId = 'MUTATED';
    expect(getUserPreset(saved.id, store)!.data).toEqual(sampleData('m'));
  });

  it('lists newest first', () => {
    const a = saveUserPreset('A', sampleData('a'), store)!;
    // Force a later savedAt on the second entry so the sort is unambiguous.
    const b = saveUserPreset('B', sampleData('b'), store)!;
    // Patch stored stamps so b is strictly newer regardless of clock resolution.
    const raw = JSON.parse(store.getItem(USER_PRESETS_KEY)!) as Array<{ id: string; savedAt: number }>;
    for (const e of raw) {
      if (e.id === a.id) e.savedAt = 1000;
      if (e.id === b.id) e.savedAt = 2000;
    }
    store.setItem(USER_PRESETS_KEY, JSON.stringify(raw));
    const list = listUserPresets(store);
    expect(list.map((p) => p.label)).toEqual(['B', 'A']);
  });

  it('deleting an absent id returns false + leaves the list intact', () => {
    saveUserPreset('Keep', sampleData(), store);
    expect(deleteUserPreset('user-nope', store)).toBe(false);
    expect(listUserPresets(store)).toHaveLength(1);
  });

  it('blank/whitespace label falls back to "Untitled"', () => {
    expect(saveUserPreset('   ', sampleData(), store)!.label).toBe('Untitled');
    expect(saveUserPreset('', sampleData(), store)!.label).toBe('Untitled');
  });

  describe('guards', () => {
    it('corrupt JSON in the store → list() returns [] (does not throw)', () => {
      store.map.set(USER_PRESETS_KEY, '{not json');
      expect(listUserPresets(store)).toEqual([]);
    });

    it('non-array stored value → list() returns []', () => {
      store.map.set(USER_PRESETS_KEY, JSON.stringify({ not: 'an array' }));
      expect(listUserPresets(store)).toEqual([]);
    });

    it('filters out invalid entries (missing required fields)', () => {
      store.map.set(
        USER_PRESETS_KEY,
        JSON.stringify([
          { id: 'ok', label: 'Good', data: {}, savedAt: 1 },
          { id: 'bad-no-data', label: 'x', savedAt: 2 }, // missing data
          { label: 'no-id', data: {}, savedAt: 3 }, // missing id
          null,
          'string',
        ]),
      );
      const list = listUserPresets(store);
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('ok');
    });

    it('quota-exceeded setItem → save() returns null', () => {
      store.throwOnSet = true;
      expect(saveUserPreset('Q', sampleData(), store)).toBeNull();
    });

    it('quota-exceeded setItem → delete() returns false', () => {
      // Seed an entry directly, then make writes throw → delete can't persist.
      store.map.set(USER_PRESETS_KEY, JSON.stringify([{ id: 'x', label: 'X', data: {}, savedAt: 1 }]));
      store.throwOnSet = true;
      expect(deleteUserPreset('x', store)).toBe(false);
    });

    it('throwing getItem → list/get degrade to empty (no throw)', () => {
      store.throwOnGet = true;
      expect(listUserPresets(store)).toEqual([]);
      expect(getUserPreset('anything', store)).toBeNull();
    });

    it('null store (no DOM) → all ops degrade gracefully', () => {
      expect(listUserPresets(null)).toEqual([]);
      expect(getUserPreset('x', null)).toBeNull();
      expect(saveUserPreset('x', sampleData(), null)).toBeNull();
      expect(deleteUserPreset('x', null)).toBe(false);
    });
  });
});
