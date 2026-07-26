// packages/web/src/lib/ui/dock/dock-store-fullview.test.ts
//
// The P0.3b TRANSIENT expanded full-view occupancy on dockStore. Proves it is
// per-tab transient view furniture — open/close, cleared on rack
// rebind/unbind/closeAll, and NEVER persisted (the un-migrated auto-fallback
// must not touch storage / the Y.Doc) — and pins two owner design calls:
//
//  * DOCK UNIFICATION: the pinned M/E/C occupant and the full-view share ONE
//    bottom-drawer slot — pinned XOR full-view, never both.
//  * SIDE-BY-SIDE SPLIT: the full-view holds up to TWO modules in OPEN order
//    (index 0 = opened first = rendered left); a third replaces the
//    least-recently-opened; closing one pane keeps the other; ESC / the
//    M-E-C handoff close the WHOLE view. Plus the TAB rear-card flip seam
//    (state only).
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
  it('opens, reads, and closes a full-view pane', () => {
    expect(dockStore.fullViewNodeIds).toEqual([]);
    dockStore.openFullView('mod-1');
    expect(dockStore.fullViewNodeIds).toEqual(['mod-1']);
    expect(dockStore.isFullView('mod-1')).toBe(true);
    dockStore.closeFullView('mod-1');
    expect(dockStore.fullViewNodeIds).toEqual([]);
    expect(dockStore.isFullView('mod-1')).toBe(false);
  });

  it('close is a no-op when already closed', () => {
    dockStore.closeFullView();
    expect(dockStore.fullViewNodeIds).toEqual([]);
  });

  it('un-collapses the bottom rail on open so the card shows', () => {
    dockStore.setRailCollapsed('bottom', true);
    expect(dockStore.railCollapsed('bottom')).toBe(true);
    dockStore.openFullView('mod-1');
    expect(dockStore.railCollapsed('bottom')).toBe(false);
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
    expect(dockStore.fullViewNodeIds).toEqual([]);
  });

  it('closeAll + unbind clear the full-view', () => {
    dockStore.openFullView('mod-1');
    dockStore.closeAll();
    expect(dockStore.fullViewNodeIds).toEqual([]);

    dockStore.openFullView('mod-2');
    dockStore.unbind();
    expect(dockStore.fullViewNodeIds).toEqual([]);
  });
});

describe('dockStore full-view SPLIT (up to two side-by-side panes)', () => {
  it('a second open SPLITS side-by-side in open order (first = left)', () => {
    dockStore.openFullView('mod-A');
    dockStore.openFullView('mod-B');
    expect(dockStore.fullViewNodeIds).toEqual(['mod-A', 'mod-B']);
    expect(dockStore.isFullView('mod-A')).toBe(true);
    expect(dockStore.isFullView('mod-B')).toBe(true);
  });

  it('a third open replaces the LEAST-RECENTLY-OPENED pane', () => {
    dockStore.openFullView('mod-A');
    dockStore.openFullView('mod-B');
    dockStore.openFullView('mod-C');
    expect(dockStore.fullViewNodeIds).toEqual(['mod-B', 'mod-C']);
    expect(dockStore.isFullView('mod-A')).toBe(false);
  });

  it('re-opening a current occupant is a no-op (no reorder, no duplicate)', () => {
    dockStore.openFullView('mod-A');
    dockStore.openFullView('mod-B');
    dockStore.openFullView('mod-A');
    expect(dockStore.fullViewNodeIds).toEqual(['mod-A', 'mod-B']);
  });

  it('closing ONE pane keeps the other (survivor returns to full width)', () => {
    dockStore.openFullView('mod-A');
    dockStore.openFullView('mod-B');
    dockStore.closeFullView('mod-A');
    expect(dockStore.fullViewNodeIds).toEqual(['mod-B']);
  });

  it('closeFullView() with no argument closes the WHOLE split (the ESC path)', () => {
    dockStore.openFullView('mod-A');
    dockStore.openFullView('mod-B');
    dockStore.closeFullView();
    expect(dockStore.fullViewNodeIds).toEqual([]);
  });

  it('closing a non-occupant id changes nothing', () => {
    dockStore.openFullView('mod-A');
    dockStore.closeFullView('mod-X');
    expect(dockStore.fullViewNodeIds).toEqual(['mod-A']);
  });
});

