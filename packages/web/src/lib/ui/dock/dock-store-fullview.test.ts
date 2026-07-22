// packages/web/src/lib/ui/dock/dock-store-fullview.test.ts
//
// The P0.3b TRANSIENT expanded full-view occupancy on dockStore. Proves it is
// per-tab transient view furniture — set/replace/close, ESC-order independent
// of the pinned drawer, cleared on rack rebind/unbind/closeAll, and NEVER
// persisted (the un-migrated auto-fallback must not touch storage / the Y.Doc).
//
// Uses the same runes-store-in-vitest pattern as skin-store.test.ts (a plain
// test file dynamically importing the `.svelte` runes module).

import { describe, it, expect, beforeEach } from 'vitest';

// A Map-backed localStorage shim so we can assert what (never) gets persisted.
class MemStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

const { dockStore } = await import('./dock-store.svelte');

let storage: MemStorage;
beforeEach(() => {
  storage = new MemStorage();
  dockStore.__setStorageForTest(storage);
  dockStore.bind('rack-A');
});

describe('dockStore full-view occupancy (transient)', () => {
  it('opens, reads, and closes the full-view node', () => {
    expect(dockStore.fullViewNodeId).toBeNull();
    dockStore.openFullView('mod-1');
    expect(dockStore.fullViewNodeId).toBe('mod-1');
    dockStore.closeFullView();
    expect(dockStore.fullViewNodeId).toBeNull();
  });

  it('opening a different node REPLACES the occupant (one-per-zone)', () => {
    dockStore.openFullView('mod-1');
    dockStore.openFullView('mod-2');
    expect(dockStore.fullViewNodeId).toBe('mod-2');
  });

  it('close is a no-op when already closed', () => {
    dockStore.closeFullView();
    expect(dockStore.fullViewNodeId).toBeNull();
  });

  it('un-collapses the bottom rail on open so the card shows', () => {
    dockStore.setRailCollapsed('bottom', true);
    expect(dockStore.railCollapsed('bottom')).toBe(true);
    dockStore.openFullView('mod-1');
    expect(dockStore.railCollapsed('bottom')).toBe(false);
  });

  it('is independent of the pinned drawer occupant (coexist + separate close)', () => {
    dockStore.toggle('bottom', 'pinned-mixmstrs'); // pinned occupant
    dockStore.openFullView('mod-1'); // full-view alongside it
    expect(dockStore.dockedNodeId('bottom')).toBe('pinned-mixmstrs');
    expect(dockStore.fullViewNodeId).toBe('mod-1');
    // closing the full-view leaves the pinned drawer untouched
    dockStore.closeFullView();
    expect(dockStore.fullViewNodeId).toBeNull();
    expect(dockStore.dockedNodeId('bottom')).toBe('pinned-mixmstrs');
  });

  it('is NOT persisted — a rebind of the same rack loses it', () => {
    dockStore.openFullView('mod-1');
    // persist runs on entry/rail writes; the full-view must never enter storage
    dockStore.dock('other', 'bottom', { x: 0, y: 0 }); // triggers #persist
    const raw = storage.getItem('pt.dock.v2:rack-A') ?? '';
    expect(raw).not.toContain('mod-1');
    expect(raw).not.toContain('fullView');
    // rebinding the rack clears the transient occupancy
    dockStore.bind('rack-A');
    expect(dockStore.fullViewNodeId).toBeNull();
  });

  it('closeAll + unbind clear the full-view', () => {
    dockStore.openFullView('mod-1');
    dockStore.closeAll();
    expect(dockStore.fullViewNodeId).toBeNull();

    dockStore.openFullView('mod-2');
    dockStore.unbind();
    expect(dockStore.fullViewNodeId).toBeNull();
  });
});
