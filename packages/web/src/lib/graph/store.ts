// packages/web/src/lib/graph/store.ts
//
// SyncedStore over Yjs. There is one logical patch graph at a time, exposed
// as `patch` / `ydoc` / `undoManager` — but the underlying Y.Doc is REBOUND
// every time the user enters a rackspace, so each rackspace gets a fresh,
// isolated doc. Before this rebinding existed, the singleton Y.Doc was
// shared across all rackspaces in the same JS context: navigating
// `/r/A` → `/r/B` re-attached the provider for B to the same doc that
// still held A's data, and A's nodes/edges were uploaded into B's room.
// The result was the "edits leak across all 4 rackspaces" report.
//
// Consumers import the bindings as live ESM bindings (`import { patch,
// ydoc } from '$lib/graph/store'`). When `bindRackspace(rackspaceId)`
// reassigns them in this module, all import sites observe the new value.
// The rackspace page wraps its canvas in `{#key rackspaceId}` so every
// reactive subscription tears down and reattaches to the fresh proxy.

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

// --- Rebindable singleton ------------------------------------------------
//
// `patch` / `ydoc` / `undoManager` are `let` exports so they form LIVE
// import bindings: when `bindRackspace()` reassigns them below, every
// `import { patch } from '$lib/graph/store'` consumer observes the new
// value on the next read. Svelte's `$effect` / `$derived` runes don't
// auto-rerun on a non-rune reassignment, so the rackspace page wraps
// `<Canvas>` in `{#key data.rackspace.id}` to force a full remount of
// subscribers when the rackspace id changes.

let _bundle = createPatch();
let _boundRackspaceId: string | null = null;

/** Current Y.Doc backing the patch graph. Reassigned by bindRackspace(). */
export let patch = _bundle.patch;
/** Current low-level Y.Doc. */
export let ydoc = _bundle.ydoc;
/** Current UndoManager (tracks the current ydoc). */
export let undoManager = _bundle.undoManager;

/**
 * Bind the singleton to a fresh store for `rackspaceId`. Idempotent for
 * the same id — repeated calls are a no-op. Calling with a different id
 * destroys the previous doc + UndoManager and swaps in a new trio.
 *
 * MUST be called BEFORE attaching the HocuspocusProvider for a rackspace.
 * Otherwise the existing doc's contents (left over from a prior rackspace
 * mount in the same JS context) get uploaded into the new rackspace's
 * Hocuspocus room, corrupting it for every participant.
 *
 * Returns the new bindings so callers can capture stable references for
 * the lifetime of one mount.
 */
export function bindRackspace(rackspaceId: string): {
  patch: typeof patch;
  ydoc: typeof ydoc;
  undoManager: typeof undoManager;
} {
  if (_boundRackspaceId === rackspaceId) {
    return { patch, ydoc, undoManager };
  }
  // Tear down the previous bundle so observers + Yjs internals don't leak
  // across rackspace boundaries. UndoManager.destroy() unsubscribes its
  // observer; ydoc.destroy() releases the doc + emits destroyed events.
  try {
    _bundle.undoManager.destroy();
  } catch {
    /* ignore */
  }
  try {
    _bundle.ydoc.destroy();
  } catch {
    /* ignore */
  }
  _bundle = createPatch();
  patch = _bundle.patch;
  ydoc = _bundle.ydoc;
  undoManager = _bundle.undoManager;
  _boundRackspaceId = rackspaceId;
  return { patch, ydoc, undoManager };
}

/**
 * Currently-bound rackspace id, or `null` if `bindRackspace()` has never
 * been called. Exposed for tests + diagnostics.
 */
export function getBoundRackspaceId(): string | null {
  return _boundRackspaceId;
}

/**
 * Tear down the current bundle without binding a replacement. Used on
 * navigation AWAY from a rackspace (e.g. back to the dashboard) so the
 * next rackspace mount starts from a clean slate even if it shares an id
 * with a previous mount.
 */
export function unbindRackspace(): void {
  if (_boundRackspaceId === null) return;
  try {
    _bundle.undoManager.destroy();
  } catch {
    /* ignore */
  }
  try {
    _bundle.ydoc.destroy();
  } catch {
    /* ignore */
  }
  _bundle = createPatch();
  patch = _bundle.patch;
  ydoc = _bundle.ydoc;
  undoManager = _bundle.undoManager;
  _boundRackspaceId = null;
}
