// packages/web/src/lib/control/clip-undo.test.ts
//
// REAL-Y.Doc regression tests for the PER-CARD clip undo scope (clip-undo.ts),
// run against the SAME syncedStore + Y.Doc the live patch uses (graph/store.ts).
//
// The load-bearing invariant (adversarial-review fix): each clip-player node has
// its OWN undo stack. With TWO clip-player cards present, undoing on card A must
// revert ONLY A's edit and leave B's intact. The original single shared
// manager/origin leaked across siblings — a Y.UndoManager filters by
// trackedOrigins, so two cards under one origin each captured the other's edit,
// and undo A popped B's change. Here we edit both, undo A, and assert B survives.

import { describe, it, expect, afterEach } from 'vitest';
import { patch, ydoc } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import {
  clipUndoTransact,
  clipUndo,
  clipRedo,
  clipCanUndo,
  clipCanRedo,
  __test_resetClipUndo,
} from './clip-undo';

const A = 'cp-undo-A';
const B = 'cp-undo-B';

function addNode(id: string): void {
  patch.nodes[id] = {
    id, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {},
  } as unknown as ModuleNode;
}

/** Mirror the card's writeDataUndoable: transact under THIS node's undo origin. */
function setMarker(id: string, value: number): void {
  clipUndoTransact(id, () => {
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    (t.data as { marker?: number }).marker = value;
  });
}
function marker(id: string): number | undefined {
  return (patch.nodes[id]?.data as { marker?: number } | undefined)?.marker;
}

afterEach(() => {
  __test_resetClipUndo();
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
});

describe('clip-undo — per-card undo scope', () => {
  it('undo on card A reverts ONLY A, never a sibling card B', () => {
    addNode(A);
    addNode(B);

    setMarker(A, 11);
    setMarker(B, 22);
    expect(marker(A)).toBe(11);
    expect(marker(B)).toBe(22);

    // Undo A → A reverts; B is untouched (the sibling-leak regression).
    clipUndo(A);
    expect(marker(A)).toBeUndefined();
    expect(marker(B), 'sibling card B must be untouched by A undo').toBe(22);

    // Undo B independently → B reverts.
    clipUndo(B);
    expect(marker(B)).toBeUndefined();
  });

  it('canUndo / canRedo are tracked per node', () => {
    addNode(A);
    addNode(B);

    expect(clipCanUndo(A)).toBe(false);
    expect(clipCanUndo(B)).toBe(false);

    setMarker(A, 1);
    expect(clipCanUndo(A)).toBe(true);
    expect(clipCanUndo(B), 'B has no edit yet').toBe(false);
    expect(clipCanRedo(A)).toBe(false);

    clipUndo(A);
    expect(clipCanUndo(A)).toBe(false);
    expect(clipCanRedo(A)).toBe(true);
    expect(clipCanRedo(B)).toBe(false);
  });

  it('redo re-applies the undone edit on the same card', () => {
    addNode(A);
    setMarker(A, 7);
    clipUndo(A);
    expect(marker(A)).toBeUndefined();
    clipRedo(A);
    expect(marker(A)).toBe(7);
  });

  it('undo/redo/canUndo are no-op-safe for an unknown / never-edited node', () => {
    expect(clipCanUndo('nope')).toBe(false);
    expect(clipCanRedo('nope')).toBe(false);
    expect(() => clipUndo('nope')).not.toThrow();
    expect(() => clipRedo('nope')).not.toThrow();
  });
});
