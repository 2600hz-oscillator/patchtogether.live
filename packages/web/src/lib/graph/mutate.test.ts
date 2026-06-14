// packages/web/src/lib/graph/mutate.test.ts
//
// REAL-Y.Doc / real-syncedStore tests for the origin-tagged mutation seam
// (graph/mutate.ts). These run against the SAME live syncedStore + Y.Doc +
// UndoManager the patch uses (graph/store.ts) — NOT a mock — so we exercise the
// exact `trackedOrigins: [LOCAL_ORIGIN]` wiring undo depends on, and the
// in-place / re-read-inside-transact discipline against real integrated Y types
// ([[yjs-save-load-real-ydoc]]).
//
// What we assert:
//   - setNodeParam (default origin) → exactly ONE undo entry; undo() restores
//     the prior param value (the core "knob turn is undoable" contract);
//   - mutateNode editing node.data is undoable;
//   - a NON-tracked origin makes a deliberate non-undoable write (no undo entry,
//     value still applied);
//   - a missing nodeId is a safe no-op (no throw, no undo entry, no node created).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from './store';
import { mutateNode, setNodeParam, setControlColor, setNodeLocked } from './mutate';
import type { ModuleNode } from './types';

const NID = 'mutate-test-node';

function makeNode(): void {
  // Write through one LOCAL_ORIGIN transact then clear the undo stack, so the
  // SETUP add never counts as the edit under test (each test starts with an
  // empty undo stack but the node present).
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'analogVco',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { tune: 0.5 },
      data: { label: 'orig' },
    } as ModuleNode;
  }, LOCAL_ORIGIN);
  undoManager.clear();
  undoManager.stopCapturing();
}

beforeEach(() => {
  // Clean slate: no leftover nodes, empty undo/redo stacks.
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
  undoManager.stopCapturing();
});

afterEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
});

describe('setNodeParam — undoable by default (LOCAL_ORIGIN)', () => {
  it('records exactly one undo entry and undo() restores the prior value', () => {
    makeNode();
    expect(patch.nodes[NID]!.params.tune).toBe(0.5);

    setNodeParam(NID, 'tune', 0.9);
    expect(patch.nodes[NID]!.params.tune).toBe(0.9);
    expect(undoManager.undoStack.length).toBe(1);

    undoManager.undo();
    expect(patch.nodes[NID]!.params.tune).toBe(0.5); // prior value restored
  });

  it('redo re-applies the param write after an undo', () => {
    makeNode();
    setNodeParam(NID, 'tune', 0.9);
    undoManager.undo();
    expect(patch.nodes[NID]!.params.tune).toBe(0.5);
    undoManager.redo();
    expect(patch.nodes[NID]!.params.tune).toBe(0.9);
  });
});

describe('mutateNode — arbitrary in-place edits are undoable', () => {
  it('editing node.data registers one undo entry and undo() restores it', () => {
    makeNode();
    expect((patch.nodes[NID]!.data as { label?: string }).label).toBe('orig');

    mutateNode(NID, (live) => {
      (live.data as Record<string, unknown>).label = 'edited'; // set a key IN PLACE
    });
    expect((patch.nodes[NID]!.data as { label?: string }).label).toBe('edited');
    expect(undoManager.undoStack.length).toBe(1);

    undoManager.undo();
    expect((patch.nodes[NID]!.data as { label?: string }).label).toBe('orig');
  });

  it('the mutator receives the LIVE node re-read inside the transaction', () => {
    makeNode();
    let seen: ModuleNode | undefined;
    mutateNode(NID, (live) => {
      seen = live;
      live.params.tune = 0.25;
    });
    // It is the live patch node (same identity the proxy hands back), not a copy.
    expect(seen).toBe(patch.nodes[NID]);
    expect(patch.nodes[NID]!.params.tune).toBe(0.25);
  });
});

describe('origin axis — a non-tracked origin is deliberately NOT undoable', () => {
  const PROGRAMMATIC = Symbol('programmatic-non-undoable');

  it('setNodeParam with a non-tracked origin applies the value but adds no undo entry', () => {
    makeNode();
    setNodeParam(NID, 'tune', 0.77, { origin: PROGRAMMATIC });
    expect(patch.nodes[NID]!.params.tune).toBe(0.77); // value applied
    expect(undoManager.undoStack.length).toBe(0); // but NOT on the undo stack

    undoManager.undo(); // nothing to undo → value unchanged
    expect(patch.nodes[NID]!.params.tune).toBe(0.77);
  });

  it('mutateNode with a non-tracked origin is non-undoable too', () => {
    makeNode();
    mutateNode(
      NID,
      (live) => {
        live.params.tune = 0.33;
      },
      { origin: PROGRAMMATIC },
    );
    expect(undoManager.undoStack.length).toBe(0);
    expect(patch.nodes[NID]!.params.tune).toBe(0.33);
  });
});

