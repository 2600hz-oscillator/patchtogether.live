// Unit coverage for the rackspace-bound singleton in graph/store.
//
// The user report: deleting or changing modules/edges in one rackspace
// also mutated the other 3 rackspaces in the same browser session. Root
// cause: `patch`/`ydoc`/`undoManager` were `export const`, so navigating
// between rackspaces re-attached the new rackspace's HocuspocusProvider
// to the SAME Y.Doc that still held the previous rackspace's data — the
// merged state was then uploaded into the new room.
//
// These tests lock the behaviour we now require:
//   1. bindRackspace(A) gives a fresh, empty doc.
//   2. bindRackspace(A) called again is idempotent — same doc, no data wipe.
//   3. bindRackspace(B) after bindRackspace(A) swaps to a DIFFERENT doc;
//      A's data does NOT bleed into B.
//   4. unbindRackspace() releases the current doc and the next bind starts
//      from a clean slate, even if the new id matches the previous one.
//   5. The exported `patch`/`ydoc` live bindings reassign on each bind so
//      consumer modules' `import { patch }` reads see the new proxy.

import { describe, it, expect, beforeEach } from 'vitest';
import * as storeModule from './store';
import { bindRackspace, unbindRackspace, getBoundRackspaceId } from './store';
import type { ModuleNode } from './types';

function addVcoNode(patch: typeof storeModule.patch, id: string) {
  patch.nodes[id] = {
    id,
    type: 'analogVco',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
  } as ModuleNode;
}

describe('bindRackspace — isolation across rackspaces', () => {
  beforeEach(() => {
    // Every test starts from a fully-unbound state so the order of tests
    // can't leak state between describes.
    unbindRackspace();
  });

  it('binds a fresh empty doc on first call', () => {
    const bound = bindRackspace('rack-A');
    expect(getBoundRackspaceId()).toBe('rack-A');
    expect(Object.keys(bound.patch.nodes).length).toBe(0);
    expect(Object.keys(bound.patch.edges).length).toBe(0);
  });

  it('is idempotent for the same id — preserves existing data', () => {
    const first = bindRackspace('rack-A');
    addVcoNode(first.patch, 'persist-me');
    const second = bindRackspace('rack-A');
    expect(second.ydoc).toBe(first.ydoc);
    expect(second.patch.nodes['persist-me']).toBeDefined();
  });

  it('swaps to a fresh doc when the id changes — A data does NOT leak into B', () => {
    const a = bindRackspace('rack-A');
    addVcoNode(a.patch, 'only-in-A');
    expect(Object.keys(a.patch.nodes)).toEqual(['only-in-A']);

    const b = bindRackspace('rack-B');
    // Different Y.Doc instance:
    expect(b.ydoc).not.toBe(a.ydoc);
    // The new doc is empty — A's node didn't bleed into B:
    expect(b.patch.nodes['only-in-A']).toBeUndefined();
    expect(Object.keys(b.patch.nodes).length).toBe(0);
    expect(getBoundRackspaceId()).toBe('rack-B');
  });

  it('the live module exports reassign on every swap', () => {
    bindRackspace('rack-A');
    const aDoc = storeModule.ydoc;
    const aPatch = storeModule.patch;
    addVcoNode(aPatch, 'leftover');

    bindRackspace('rack-B');
    // The module-level binding now points at the new doc:
    expect(storeModule.ydoc).not.toBe(aDoc);
    expect(storeModule.patch).not.toBe(aPatch);
    // And the module's `patch.nodes` is empty (B's view):
    expect(Object.keys(storeModule.patch.nodes).length).toBe(0);
  });

  it('unbindRackspace clears the bound id and gives a fresh doc on next bind, even for the same id', () => {
    const a = bindRackspace('rack-A');
    addVcoNode(a.patch, 'before-unbind');
    expect(a.patch.nodes['before-unbind']).toBeDefined();

    unbindRackspace();
    expect(getBoundRackspaceId()).toBeNull();

    // Same id, but fresh doc — this models the user navigating away and
    // back to the same rackspace; they should see whatever the server has
    // (which the provider re-syncs), not stale in-memory state.
    const a2 = bindRackspace('rack-A');
    expect(a2.ydoc).not.toBe(a.ydoc);
    expect(a2.patch.nodes['before-unbind']).toBeUndefined();
  });

  it('round-trip A → B → A gives THREE distinct docs (no doc reuse across visits)', () => {
    const a1 = bindRackspace('rack-A');
    addVcoNode(a1.patch, 'in-A1');

    const b = bindRackspace('rack-B');
    addVcoNode(b.patch, 'in-B');

    const a2 = bindRackspace('rack-A');
    // The second visit to A starts from a clean doc — its contents will be
    // re-synced by the HocuspocusProvider attaching, not carried over from
    // the in-memory state of the first visit.
    expect(a2.ydoc).not.toBe(a1.ydoc);
    expect(a2.ydoc).not.toBe(b.ydoc);
    expect(a2.patch.nodes['in-A1']).toBeUndefined();
    expect(a2.patch.nodes['in-B']).toBeUndefined();
  });

  it('UndoManager is bound to the CURRENT ydoc, not a stale one', () => {
    const a = bindRackspace('rack-A');
    // UndoManager is wired to two Y.Maps — capturing requires they belong
    // to `a.ydoc`. We sanity-check via the tracked-origins shape.
    expect(a.undoManager.trackedOrigins.size).toBeGreaterThan(0);

    const b = bindRackspace('rack-B');
    // A NEW UndoManager comes back — not the same instance as A's.
    expect(b.undoManager).not.toBe(a.undoManager);
  });
});
