// packages/web/src/lib/control/push2/push2-view.test.ts
//
// The per-rack, per-lane "last viewed module" memory. The two things worth
// proving are that two racks CANNOT see each other's memory (the owner said
// "in this rack") and that the store is bounded.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ rack: 'rack-a' as string | null }));
vi.mock('$lib/graph/store', () => ({
  getBoundRackspaceId: () => hoisted.rack,
}));

// The web vitest env is `node` — no localStorage. This IS the store under test,
// so it gets a real in-memory implementation rather than a stub that no-ops.
const backing = new Map<string, string>();
if (typeof localStorage === 'undefined') {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

import {
  lastViewed,
  setLastViewed,
  forgetLane,
  forgetRack,
  __test_resetPushView,
  PUSH_VIEW_STORAGE_KEY,
  PUSH_VIEW_MAX_RACKS,
} from './push2-view.svelte';

beforeEach(() => {
  __test_resetPushView();
  hoisted.rack = 'rack-a';
});

describe('lane focus memory', () => {
  it('a never-viewed lane remembers nothing', () => {
    expect(lastViewed(1)).toBeNull();
  });

  it('remembers a module per lane and reads it back', () => {
    setLastViewed(1, 'vco-1');
    setLastViewed(3, 'filt-9');
    expect(lastViewed(1)).toBe('vco-1');
    expect(lastViewed(3)).toBe('filt-9');
    expect(lastViewed(2), 'lanes are independent').toBeNull();
  });

  it('the newest write for a lane wins', () => {
    setLastViewed(1, 'a');
    setLastViewed(1, 'b');
    expect(lastViewed(1)).toBe('b');
  });

  it('RACK ISOLATION: a second rack cannot see the first rack\'s memory', () => {
    setLastViewed(1, 'vco-1');
    hoisted.rack = 'rack-b';
    expect(lastViewed(1), '"in THIS rack" — a different rack starts fresh').toBeNull();
    setLastViewed(1, 'other-1');
    expect(lastViewed(1)).toBe('other-1');
    hoisted.rack = 'rack-a';
    expect(lastViewed(1), 'and the first rack is untouched').toBe('vco-1');
  });

  it('forgetLane drops one lane; forgetRack drops the whole rack', () => {
    setLastViewed(1, 'a');
    setLastViewed(2, 'b');
    forgetLane(1);
    expect(lastViewed(1)).toBeNull();
    expect(lastViewed(2)).toBe('b');
    forgetRack();
    expect(lastViewed(2)).toBeNull();
  });

  it('survives a reload (the memory is a property of the rack, not the session)', () => {
    setLastViewed(4, 'kick-1');
    // A reload is exactly "read the same localStorage from a fresh module
    // state" — the store keeps nothing in memory, so re-reading proves it.
    expect(JSON.parse(localStorage.getItem(PUSH_VIEW_STORAGE_KEY)!)).toEqual({
      'rack-a': { '4': 'kick-1' },
    });
    expect(lastViewed(4)).toBe('kick-1');
  });

  it('an unbound store still gets a stable bucket rather than throwing', () => {
    hoisted.rack = null;
    setLastViewed(1, 'x');
    expect(lastViewed(1)).toBe('x');
    hoisted.rack = 'rack-a';
    expect(lastViewed(1)).toBeNull();
  });
});

describe('robustness', () => {
  it('corrupt JSON reads as "nothing remembered", never a throw', () => {
    localStorage.setItem(PUSH_VIEW_STORAGE_KEY, '{not json');
    expect(() => lastViewed(1)).not.toThrow();
    expect(lastViewed(1)).toBeNull();
    // …and a write repairs it.
    setLastViewed(1, 'a');
    expect(lastViewed(1)).toBe('a');
  });

  it('a well-formed but wrong-SHAPED entry is ignored', () => {
    localStorage.setItem(PUSH_VIEW_STORAGE_KEY, JSON.stringify({ 'rack-a': ['nope'] }));
    expect(lastViewed(1)).toBeNull();
    localStorage.setItem(PUSH_VIEW_STORAGE_KEY, JSON.stringify({ 'rack-a': { '1': 42 } }));
    expect(lastViewed(1)).toBeNull();
  });

  it('is LRU-capped, and the cap evicts the LEAST recently touched rack', () => {
    for (let i = 0; i < PUSH_VIEW_MAX_RACKS + 2; i++) {
      hoisted.rack = `rack-${i}`;
      setLastViewed(1, `m-${i}`);
    }
    const store = JSON.parse(localStorage.getItem(PUSH_VIEW_STORAGE_KEY)!);
    expect(Object.keys(store)).toHaveLength(PUSH_VIEW_MAX_RACKS);
    expect(store['rack-0'], 'the oldest rack was evicted').toBeUndefined();
    expect(store[`rack-${PUSH_VIEW_MAX_RACKS + 1}`], 'the newest survives').toBeDefined();
  });

  it('re-touching an old rack keeps it alive through an eviction round', () => {
    hoisted.rack = 'keeper';
    setLastViewed(1, 'k');
    for (let i = 0; i < PUSH_VIEW_MAX_RACKS - 1; i++) {
      hoisted.rack = `rack-${i}`;
      setLastViewed(1, `m-${i}`);
    }
    hoisted.rack = 'keeper';
    setLastViewed(1, 'k2'); // touch → moves to the most-recent end
    hoisted.rack = 'newcomer';
    setLastViewed(1, 'n');
    hoisted.rack = 'keeper';
    expect(lastViewed(1), 'a re-touched rack is not the LRU victim').toBe('k2');
  });

  it('an empty node id is neither WRITTEN nor read back', () => {
    // Asserted on BOTH layers on purpose: the read filter alone would make the
    // write guard redundant (a negative control proved exactly that), and a
    // guard no test can distinguish from its neighbour is not covered.
    setLastViewed(1, 'real');
    setLastViewed(2, '');
    expect(lastViewed(2)).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(PUSH_VIEW_STORAGE_KEY)!),
      'nothing junk was persisted either',
    ).toEqual({ 'rack-a': { '1': 'real' } });
  });
});