describe('setControlColor — single-key in-place set/clear on node.data', () => {
  it('sets data.controlColor in place + is undoable; null clears it', () => {
    makeNode();
    const dataBefore = patch.nodes[NID]!.data;

    setControlColor(NID, 'F45C51');
    expect((patch.nodes[NID]!.data as { controlColor?: string }).controlColor).toBe('F45C51');
    // The live data map is mutated IN PLACE — same object reference (never a
    // spread-reassign that would re-integrate live Y types).
    expect(patch.nodes[NID]!.data).toBe(dataBefore);
    expect(undoManager.undoStack.length).toBe(1);

    // Pre-existing keys survive the single-key set.
    expect((patch.nodes[NID]!.data as { label?: string }).label).toBe('orig');

    setControlColor(NID, null);
    expect((patch.nodes[NID]!.data as { controlColor?: string }).controlColor).toBeUndefined();
    expect((patch.nodes[NID]!.data as { label?: string }).label).toBe('orig');
  });

  it('undo() restores the prior colour', () => {
    makeNode();
    setControlColor(NID, '529DEC');
    // Force a fresh undo capture so the second write is its own entry (Yjs
    // batches writes within captureTimeout into one transaction otherwise).
    undoManager.stopCapturing();
    setControlColor(NID, 'F45C51');
    undoManager.undo();
    expect((patch.nodes[NID]!.data as { controlColor?: string }).controlColor).toBe('529DEC');
  });

  it('is a safe no-op on an absent node', () => {
    expect(() => setControlColor('nope', 'FFFFFF')).not.toThrow();
    expect(patch.nodes['nope']).toBeUndefined();
    expect(undoManager.undoStack.length).toBe(0);
  });
});

describe('setNodeLocked — single-key in-place set/clear on node.data', () => {
  it('sets data.rackLocked=true in place + is undoable; false deletes the key', () => {
    makeNode();
    const dataBefore = patch.nodes[NID]!.data;
    expect((patch.nodes[NID]!.data as { rackLocked?: boolean }).rackLocked).toBeUndefined();

    setNodeLocked(NID, true);
    expect((patch.nodes[NID]!.data as { rackLocked?: boolean }).rackLocked).toBe(true);
    // Mutated IN PLACE — same data object (no spread-reassign of live Y types).
    expect(patch.nodes[NID]!.data).toBe(dataBefore);
    expect(undoManager.undoStack.length).toBe(1);
    // Pre-existing keys survive the single-key set.
    expect((patch.nodes[NID]!.data as { label?: string }).label).toBe('orig');

    setNodeLocked(NID, false);
    // Cleared → the key is GONE (free-floating is the absence of the flag).
    expect('rackLocked' in (patch.nodes[NID]!.data as object)).toBe(false);
    expect((patch.nodes[NID]!.data as { label?: string }).label).toBe('orig');
  });

  it('is a safe no-op on an absent node', () => {
    expect(() => setNodeLocked('nope', true)).not.toThrow();
    expect(patch.nodes['nope']).toBeUndefined();
    expect(undoManager.undoStack.length).toBe(0);
  });
});

describe('missing nodeId — safe no-op', () => {
  it('setNodeParam on an absent node does not throw, create a node, or push undo', () => {
    expect(() => setNodeParam('does-not-exist', 'tune', 1)).not.toThrow();
    expect(patch.nodes['does-not-exist']).toBeUndefined();
    expect(undoManager.undoStack.length).toBe(0);
  });

  it('mutateNode on an absent node never invokes fn and is a no-op', () => {
    let called = false;
    expect(() =>
      mutateNode('does-not-exist', () => {
        called = true;
      }),
    ).not.toThrow();
    expect(called).toBe(false);
    expect(patch.nodes['does-not-exist']).toBeUndefined();
    expect(undoManager.undoStack.length).toBe(0);
  });
});
