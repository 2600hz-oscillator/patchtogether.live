// Unit tests for per-user layout helpers (Stage B PR B-b).
// Pure Yjs — no browser, no DOM. Validates the schema split semantics
// before relying on them in Canvas.svelte.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  getNodePosition,
  setNodePosition,
  clearNodePosition,
  pruneStaleLayoutEntries,
} from './layouts';

const FALLBACK = { x: 100, y: 100 };

describe('layouts', () => {
  describe('getNodePosition', () => {
    it('returns the fallback when currentUserId is undefined (single-user mode)', () => {
      const ydoc = new Y.Doc();
      expect(getNodePosition(ydoc, undefined, 'n1', FALLBACK)).toEqual(FALLBACK);
    });

    it('returns the fallback when the user has no layout entry yet', () => {
      const ydoc = new Y.Doc();
      expect(getNodePosition(ydoc, 'user-a', 'n1', FALLBACK)).toEqual(FALLBACK);
    });

    it('returns the user-specific override when one exists', () => {
      const ydoc = new Y.Doc();
      setNodePosition(ydoc, 'user-a', 'n1', { x: 500, y: 300 });
      expect(getNodePosition(ydoc, 'user-a', 'n1', FALLBACK)).toEqual({ x: 500, y: 300 });
    });

    it('keeps user-A and user-B layouts strictly separate', () => {
      const ydoc = new Y.Doc();
      setNodePosition(ydoc, 'user-a', 'n1', { x: 500, y: 300 });
      setNodePosition(ydoc, 'user-b', 'n1', { x: 700, y: 400 });
      expect(getNodePosition(ydoc, 'user-a', 'n1', FALLBACK)).toEqual({ x: 500, y: 300 });
      expect(getNodePosition(ydoc, 'user-b', 'n1', FALLBACK)).toEqual({ x: 700, y: 400 });
    });

    it('falls back when user-A has an entry but user-B is reading', () => {
      const ydoc = new Y.Doc();
      setNodePosition(ydoc, 'user-a', 'n1', { x: 500, y: 300 });
      // user-b has no entry — sees the fallback (creator's intent or default).
      expect(getNodePosition(ydoc, 'user-b', 'n1', FALLBACK)).toEqual(FALLBACK);
    });
  });

  describe('setNodePosition', () => {
    it('is a no-op when currentUserId is undefined', () => {
      const ydoc = new Y.Doc();
      setNodePosition(ydoc, undefined, 'n1', { x: 1, y: 2 });
      // No layouts map should have been created with a user entry.
      const layouts = ydoc.getMap('layouts');
      expect(layouts.size).toBe(0);
    });

    it('creates the user layout map on first write', () => {
      const ydoc = new Y.Doc();
      setNodePosition(ydoc, 'user-a', 'n1', { x: 10, y: 20 });
      const layouts = ydoc.getMap<Y.Map<unknown>>('layouts');
      expect(layouts.has('user-a')).toBe(true);
      expect((layouts.get('user-a') as Y.Map<unknown>).get('n1')).toEqual({ x: 10, y: 20 });
    });

    it('overwrites a previous entry for the same node', () => {
      const ydoc = new Y.Doc();
      setNodePosition(ydoc, 'user-a', 'n1', { x: 10, y: 20 });
      setNodePosition(ydoc, 'user-a', 'n1', { x: 999, y: 888 });
      expect(getNodePosition(ydoc, 'user-a', 'n1', FALLBACK)).toEqual({ x: 999, y: 888 });
    });

    it('emits a single Yjs update per call (atomic via transact)', () => {
      const ydoc = new Y.Doc();
      let updateCount = 0;
      ydoc.on('update', () => updateCount++);
      setNodePosition(ydoc, 'user-a', 'n1', { x: 1, y: 2 });
      // Both the layouts-map create AND the entry write should land in one update.
      expect(updateCount).toBe(1);
    });
  });

  describe('Yjs CRDT semantics across two replicas', () => {
    it('user-A drag does NOT propagate user-B layout when both docs sync', () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      // Wire bidirectional sync.
      docA.on('update', (u) => Y.applyUpdate(docB, u));
      docB.on('update', (u) => Y.applyUpdate(docA, u));

      setNodePosition(docA, 'user-a', 'n1', { x: 200, y: 200 });
      setNodePosition(docB, 'user-b', 'n1', { x: 700, y: 400 });

      // After bidirectional sync each doc has BOTH user entries — but each
      // user's getNodePosition only reads their own.
      expect(getNodePosition(docA, 'user-a', 'n1', FALLBACK)).toEqual({ x: 200, y: 200 });
      expect(getNodePosition(docA, 'user-b', 'n1', FALLBACK)).toEqual({ x: 700, y: 400 });
      expect(getNodePosition(docB, 'user-a', 'n1', FALLBACK)).toEqual({ x: 200, y: 200 });
      expect(getNodePosition(docB, 'user-b', 'n1', FALLBACK)).toEqual({ x: 700, y: 400 });
    });
  });

  describe('clearNodePosition', () => {
    it('removes a per-user entry', () => {
      const ydoc = new Y.Doc();
      setNodePosition(ydoc, 'user-a', 'n1', { x: 1, y: 2 });
      clearNodePosition(ydoc, 'user-a', 'n1');
      expect(getNodePosition(ydoc, 'user-a', 'n1', FALLBACK)).toEqual(FALLBACK);
    });

    it('is idempotent on a missing entry', () => {
      const ydoc = new Y.Doc();
      clearNodePosition(ydoc, 'user-a', 'n1'); // never set; should not throw
      expect(getNodePosition(ydoc, 'user-a', 'n1', FALLBACK)).toEqual(FALLBACK);
    });

    it('is a no-op when currentUserId is undefined', () => {
      const ydoc = new Y.Doc();
      clearNodePosition(ydoc, undefined, 'n1'); // should not create the layouts map
      expect(ydoc.getMap('layouts').size).toBe(0);
    });
  });

  describe('pruneStaleLayoutEntries', () => {
    it('drops entries for nodes that are no longer in the patch', () => {
      const ydoc = new Y.Doc();
      setNodePosition(ydoc, 'user-a', 'n1', { x: 1, y: 1 });
      setNodePosition(ydoc, 'user-a', 'n2', { x: 2, y: 2 });
      setNodePosition(ydoc, 'user-a', 'n3', { x: 3, y: 3 });
      // n2 has been deleted from the patch graph.
      pruneStaleLayoutEntries(ydoc, 'user-a', new Set(['n1', 'n3']));
      expect(getNodePosition(ydoc, 'user-a', 'n1', FALLBACK)).toEqual({ x: 1, y: 1 });
      expect(getNodePosition(ydoc, 'user-a', 'n2', FALLBACK)).toEqual(FALLBACK); // pruned
      expect(getNodePosition(ydoc, 'user-a', 'n3', FALLBACK)).toEqual({ x: 3, y: 3 });
    });

    it('is a no-op when the user has no layout map', () => {
      const ydoc = new Y.Doc();
      pruneStaleLayoutEntries(ydoc, 'user-a', new Set(['n1']));
      // Should not have created an empty user layout map.
      const layouts = ydoc.getMap('layouts');
      expect(layouts.has('user-a')).toBe(false);
    });
  });
});
