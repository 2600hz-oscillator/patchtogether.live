// packages/web/src/lib/ui/controls/cc-batch-store.ts
//
// The Y.Doc-bound half of the two-lane CC batcher (see cc-commit-batch.ts
// for the design + why lanes may never mix). Kept SEPARATE from
// cc-commit.ts so the pump module stays Y-free for unit tests.
//
// CC_STREAM_ORIGIN lives HERE (not graph/store.ts — that file is in the
// collab-attest basis and must stay untouched): it is deliberately NOT in
// the UndoManager's trackedOrigins set, so the bare Electra lane's
// transactions stay non-undoable — wrapping the raw proxy writes absorbs
// SyncedStore's internal no-origin transact without promoting it.

import { ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import {
  createCcBatcher,
  type CcBatchSink,
  type CcBatcher,
  type CcLane,
} from './cc-commit-batch';

/** Transaction origin for the BARE (non-undoable) streaming-CC lane. NOT
 *  a tracked origin — a hardware Electra twist must never ride the undo
 *  stack (host.ts's long-standing bare-write contract). */
export const CC_STREAM_ORIGIN: unique symbol = Symbol('cc-stream-origin');

/** One transaction per lane per flush. `ydoc` is a LIVE import binding —
 *  read at transact time, so rackspace rebinds are handled for free. */
export const ccBatchSink: CcBatchSink = {
  runLane(lane: CcLane, thunks: Array<() => void>): void {
    ydoc.transact(
      () => {
        for (const t of thunks) {
          // Per-thunk isolation: one bad commit must not drop its siblings
          // or leave the UndoManager capturing a half-window.
          try {
            t();
          } catch (err) {
            console.error('[cc-batch] commit thunk threw:', err);
          }
        }
      },
      lane === 'undoable' ? LOCAL_ORIGIN : CC_STREAM_ORIGIN,
    );
  },
};

let batcher: CcBatcher | null = null;

/** The app-wide batcher singleton every production CC pump rides. */
export function getCcBatcher(): CcBatcher {
  if (!batcher) batcher = createCcBatcher(ccBatchSink);
  return batcher;
}
