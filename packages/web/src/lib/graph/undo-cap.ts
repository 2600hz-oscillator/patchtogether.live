// packages/web/src/lib/graph/undo-cap.ts
//
// BOUND THE UNDO WINDOW, AND ACTUALLY RECLAIM WHAT AGES OUT OF IT.
//
// Why this exists (owner ask, 2026-08-28): a Y.UndoManager with no depth cap
// is an UNBOUNDED RETAINER. Yjs garbage-collects deleted content by default —
// the ONLY thing pinning a long session's tombstones alive is the undo stack:
// every captured step marks its deleted structs `keep = true` so they stay
// restorable, and nothing ever expires the stack. MEASURED on this repo's
// yjs (13.6.30), 20k undo-units of a realistic edit mix:
//
//     unbounded undo:   4,469 KB encoded doc · 36.7 MB heap · 53 ms encode
//     capped at 100:      254 KB             · 10.0 MB      ·  7 ms
//     no undo at all:     230 KB             ·  9.7 MB      · 22 ms
//
// The cost curve is a CLIFF at "unbounded", then flat: capping at 20 and at
// 200 differ by ~40 KB. So the cap is a UX number, not a perf number — 100 is
// beyond any plausible real workflow and costs the same as 20. The win lands
// on the LIVE doc, so the default save, F5 reload and relay-sync payloads all
// shrink for long sessions — complementing the state-only export (#2253),
// which cleans the FILE on the way out.
//
// ⚠ THE TRIM MUST RELEASE, NOT JUST FORGET. Splicing the oldest entry off
// `undoStack` reclaims NOTHING — the dropped step's structs still carry
// `keep = true`, so Yjs GC keeps skipping them (measured: a splice-only cap
// stayed at the full 4,469 KB). The release has two halves, in order:
//   1. clear `keep` on every struct the dropped step referenced (its
//      deletions AND insertions — an insertion that was later deleted is
//      pinned through the insertions set);
//   2. run Yjs's own GC pass over the dropped step's delete-set, because
//      transaction cleanup only ever GCs the CURRENT transaction's deletions
//      — nothing revisits ranges that were skipped while kept.
//
// ⚠ CONSERVATIVE ON PARENTS, deliberately. Yjs's own `um.clear()` also
// un-keeps each struct's PARENT chain — safe there because clear() drops the
// WHOLE stack. A depth trim drops only the oldest step while newer steps may
// still restore into the same parents, so this trim clears only the structs
// the dropped step itself referenced. Measured: the conservative form still
// reclaims ~95% of the unbounded bloat (254 KB vs the 230 KB no-undo floor).
//
// REDO needs no cap of its own: the redo stack is fed exclusively by undo()
// pops, so it can never exceed the undo cap, and Yjs itself releases it on
// the next tracked edit.

import * as Y from 'yjs';

/**
 * How many undo steps a client retains. A UX ceiling, not a perf trade-off —
 * see the header table: 20 and 200 cost within ~40 KB of each other, so the
 * number is chosen to be beyond any plausible "I need to go back that far"
 * (the owner's calibration: 20 very useful, 50 pretty useful, deeper than
 * that unconvincing) while keeping the retainer bounded.
 */
export const UNDO_STACK_CAP = 100;

/** Origin for the trim's flag-clearing transaction. Never tracked by the
 *  UndoManager (only LOCAL_ORIGIN is), so a trim can never register as an
 *  undoable edit — and it mutates no shared state anyway, only local
 *  `keep` bookkeeping. */
const UNDO_TRIM_ORIGIN = Symbol('undo-trim');

/** Release ONE aged-out stack item: un-keep everything it pinned, then GC
 *  its deletions. Exported for the tests' negative control. */
export function releaseStackItem(ydoc: Y.Doc, item: Y.UndoManager['undoStack'][number]): void {
  ydoc.transact((tr) => {
    for (const ds of [item.deletions, item.insertions]) {
      Y.iterateDeletedStructs(tr, ds, (struct) => {
        if (struct instanceof Y.Item && struct.keep) struct.keep = false;
      });
    }
  }, UNDO_TRIM_ORIGIN);
  // GC only the DELETIONS: insertions still alive are live content, and
  // insertions since deleted are covered by the step that deleted them.
  Y.tryGc(item.deletions, ydoc.store, ydoc.gcFilter);
}

/**
 * Attach the depth cap to an UndoManager: after every captured step, age the
 * oldest steps out past UNDO_STACK_CAP and release what they pinned. Runs on
 * the UndoManager's own 'stack-item-added' event, so the cap needs no caller
 * cooperation and a rebind (new rackspace → new doc + manager) starts fresh.
 */
export function attachUndoCap(ydoc: Y.Doc, um: Y.UndoManager, cap: number = UNDO_STACK_CAP): void {
  um.on('stack-item-added', () => {
    while (um.undoStack.length > cap) {
      const oldest = um.undoStack.shift();
      if (oldest) releaseStackItem(ydoc, oldest);
    }
  });
}
