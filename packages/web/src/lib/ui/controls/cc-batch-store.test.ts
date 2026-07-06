// Lane-isolation tests for the Y.Doc-bound CC batch sink — the design's
// TOP risk: Yjs nested-transact ORIGIN PROMOTION is the load-bearing
// mechanic, so we pin with a REAL store + UndoManager (never mocks — the
// yjs-save-load-real-ydoc rule) that:
//   - the UNDOABLE lane's wrapper absorbs nested setNodeParam transacts
//     into ONE LOCAL_ORIGIN transaction that the UndoManager captures;
//   - the BARE lane's wrapper absorbs SyncedStore's internal no-origin
//     transacts WITHOUT promoting them to undoable (CC_STREAM_ORIGIN is
//     not tracked) — a hardware Electra twist never floods the undo stack;
//   - no cross-lane leakage in either direction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import { ccBatchSink, CC_STREAM_ORIGIN } from './cc-batch-store';
import type { ModuleNode } from '$lib/graph/types';

const AID = 'cc-lane-a';
const BID = 'cc-lane-b';

function seed(id: string): void {
  patch.nodes[id] = {
    id,
    type: 'analogVco',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { freq: 0.25 },
  } as unknown as ModuleNode;
}

describe('cc-batch-store lane isolation (origin promotion pin)', () => {
  beforeEach(() => {
    seed(AID);
    seed(BID);
    undoManager.stopCapturing();
    undoManager.clear();
  });
  afterEach(() => {
    if (patch.nodes[AID]) delete patch.nodes[AID];
    if (patch.nodes[BID]) delete patch.nodes[BID];
    undoManager.clear();
  });

  it('undoable lane: N thunks (nested setNodeParam transacts) = ONE tracked LOCAL_ORIGIN transaction', () => {
    const origins: unknown[] = [];
    let txns = 0;
    const onU = (_u: Uint8Array, origin: unknown): void => {
      txns++;
      origins.push(origin);
    };
    ydoc.on('update', onU);
    try {
      ccBatchSink.runLane('undoable', [
        () => setNodeParam(AID, 'freq', 0.5), // nested ydoc.transact(LOCAL_ORIGIN)
        () => setNodeParam(BID, 'freq', 0.75),
      ]);
    } finally {
      ydoc.off('update', onU);
    }
    // ONE transaction, outer origin wins over the nested transacts.
    expect(txns).toBe(1);
    expect(origins).toEqual([LOCAL_ORIGIN]);
    expect(patch.nodes[AID]!.params.freq).toBe(0.5);
    expect(patch.nodes[BID]!.params.freq).toBe(0.75);
    // …and it is UNDOABLE: one undo step reverts BOTH knobs' commits
    // (captureTimeout already merged multi-knob gestures pre-batcher).
    expect(undoManager.undoStack.length).toBeGreaterThan(0);
    undoManager.stopCapturing();
    undoManager.undo();
    expect(patch.nodes[AID]!.params.freq).toBe(0.25);
    expect(patch.nodes[BID]!.params.freq).toBe(0.25);
  });

  it('bare lane: raw proxy writes stay NON-undoable under CC_STREAM_ORIGIN (no promotion)', () => {
    const origins: unknown[] = [];
    let txns = 0;
    const onU = (_u: Uint8Array, origin: unknown): void => {
      txns++;
      origins.push(origin);
    };
    ydoc.on('update', onU);
    try {
      ccBatchSink.runLane('bare', [
        () => {
          const live = patch.nodes[AID];
          if (live) live.params.freq = 0.9; // guard:allow-raw-write — test mirrors host.ts's bare Electra commit leg
        },
      ]);
    } finally {
      ydoc.off('update', onU);
    }
    expect(txns).toBe(1);
    expect(origins).toEqual([CC_STREAM_ORIGIN]);
    expect(patch.nodes[AID]!.params.freq).toBe(0.9);
    // NOT captured: the undo stack is untouched, and undo() cannot revert it.
    expect(undoManager.undoStack.length).toBe(0);
    undoManager.undo(); // no-op on an empty stack
    expect(patch.nodes[AID]!.params.freq).toBe(0.9);
  });

  it('lanes never mix: a bare-lane window after an undoable-lane window leaves exactly one undo item', () => {
    ccBatchSink.runLane('undoable', [() => setNodeParam(AID, 'freq', 0.6)]);
    ccBatchSink.runLane('bare', [
      () => {
        const live = patch.nodes[BID];
        if (live) live.params.freq = 0.1; // guard:allow-raw-write — test mirrors host.ts's bare Electra commit leg
      },
    ]);
    undoManager.stopCapturing();
    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    // The undoable write reverted; the bare write SURVIVES the undo.
    expect(patch.nodes[AID]!.params.freq).toBe(0.25);
    expect(patch.nodes[BID]!.params.freq).toBe(0.1);
  });

  it('a throwing thunk cannot drop its siblings or wedge the transaction', () => {
    ccBatchSink.runLane('undoable', [
      () => {
        throw new Error('boom');
      },
      () => setNodeParam(AID, 'freq', 0.7),
    ]);
    expect(patch.nodes[AID]!.params.freq).toBe(0.7);
    // A follow-up transaction still works (no half-open transaction).
    setNodeParam(BID, 'freq', 0.8);
    expect(patch.nodes[BID]!.params.freq).toBe(0.8);
  });
});
