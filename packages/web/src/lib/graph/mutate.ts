// packages/web/src/lib/graph/mutate.ts
//
// ORIGIN-TAGGED MUTATION SEAM (Phase 3a / FW2).
//
// The single shared primitive for editing a patch node's live Yjs state. Every
// write goes through one `ydoc.transact(fn, origin)` so it:
//   - rides the Y.Doc to rack-mates (collab), and
//   - registers on the local UndoManager — but ONLY when tagged LOCAL_ORIGIN.
//
// WHY THIS EXISTS — the undo bypass it closes
// --------------------------------------------
// The UndoManager (graph/store.ts) is configured with
// `trackedOrigins: new Set([LOCAL_ORIGIN])`. It therefore captures an edit for
// Cmd-Z ONLY when that edit's transaction was tagged with LOCAL_ORIGIN. Any
// write that does NOT pass LOCAL_ORIGIN — a bare `patch.nodes[id].params[p] = v`
// (SyncedStore's proxy transacts with NO origin), or a transact tagged with some
// other origin — is silently NOT undoable. Across ~141 card call-sites this is
// the difference between "Cmd-Z reverts my knob turn" and "Cmd-Z does nothing".
//
// `origin` is the real axis here, not a boolean "undoable" flag:
//   - default `LOCAL_ORIGIN`  → tracked → UNDOABLE (the overwhelmingly common case),
//   - any non-tracked origin  → not tracked → DELIBERATELY non-undoable (e.g. a
//     programmatic / reconciler write that must not pollute the user's undo stack).
//
// This GENERALIZES three partial helpers that already implement the exact
// pattern — control-surface.ts `mutateSurface`, control-surface-params.ts's
// in-transact re-resolve, and electra/host.ts `writeParam` — into one shared
// API. (Migrating those + the ~141 card call-sites onto this seam is Phase 5;
// this PR builds + tests the primitive only.)
//
// CRITICAL — never reassign an integrated Y type ([[yjs-save-load-real-ydoc]])
// ----------------------------------------------------------------------------
// `fn` receives the LIVE node, re-read from `patch.nodes[nodeId]` INSIDE the
// transaction, and MUST mutate it IN PLACE (set a key, push/splice an array).
// It must NEVER rebuild-and-reassign an array/object that holds already-
// integrated Y types (e.g. `live.data = {...live.data, x}` or
// `live.params = {...live.params}`) — Yjs throws "Type already integrated".
// Re-reading inside the transact also guards against a remote write having
// swapped the node's backing types out between render and mutation.
//
// `patch` / `ydoc` / `LOCAL_ORIGIN` are imported as LIVE ESM bindings from the
// store. `bindRackspace()` REASSIGNS the `patch` / `ydoc` `let` exports when the
// user enters a different rackspace, so we must read them live on every call —
// which importing the bindings (rather than capturing them once) gives us for
// free: each `ydoc.transact(...)` / `patch.nodes[...]` reads the current value.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

/** Options shared by the mutation helpers. */
export interface MutateOptions {
  /**
   * Yjs transaction origin. Defaults to `LOCAL_ORIGIN` (tracked by the
   * UndoManager → the edit is undoable). Pass a different (non-tracked) origin
   * to make a DELIBERATELY non-undoable write — e.g. a programmatic reconciler
   * edit that should not land on the user's Cmd-Z stack.
   */
  origin?: unknown;
}

/**
 * Mutate the live node `nodeId` inside one origin-tagged Yjs transaction.
 *
 * `fn` receives the LIVE node (re-read from `patch.nodes[nodeId]` INSIDE the
 * transaction) and must mutate it IN PLACE — never reassign an integrated Y
 * type (see the file header). When `nodeId` is absent, the call is a safe
 * no-op (and opens no transaction, so it adds no undo churn).
 *
 * @param nodeId  the patch node to edit
 * @param fn      in-place mutator, given the live node
 * @param options `{ origin = LOCAL_ORIGIN }` — the transaction origin
 */
export function mutateNode(
  nodeId: string,
  fn: (node: ModuleNode) => void,
  { origin = LOCAL_ORIGIN }: MutateOptions = {},
): void {
  ydoc.transact(() => {
    const live = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!live) return; // node gone (deleted / not yet synced) → safe no-op
    fn(live);
  }, origin);
}

/**
 * Set a single flat param (`node.params[paramId] = value`) on `nodeId` inside
 * one origin-tagged transaction. The undoable common case for a knob/slider
 * write; equivalent to the bare proxy assignment but tagged so it lands on the
 * undo stack (or, with a non-tracked `origin`, deliberately does not). No-op
 * when the node is absent.
 *
 * Writes IN PLACE onto the live `params` map — never reassigns it.
 *
 * @param nodeId  the patch node
 * @param paramId the flat param key (`node.params[paramId]`)
 * @param value   the new numeric value
 * @param options `{ origin = LOCAL_ORIGIN }`
 */
export function setNodeParam(
  nodeId: string,
  paramId: string,
  value: number,
  options: MutateOptions = {},
): void {
  mutateNode(
    nodeId,
    (live) => {
      live.params[paramId] = value; // set a single key in place
    },
    options,
  );
}

/**
 * Set (or clear) the SOURCE module's "control colour" — `node.data.controlColor`
 * — a 6-digit uppercase hex string (e.g. `'F45C51'`). This is the per-module tag
 * colour that the Control Surface / ElectraControl stripes + the Electra preset
 * all read LIVE as PASSTHROUGH (they never copy it). A `null` hex deletes the
 * key, reverting the module to its auto default (control-color.ts
 * defaultColorFor). No-op when the node is absent.
 *
 * Writes a SINGLE key in place onto the live `data` map — never reassigns it
 * (the [[yjs-save-load-real-ydoc]] "Type already integrated" trap). It is a
 * one-time user action (right-click → pick), never a per-frame write, so there
 * is no update-storm risk ([[cv-modulation-live-store-write-storm]]).
 *
 * @param nodeId the SOURCE module whose tag colour to set
 * @param hex    the 6-digit uppercase hex, or `null` to clear (auto default)
 * @param options `{ origin = LOCAL_ORIGIN }` — the transaction origin
 */
export function setControlColor(
  nodeId: string,
  hex: string | null,
  options: MutateOptions = {},
): void {
  mutateNode(
    nodeId,
    (live) => {
      if (!live.data) live.data = {};
      if (hex === null) {
        delete live.data.controlColor; // clear → revert to auto default
      } else {
        live.data.controlColor = hex; // set a single key in place
      }
    },
    options,
  );
}
