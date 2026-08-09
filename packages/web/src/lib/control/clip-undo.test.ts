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

  // THE ARGUMENT FOR NO CONFIRM DIALOG on the card's right-click "Delete clip".
  // Deleting a clip is destructive, and the card ships undo (control-strip 6 /
  // computer key 6) — but "undo exists" is only a real answer if undo actually
  // restores a DELETED map key with its contents, not just a scalar edit. It
  // does, and this pins it: delete the clip AND its sibling automation record
  // in one undoable transaction, undo, and get both back with their notes.
  it('a clip DELETE is undoable — the record and its automation come back intact', () => {
    addNode(A);
    const clip = { kind: 'note', lengthSteps: 16, root: 60, steps: [{ step: 3, midi: 64, vel: 100 }] };
    // Seed (untracked — this is the pre-existing state, not the edit under test).
    ydoc.transact(() => {
      const t = patch.nodes[A]!;
      if (!t.data) t.data = {};
      const d = t.data as { clips?: Record<string, unknown>; auto?: Record<string, unknown> };
      d.clips = { '5': clip };
      d.auto = { '5': { tracks: [{ key: 'vca.gain', points: [{ step: 0, value: 0.5 }] }] } };
    });

    const data = () =>
      patch.nodes[A]?.data as { clips?: Record<string, unknown>; auto?: Record<string, unknown> } | undefined;
    expect(data()?.clips?.['5']).toBeTruthy();

    // The card's deleteClipAt write, verbatim in shape.
    clipUndoTransact(A, () => {
      const d = data()!;
      if (d.clips) delete d.clips['5'];
      if (d.auto && d.auto['5'] !== undefined && d.auto['5'] !== null) delete d.auto['5'];
    });
    expect(data()?.clips?.['5'], 'delete removed the clip').toBeUndefined();
    expect(data()?.auto?.['5'], 'delete removed the clip-owned automation').toBeUndefined();
    expect(clipCanUndo(A), 'the delete landed on THIS card\'s undo stack').toBe(true);

    clipUndo(A);
    const restored = data()?.clips?.['5'] as typeof clip | undefined;
    expect(restored, 'undo restores the deleted clip record').toBeTruthy();
    expect(restored?.steps, 'undo restores the clip CONTENTS, not an empty shell').toEqual([
      { step: 3, midi: 64, vel: 100 },
    ]);
    expect(data()?.auto?.['5'], 'undo restores the clip-owned automation too').toBeTruthy();

    // …and redo re-deletes, so the pair is symmetric.
    clipRedo(A);
    expect(data()?.clips?.['5']).toBeUndefined();
  });

  it('undo/redo/canUndo are no-op-safe for an unknown / never-edited node', () => {
    expect(clipCanUndo('nope')).toBe(false);
    expect(clipCanRedo('nope')).toBe(false);
    expect(() => clipUndo('nope')).not.toThrow();
    expect(() => clipRedo('nope')).not.toThrow();
  });
});