describe('dockStore full-view FLIP seam (TAB rear-card follow-up)', () => {
  it('starts un-flipped; toggling while CLOSED is a no-op', () => {
    expect(dockStore.fullViewFlipped).toBe(false);
    dockStore.toggleFullViewFlipped();
    expect(dockStore.fullViewFlipped).toBe(false);
  });

  it('toggles while open (global for the view) and RESETS when the view empties', () => {
    dockStore.openFullView('mod-A');
    dockStore.openFullView('mod-B');
    dockStore.toggleFullViewFlipped();
    expect(dockStore.fullViewFlipped).toBe(true);
    // closing ONE pane keeps the flip (the view is still open)
    dockStore.closeFullView('mod-A');
    expect(dockStore.fullViewFlipped).toBe(true);
    // emptying the view resets it
    dockStore.closeFullView('mod-B');
    expect(dockStore.fullViewFlipped).toBe(false);
  });

  it('resets on the M/E/C handoff too (the whole view closes)', () => {
    dockStore.openFullView('mod-A');
    dockStore.toggleFullViewFlipped();
    dockStore.toggle('bottom', 'pinned-clipplayer');
    expect(dockStore.fullViewFlipped).toBe(false);
  });
});

describe('dockStore bottom occupancy: pinned XOR full-view (dock unification)', () => {
  it('openFullView CLOSES an open pinned drawer (one bottom occupant)', () => {
    dockStore.toggle('bottom', 'pinned-mixmstrs'); // pinned occupant open
    dockStore.openFullView('mod-1'); // EXPAND replaces it
    expect(dockStore.fullViewNodeIds).toEqual(['mod-1']);
    expect(dockStore.dockedNodeId('bottom')).toBeNull();
    expect(dockStore.bottomOccupant).toEqual({ kind: 'fullView', nodeIds: ['mod-1'] });
    // closing the full-view leaves the drawer EMPTY — the pinned occupant was
    // replaced, not shelved behind it
    dockStore.closeFullView();
    expect(dockStore.bottomOccupant).toBeNull();
  });

  it("toggle('bottom') while the full-view is open CLOSES the WHOLE split and OPENS the pinned drawer", () => {
    dockStore.openFullView('mod-1');
    dockStore.openFullView('mod-2'); // split
    dockStore.toggle('bottom', 'pinned-clipplayer'); // the C hotkey path
    expect(dockStore.fullViewNodeIds).toEqual([]);
    expect(dockStore.dockedNodeId('bottom')).toBe('pinned-clipplayer');
    expect(dockStore.bottomOccupant).toEqual({ kind: 'pinned', nodeId: 'pinned-clipplayer' });
  });

  it('the handoff ALWAYS opens the requested drawer — even re-toggling the id the full-view replaced', () => {
    dockStore.toggle('bottom', 'pinned-clipplayer'); // C open
    dockStore.openFullView('mod-1'); // EXPAND closes it
    dockStore.toggle('bottom', 'pinned-clipplayer'); // C again → reopens, never "both closed"
    expect(dockStore.fullViewNodeIds).toEqual([]);
    expect(dockStore.dockedNodeId('bottom')).toBe('pinned-clipplayer');
  });

  it('non-bottom zones never touch the full-view occupants', () => {
    dockStore.openFullView('mod-1');
    dockStore.toggle('top', 'some-node');
    dockStore.toggle('left', 'other-node');
    expect(dockStore.fullViewNodeIds).toEqual(['mod-1']);
  });
});
