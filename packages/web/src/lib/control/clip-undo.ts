// packages/web/src/lib/control/clip-undo.ts
//
// A launchpad-STYLE, origin-scoped undo/redo seam for clip-player PERSISTENT
// edits, driven from the CARD's control-strip ↶/↷ buttons (control-strip
// buttons 6/7, computer keys 6/7). It mirrors the single-pad Launchpad's own
// CC96/CC97 undo (`lpUndo` in launchpad-control): a `Y.UndoManager` over the
// patch's `nodes` Y.Map, scoped to a dedicated ORIGIN so it captures ONLY the
// card's own persistent clip edits (notes / scale / length / clip-div / swing /
// paste / scene-repeat / double / reverse) and NEVER a collaborator's edit
// (different origin) or a transient launch (no origin — see the card's
// queueLane, which transacts un-tagged).
//
// DECISION (owner Q1 — "launchpad-scoped lpUndo factored to shared, if clean;
// else global — your judgment, note it"): the card gets the SAME KIND of scoped
// undo as the launchpad, in this shared module, rather than the global app
// Cmd-Z (`undoManager` in store.ts, which the card's data edits never join
// anyway — they transact without LOCAL_ORIGIN). We deliberately do NOT fold the
// launchpad's own `lpUndo` into this module in THIS change: that manager is
// created/destroyed inside the launchpad's start()/stop() lifecycle and reset by
// its test seam, and unifying the two into one refcounted cross-surface stack is
// a larger, launchpad-lifecycle-touching refactor best done on its own. Each
// surface therefore undoes its OWN persistent edits (distinct origins); merging
// them into a single shared stack is a clean follow-up.

import * as Y from 'yjs';
import { getYjsValue } from '@syncedstore/core';
import { patch, ydoc } from '$lib/graph/store';

/** Origin tag for card-authored persistent clip edits. A dedicated Symbol so an
 *  origin-scoped UndoManager captures ONLY these — never a peer's edit or a
 *  transient (un-tagged) launch. */
export const CLIP_UNDO_ORIGIN = Symbol('clip-card-undo-origin');

let mgr: Y.UndoManager | null = null;
// The Y type the current manager tracks — used to detect a rackspace rebind
// (store.ts swaps `patch`/`ydoc` for a fresh doc) and rebuild against the new doc.
let mgrYType: unknown = null;

/** Lazily build (or rebuild after a doc rebind) the origin-scoped manager over
 *  the live `nodes` Y.Map. Must exist BEFORE an edit transacts for it to capture
 *  it, so every write path calls this first. Null on any failure (undo simply
 *  stays unavailable — never throws into the card). */
function ensureManager(): Y.UndoManager | null {
  let yNodes: Y.AbstractType<unknown> | undefined;
  try {
    yNodes = getYjsValue(patch.nodes) as Y.AbstractType<unknown> | undefined;
  } catch {
    return mgr;
  }
  if (!yNodes) return mgr;
  if (mgr && mgrYType === yNodes) return mgr;
  // A fresh doc (or first use) → drop the stale manager + build against this one.
  if (mgr) {
    try { mgr.destroy(); } catch { /* ignore */ }
    mgr = null;
  }
  try {
    mgr = new Y.UndoManager(yNodes, {
      trackedOrigins: new Set<unknown>([CLIP_UNDO_ORIGIN]),
      captureTimeout: 300,
    });
    mgrYType = yNodes;
  } catch {
    mgr = null;
    mgrYType = null;
  }
  return mgr;
}

/**
 * Run `mut` inside a ydoc transaction tagged with CLIP_UNDO_ORIGIN so this edit
 * lands on the card's undo stack. Ensures the manager exists FIRST (a manager
 * built after the edit would miss it). Use ONLY for persistent, undoable edits;
 * transient launches / view state must transact un-tagged (never undoable).
 */
export function clipUndoTransact(mut: () => void): void {
  ensureManager();
  ydoc.transact(mut, CLIP_UNDO_ORIGIN);
}

/** Is there a card-authored edit to undo? */
export function clipCanUndo(): boolean {
  const m = ensureManager();
  return !!m && m.undoStack.length > 0;
}
/** Is there an undone card edit to redo? */
export function clipCanRedo(): boolean {
  const m = ensureManager();
  return !!m && m.redoStack.length > 0;
}
/** Undo the last card-authored persistent clip edit (no-op if the stack empty). */
export function clipUndo(): void {
  const m = ensureManager();
  if (m && m.undoStack.length > 0) m.undo();
}
/** Redo the last undone card-authored clip edit (no-op if the stack empty). */
export function clipRedo(): void {
  const m = ensureManager();
  if (m && m.redoStack.length > 0) m.redo();
}

/** TEST-ONLY: drop the manager so the next use rebuilds a fresh, empty stack.
 *  (The card never resets mid-session; e2e runs on a fresh page.) */
export function __test_resetClipUndo(): void {
  if (mgr) {
    try { mgr.destroy(); } catch { /* ignore */ }
  }
  mgr = null;
  mgrYType = null;
}
