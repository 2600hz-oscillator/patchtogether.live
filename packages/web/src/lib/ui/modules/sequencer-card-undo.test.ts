// packages/web/src/lib/ui/modules/sequencer-card-undo.test.ts
//
// Phase 4b — SEQUENCER step edits are undoable.
//
// SequencerCard.writeSteps() is the single write path every step edit routes
// through (toggle gate, set pitch, cycle chord, clear). Before this phase it ran
// a bare `ydoc.transact(fn)` with NO origin, so the UndoManager
// (trackedOrigins=[LOCAL_ORIGIN]) never captured it and Cmd-Z did nothing to a
// step edit. The fix routes writeSteps through the origin-tagged mutation seam
// (graph/mutate.ts `mutateNode`), which tags the transaction LOCAL_ORIGIN.
//
// These tests run against the REAL live syncedStore + Y.Doc + UndoManager
// (graph/store.ts), NOT mocks — so they exercise the exact trackedOrigins wiring
// undo depends on and the real integrated Y types ([[yjs-save-load-real-ydoc]]).
// We reproduce writeSteps' exact body (the closure isn't exported from the
// .svelte component) and drive it the way toggleGate/commitPitch do: read a copy
// of the steps array, mutate one step, write the WHOLE array back.
//
// What we assert:
//   - toggling a step's gate via the real writeSteps path records exactly ONE
//     undo entry, and undo() restores the prior steps array;
//   - a second edit + undo restores the FIRST edit's state correctly;
//   - the whole-array write stays intact across edits — every slot round-trips,
//     so the #566 "sequencer could only save slot 1 / array got truncated" class
//     of save-to-slot bug does NOT regress.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import {
  defaultSteps,
  coerceToSequencerStep,
  type Step,
} from '$lib/audio/modules/sequencer';
import type { ModuleNode } from '$lib/graph/types';

const NID = 'seq-undo-test-node';

// --- Exact reproduction of SequencerCard's write/read helpers ---------------
// writeSteps now routes through mutateNode (LOCAL_ORIGIN-tagged). Keep this in
// lock-step with SequencerCard.svelte's writeSteps body.
function writeSteps(arr: Step[]): void {
  mutateNode(NID, (live) => {
    if (!live.data) live.data = {};
    (live.data as Record<string, unknown>).steps = arr.map((s) => ({
      on: s.on,
      midi: s.midi,
      chord: s.chord ?? 'mono',
    }));
  });
}

function readStepsCopy(): Step[] {
  const t = patch.nodes[NID];
  if (!t?.data) return defaultSteps();
  const raw = (t.data as Record<string, unknown>).steps;
  if (Array.isArray(raw)) return (raw as unknown[]).map(coerceToSequencerStep);
  return defaultSteps();
}

// The card's toggleGate(i): read copy, flip one step's `on`, write whole array.
function toggleGate(i: number): void {
  const arr = readStepsCopy();
  const cur = arr[i] ?? { on: false, midi: null, chord: 'mono' as const };
  arr[i] = { on: !cur.on, midi: cur.midi, chord: cur.chord ?? 'mono' };
  writeSteps(arr);
}

/** Stable, comparable snapshot of the live steps array. */
function liveSteps(): Step[] {
  return readStepsCopy();
}

function makeNode(initial: Step[]): void {
  // Seed via a LOCAL_ORIGIN transact, then clear the undo stack so SETUP never
  // counts as the edit under test (each test starts undo-empty, node present).
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'sequencer',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: { steps: initial.map((s) => ({ on: s.on, midi: s.midi, chord: s.chord ?? 'mono' })) },
    } as ModuleNode;
  }, LOCAL_ORIGIN);
  undoManager.clear();
  undoManager.stopCapturing();
}

beforeEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
  undoManager.stopCapturing();
});

afterEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
});

describe('SequencerCard step edits are undoable (Phase 4b)', () => {
  it('toggling a gate records ONE undo entry; undo() restores the prior steps', () => {
    const initial = defaultSteps();
    expect(initial[3].on).toBe(false);
    makeNode(initial);

    toggleGate(3);
    expect(liveSteps()[3].on).toBe(true);
    // One transact via the LOCAL_ORIGIN seam → exactly one undo unit.
    expect(undoManager.undoStack.length).toBe(1);

    undoManager.undo();
    // Prior array restored — step 3 back to off, everything else untouched.
    expect(liveSteps()[3].on).toBe(false);
    expect(liveSteps()).toEqual(initial.map((s) => ({ on: s.on, midi: s.midi, chord: s.chord ?? 'mono' })));
  });

  it('a second edit + undo restores the first edit (not the original)', () => {
    makeNode(defaultSteps());

    toggleGate(0);
    undoManager.stopCapturing(); // force a fresh undo unit for the next edit
    const afterFirst = liveSteps();
    expect(afterFirst[0].on).toBe(true);

    toggleGate(5);
    expect(undoManager.undoStack.length).toBe(2);
    expect(liveSteps()[0].on).toBe(true);
    expect(liveSteps()[5].on).toBe(true);

    // Undo the SECOND edit → step 5 reverts, step 0 stays on.
    undoManager.undo();
    expect(liveSteps()).toEqual(afterFirst);
    expect(liveSteps()[5].on).toBe(false);
    expect(liveSteps()[0].on).toBe(true);
  });

  it('redo re-applies the gate toggle after an undo', () => {
    makeNode(defaultSteps());
    toggleGate(7);
    expect(liveSteps()[7].on).toBe(true);
    undoManager.undo();
    expect(liveSteps()[7].on).toBe(false);
    undoManager.redo();
    expect(liveSteps()[7].on).toBe(true);
  });

  it('writes the WHOLE steps array (every slot round-trips — #566 save-to-slot guard)', () => {
    const initial = defaultSteps();
    makeNode(initial);

    // Build a fully-populated array and write it in one go, the way a load /
    // multi-edit would, then assert NOTHING is truncated to slot 0/1.
    const filled = initial.map((s, i) => ({
      on: i % 2 === 0,
      midi: 60 + (i % 12),
      chord: 'mono' as const,
    }));
    writeSteps(filled);

    const got = liveSteps();
    expect(got.length).toBe(filled.length);
    expect(got).toEqual(filled);

    // And the whole-array write is one undoable unit that fully reverts.
    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(liveSteps()).toEqual(initial.map((s) => ({ on: s.on, midi: s.midi, chord: s.chord ?? 'mono' })));
  });
});
