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

/**
 * Marker object Yjs uses to distinguish edits this client made from edits
 * that arrived over the wire. We pass it as the `origin` argument to every
 * `ydoc.transact(fn, LOCAL_ORIGIN)` and configure the UndoManager with
 * `trackedOrigins=[LOCAL_ORIGIN]`. Net effect: Cmd-Z only undoes changes
 * THIS user just made — never a remote collaborator's.
 *
 * Multiplayer expectation: my undo undoes my last action, not yours. See
 * Yjs docs on UndoManager + trackedOrigins.
 */
export const LOCAL_ORIGIN = Symbol('local-undo-origin');

/** Create a fresh patch store backed by a Y.Doc. */
export function createPatch() {
  const patch = syncedStore<PatchStore>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(patch);
  const undoManager = createUndoManager(ydoc);
  return { patch, ydoc, undoManager };
}

/**
 * Build a Y.UndoManager that tracks the patch graph (nodes + edges) and
 * only captures edits authored by this client (origin === LOCAL_ORIGIN).
 *
 * `captureTimeout: 500` collapses bursts of edits within a 500ms window
 * into a single undo unit. Without it, every 1°-knob-tick during a
 * fader-drag would be its own undo entry — Cmd-Z would feel like it does
 * almost nothing per press. With it, a drag-then-release becomes one
 * undoable action; then a separate add-node a moment later is a second.
 *
 * Structural ops (add node, delete edge, etc.) executed inside a single
 * ydoc.transact still collapse to one entry regardless of timeout.
 */
export function createUndoManager(ydoc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(
    [ydoc.getMap('nodes'), ydoc.getMap('edges')],
    {
      captureTimeout: 500,
      trackedOrigins: new Set<unknown>([LOCAL_ORIGIN]),
    },
  );
}

/** Singleton patch for Phase 1 (one canvas per page). Phase 3+ creates per-route. */
export const { patch, ydoc, undoManager } = createPatch();
