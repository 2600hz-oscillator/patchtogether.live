// packages/web/src/lib/graph/store.ts
//
// SyncedStore over Yjs from day 1 (D8). Phase 1 has no provider attached;
// Phase 4 attaches a HocuspocusProvider and multiplayer turns on with no
// changes to the consumer-facing API.

import { syncedStore, getYjsDoc } from '@syncedstore/core';
import * as Y from 'yjs';
import type { ModuleNode, Edge } from './types';

/** Shape of the synced patch graph. Type alias (not interface) so the
 * implicit index signature satisfies SyncedStore's `DocTypeDescription`. */
export type PatchStore = {
  nodes: Record<string, ModuleNode>;
  edges: Record<string, Edge>;
};

/** Create a fresh patch store backed by a Y.Doc. */
export function createPatch() {
  const patch = syncedStore<PatchStore>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(patch);
  const undoManager = new Y.UndoManager([
    ydoc.getMap('nodes'),
    ydoc.getMap('edges'),
  ], {
    captureTimeout: 500,
  });
  return { patch, ydoc, undoManager };
}

/** Singleton patch for Phase 1 (one canvas per page). Phase 3+ creates per-route. */
export const { patch, ydoc, undoManager } = createPatch();
