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
// PER-CARD SCOPE (adversarial-review fix): the manager + its tracked origin are
// keyed by NODE id, so each clip-player card has its OWN undo stack. Undoing on
// card A must never revert card B's edit. A single shared manager/origin (the
// original design) leaked across sibling cards: a `Y.UndoManager` filters by
// `trackedOrigins`, so two cards transacting under the SAME origin would each
// capture the other's edit — undo A would pop B's change. Every card therefore
// gets a distinct per-node origin Symbol AND its own manager tracking only that
// origin, so the stacks are fully independent.
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

/** Per-node undo state: a distinct origin Symbol (so the manager captures ONLY
 *  this card's edits — never a sibling card, a peer, or a transient launch) plus
 *  the manager built against the live `nodes` Y.Map, and the Y type it tracks
 *  (used to detect a rackspace rebind and rebuild against the fresh doc). */
interface NodeUndo {
  origin: symbol;
  mgr: Y.UndoManager | null;
  mgrYType: unknown;
}

/** node id → its independent undo state. Created lazily on first use per card. */
const byNode = new Map<string, NodeUndo>();

function slotFor(id: string): NodeUndo {
  let s = byNode.get(id);
  if (!s) {
    s = { origin: Symbol(`clip-card-undo:${id}`), mgr: null, mgrYType: null };
    byNode.set(id, s);
  }
  return s;
}

/** Lazily build (or rebuild after a doc rebind) THIS node's origin-scoped
 *  manager over the live `nodes` Y.Map. Must exist BEFORE an edit transacts for
 *  it to capture it, so every write path calls this first. Null on any failure
 *  (undo simply stays unavailable — never throws into the card). */
function ensureManager(id: string): Y.UndoManager | null {
  const s = slotFor(id);
  let yNodes: Y.AbstractType<unknown> | undefined;
  try {
    yNodes = getYjsValue(patch.nodes) as Y.AbstractType<unknown> | undefined;
  } catch {
    return s.mgr;
  }
  if (!yNodes) return s.mgr;
  if (s.mgr && s.mgrYType === yNodes) return s.mgr;
  // A fresh doc (or first use) → drop the stale manager + build against this one.
  if (s.mgr) {
    try { s.mgr.destroy(); } catch { /* ignore */ }
    s.mgr = null;
  }
  try {
    s.mgr = new Y.UndoManager(yNodes, {
      trackedOrigins: new Set<unknown>([s.origin]),
      captureTimeout: 300,
    });
    s.mgrYType = yNodes;
  } catch {
    s.mgr = null;
    s.mgrYType = null;
  }
  return s.mgr;
}

/**
 * Run `mut` inside a ydoc transaction tagged with node `id`'s undo origin so this
 * edit lands on THAT card's undo stack (and no sibling's). Ensures the manager
 * exists FIRST (a manager built after the edit would miss it). Use ONLY for
 * persistent, undoable edits; transient launches / view state must transact
 * un-tagged (never undoable).
 */
export function clipUndoTransact(id: string, mut: () => void): void {
  const s = slotFor(id);
  ensureManager(id);
  ydoc.transact(mut, s.origin);
}

/** Is there a card-authored edit to undo on node `id`? */
export function clipCanUndo(id: string): boolean {
  const m = ensureManager(id);
  return !!m && m.undoStack.length > 0;
}
/** Is there an undone card edit to redo on node `id`? */
export function clipCanRedo(id: string): boolean {
  const m = ensureManager(id);
  return !!m && m.redoStack.length > 0;
}
/** Undo node `id`'s last card-authored persistent clip edit (no-op if empty). */
export function clipUndo(id: string): void {
  const m = ensureManager(id);
  if (m && m.undoStack.length > 0) m.undo();
}
/** Redo node `id`'s last undone card-authored clip edit (no-op if empty). */
export function clipRedo(id: string): void {
  const m = ensureManager(id);
  if (m && m.redoStack.length > 0) m.redo();
}

/** TEST-ONLY: drop every node's manager so the next use rebuilds fresh, empty
 *  stacks. (The card never resets mid-session; e2e runs on a fresh page.) */
export function __test_resetClipUndo(): void {
  for (const s of byNode.values()) {
    if (s.mgr) {
      try { s.mgr.destroy(); } catch { /* ignore */ }
    }
  }
  byNode.clear();
}
