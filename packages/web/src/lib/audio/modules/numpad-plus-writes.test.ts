// packages/web/src/lib/audio/modules/numpad-plus-writes.test.ts
//
// The NUMPAD+ write seam, against the app's REAL graph store.
//
// Four properties, every one of which was FALSE before this PR and none of
// which any existing gate could see (`mutate.guard.test.ts` anchors on the
// literal token `.params`; this module's instrument is `.data`):
//
//   1. ARM + PLAY erasing a layer is UNDOABLE — it was a bare proxy write, so
//      sixteen steps went and Cmd-Z did nothing;
//   2. a step edit and a remap are UNDOABLE — both call sites opened
//      `ydoc.transact(fn)` with NO origin argument;
//   3. an edit is GRANULAR — one click used to rewrite 4 layers x 16 steps;
//   4. therefore two collaborators recording into DIFFERENT layers converge
//      instead of overwriting each other.
//
// (4) is the one that matters to a player, and it is asserted as real
// convergence between two docs rather than as a proxy for it.

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { patch, ydoc, undoManager } from '$lib/graph/store';
import { coerceToNoteStep, type NoteStep } from '$lib/audio/note-entry';
import {
  clearNumpadLayer,
  nudgeNumpadStepNote,
  numpadDefaultMidi,
  readNumpadKeymap,
  readNumpadStep,
  setNumpadKeymap,
  setNumpadStep,
  toggleNumpadStep,
  NUMPAD_RECORD_ORIGIN,
} from './numpad-plus-writes';
import {
  DEFAULT_KEYMAP,
  NUMPAD_PLUS_LAYERS,
  NUMPAD_PLUS_STEPS,
  defaultLayers,
  midiForKey,
  remapKeymap,
} from './numpad-plus';

const N = 'numpad-writes-1';

function clearPatch() {
  for (const k of Object.keys(patch.nodes)) delete patch.nodes[k];
  for (const k of Object.keys(patch.edges)) delete patch.edges[k];
}

function seed(withLayers = true) {
  patch.nodes[N] = {
    id: N,
    type: 'numpadPlus',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: withLayers ? { layers: defaultLayers() } : {},
  } as never;
}

function data(): Record<string, unknown> {
  return patch.nodes[N]!.data as Record<string, unknown>;
}
function stepAt(l: number, s: number): NoteStep {
  return readNumpadStep(N, l, s);
}
function layerJson(l: number): string {
  return JSON.stringify(
    Array.from({ length: NUMPAD_PLUS_STEPS }, (_, s) => stepAt(l, s)),
  );
}

beforeEach(() => {
  clearPatch();
  undoManager.clear();
  seed();
});

describe('numpadPlus write seam — undo', () => {
  it('⚠ D1: ARM + PLAY clearing a layer is UNDOABLE — sixteen steps come back', () => {
    // The defect verbatim: `clearLayer` erased the active layer through a bare
    // SyncedStore proxy write, so the ONE gesture that destroys a take was the
    // one gesture Cmd-Z could not reach.
    for (let s = 0; s < NUMPAD_PLUS_STEPS; s++) {
      setNumpadStep(N, 1, s, { on: true, midi: 60 + s });
    }
    undoManager.stopCapturing();
    const before = layerJson(1);
    expect(stepAt(1, 15).midi, 'the take is recorded').toBe(75);

    clearNumpadLayer(N, 1);
    expect(stepAt(1, 0).on, 'ARM+PLAY erased the layer').toBe(false);
    expect(stepAt(1, 15).midi).toBe(null);

    undoManager.undo();
    expect(layerJson(1), 'Cmd-Z brought the erased take back — the D1 fix').toBe(before);
  });

  it('D2: a step edit lands on the Cmd-Z stack and reverts', () => {
    expect(stepAt(0, 4).on).toBe(false);
    setNumpadStep(N, 0, 4, { on: true, midi: 64 });
    expect(stepAt(0, 4), 'the edit applied').toEqual({ on: true, midi: 64 });

    undoManager.undo();
    expect(stepAt(0, 4), 'Cmd-Z reverted the step').toEqual({ on: false, midi: null });

    undoManager.redo();
    expect(stepAt(0, 4).on, 'and redo puts it back').toBe(true);
  });

  it('⚠ the SECOND keymap write takes the GRANULAR path, and it really lands', () => {
    // The first write seeds `data.keymap` with a whole plain object; every one
    // after it mutates the LIVE Y.Map key by key. Those are different code
    // paths and only the first was covered when this file was written — which
    // is exactly how a reset-to-default that silently did nothing reached a
    // browser.
    setNumpadKeymap(N, remapKeymap(DEFAULT_KEYMAP, 'KeyQ', 0));
    expect(readNumpadKeymap(N).KeyQ).toBe(0);

    // Reset C to its default binding: the seam must ADD Numpad1 and DELETE the
    // KeyQ entry, in place, on a map that already exists.
    setNumpadKeymap(N, remapKeymap(readNumpadKeymap(N), 'Numpad1', 0));
    const back = readNumpadKeymap(N);
    expect(back.Numpad1, 'the default binding is restored').toBe(0);
    expect(back.KeyQ, 'and the override is DELETED, not merely shadowed').toBeUndefined();
    expect(Object.keys(back).length, 'the map stays a fourteen-entry bijection')
      .toBe(Object.keys(DEFAULT_KEYMAP).length);
  });

  it('D2: a KEYMAP remap is undoable too', () => {
    const next = remapKeymap(DEFAULT_KEYMAP, 'KeyQ', 0);
    setNumpadKeymap(N, next);
    expect(readNumpadKeymap(N).KeyQ).toBe(0);
    expect(readNumpadKeymap(N).Numpad1).toBeUndefined();

    undoManager.undo();
    const back = readNumpadKeymap(N);
    expect(back.KeyQ, 'the rebind reverted').toBeUndefined();
    expect(back.Numpad1, 'and the default binding is back').toBe(0);
  });

  it('⚠ the FACTORY’s live recording is deliberately NOT undoable', () => {
    // The permanent negative control on NUMPAD_RECORD_ORIGIN. A key held during
    // OVERDUB writes a step several times a second with no pointer gesture at
    // all; tagged LOCAL_ORIGIN those would storm the UndoManager and Cmd-Z
    // would walk back through notes rather than through edits.
    setNumpadStep(N, 0, 2, { on: true, midi: 62 });          // a POINTER edit
    setNumpadStep(N, 0, 9, { on: true, midi: 69 }, { origin: NUMPAD_RECORD_ORIGIN });
    expect(stepAt(0, 9).on, 'the recorded note landed').toBe(true);

    undoManager.undo();
    expect(stepAt(0, 9).on, 'the RECORDED note is not on the stack').toBe(true);
    expect(stepAt(0, 2).on, 'the one undo reached the pointer EDIT').toBe(false);
  });
});

describe('numpadPlus write seam — granularity (D3)', () => {
  /** The distinct Y types one call modifies. */
  function changedTypes(fn: () => void): number {
    let n = -1;
    const onAfter = (tx: Y.Transaction) => { n = tx.changed.size; };
    ydoc.on('afterTransaction', onAfter);
    try { fn(); } finally { ydoc.off('afterTransaction', onAfter); }
    return n;
  }

  it('one recorded note touches exactly ONE Y type — the step’s own map', () => {
    // The whole-structure assignment it replaces rebuilt four layers x sixteen
    // steps. Units: distinct Y types in the transaction's `changed` set.
    const touched = changedTypes(() => setNumpadStep(N, 2, 7, { on: true, midi: 67 }));
    expect(touched, 'distinct Y types modified by one step write').toBe(1);
    expect(stepAt(2, 7).midi).toBe(67);
  });

  it('a no-op write writes NOTHING — no bytes, no undo entry', () => {
    const before = Y.encodeStateAsUpdate(ydoc).length;
    setNumpadStep(N, 0, 0, { on: false, midi: null });
    expect(Y.encodeStateAsUpdate(ydoc).length, 'a write of the resting value added no bytes').toBe(before);
  });

  it('clearing an ALREADY EMPTY layer writes nothing', () => {
    const before = Y.encodeStateAsUpdate(ydoc).length;
    clearNumpadLayer(N, 3);
    expect(Y.encodeStateAsUpdate(ydoc).length).toBe(before);
  });

  it('editing one layer leaves every other layer byte-identical', () => {
    const others = [0, 2, 3].map(layerJson);
    setNumpadStep(N, 1, 3, { on: true, midi: 63 });
    setNumpadStep(N, 1, 11, { on: true, midi: 71 });
    clearNumpadLayer(N, 1);
    setNumpadStep(N, 1, 5, { on: true, midi: 65 });
    expect([0, 2, 3].map(layerJson), 'the edits stayed inside the selected layer').toEqual(others);
    expect(stepAt(1, 5).midi).toBe(65);
    expect(stepAt(1, 3).on, 'and the clear really cleared').toBe(false);
  });

  it('a POLY step becomes MONO again by DELETING midis, not by leaving a stale chord', () => {
    setNumpadStep(N, 0, 0, { on: true, midi: 60, midis: [60, 64, 67] });
    expect(stepAt(0, 0).midis).toEqual([60, 64, 67]);
    setNumpadStep(N, 0, 0, { on: true, midi: 62 });
    expect(stepAt(0, 0), 'the chord is gone, not merely shadowed').toEqual({ on: true, midi: 62 });
  });
});

describe('numpadPlus write seam — two collaborators (the reason D3 is a defect)', () => {
  it('peer A recording into layer 3 does NOT discard peer B’s layer-1 take', () => {
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(ydoc));

    // B's edit, made with raw Yjs on B's own doc — deliberately NOT the seam
    // under test, so this is a real second writer rather than the same code
    // twice.
    const yget = (o: unknown, k: string | number): unknown =>
      (o as { get(k: string | number): unknown }).get(k);
    const bStep = ['data', 'layers', 1, 4].reduce<unknown>(
      (acc, k) => yget(acc, k),
      yget(docB.getMap('nodes'), N),
    ) as Y.Map<unknown>;
    docB.transact(() => { bStep.set('on', true); bStep.set('midi', 61); });

    // A's edit, through the seam.
    setNumpadStep(N, 3, 12, { on: true, midi: 72 });

    const updA = Y.encodeStateAsUpdate(ydoc);
    const updB = Y.encodeStateAsUpdate(docB);
    Y.applyUpdate(ydoc, updB);
    Y.applyUpdate(docB, updA);

    expect(stepAt(1, 4), "peer B's layer-1 take survived on A").toEqual({ on: true, midi: 61 });
    expect(stepAt(3, 12), "peer A's own layer-3 take survived").toEqual({ on: true, midi: 72 });

    const bLayers = (
      ['data', 'layers'].reduce<unknown>(
        (acc, k) => yget(acc, k),
        yget(docB.getMap('nodes'), N),
      ) as { toJSON(): unknown }
    ).toJSON() as { on: boolean; midi: number | null }[][];
    expect(bLayers[1]![4], 'and both are present on B — they converged').toEqual({ on: true, midi: 61 });
    expect(bLayers[3]![12]).toEqual({ on: true, midi: 72 });
  });
});

describe('numpadPlus write seam — seeding and shape repair', () => {
  it('a node with EMPTY data seeds its layers on the first write', () => {
    clearPatch();
    seed(false);
    setNumpadStep(N, 0, 0, { on: true, midi: 60 });
    expect(stepAt(0, 0)).toEqual({ on: true, midi: 60 });
    expect((data().layers as unknown[]).length).toBe(NUMPAD_PLUS_LAYERS);
  });

  it('a MALFORMED layers structure is repaired rather than crashing', () => {
    clearPatch();
    patch.nodes[N] = {
      id: N, type: 'numpadPlus', domain: 'audio', position: { x: 0, y: 0 },
      params: {}, data: { layers: [[{ on: true, midi: 60 }]] },
    } as never;
    setNumpadStep(N, 2, 5, { on: true, midi: 65 });
    expect(stepAt(2, 5)).toEqual({ on: true, midi: 65 });
    expect((data().layers as unknown[]).length).toBe(NUMPAD_PLUS_LAYERS);
  });

  it('an out-of-range layer / step index is CLAMPED, never thrown', () => {
    setNumpadStep(N, 99, 99, { on: true, midi: 64 });
    expect(stepAt(NUMPAD_PLUS_LAYERS - 1, NUMPAD_PLUS_STEPS - 1).midi).toBe(64);
  });
});

describe('numpadPlus write seam — the grid’s own gestures', () => {
  it('toggleNumpadStep lights a step at the octave’s C and keeps the note on re-toggle', () => {
    toggleNumpadStep(N, 0, 3, 4);
    expect(stepAt(0, 3), 'a freshly lit step plays the octave C').toEqual({ on: true, midi: numpadDefaultMidi(4) });
    toggleNumpadStep(N, 0, 3, 4);
    expect(stepAt(0, 3), 'unlighting keeps the note so re-lighting restores it').toEqual({ on: false, midi: 60 });
    toggleNumpadStep(N, 0, 3, 7);
    expect(stepAt(0, 3).midi, 'the note is remembered, not re-seeded from the new octave').toBe(60);
  });

  it('⚠ D4: drag-to-change-note EXISTS — the def documented it and no handler implemented it', () => {
    // `docs.controls['numpad-cell-{n}']` promised "click-and-dragging up/down on
    // the cell changes its note by hand" and the card's own header said the same;
    // the cell had `onclick` and nothing else. `module-docs-lint` reads the DEF,
    // so it was structurally blind in exactly the direction that matters.
    nudgeNumpadStepNote(N, 0, 6, +2, 4);
    expect(stepAt(0, 6), 'a drag on an OFF step lights it and moves the note').toEqual({ on: true, midi: 62 });
    nudgeNumpadStepNote(N, 0, 6, -14, 4);
    expect(stepAt(0, 6).midi).toBe(48);
  });

  it('a dragged note CLAMPS to the range a NoteStep can store', () => {
    // `coerceToNoteStep` nulls anything outside [12, 108], so an unclamped drag
    // would silently erase the note it was editing.
    nudgeNumpadStepNote(N, 0, 1, +999, 4);
    expect(stepAt(0, 1).midi).toBe(108);
    nudgeNumpadStepNote(N, 0, 1, -999, 4);
    expect(stepAt(0, 1).midi).toBe(12);
  });
});

describe('numpadPlus — ⚠ the OCTAVE-8 recording defect, PINNED not fixed', () => {
  it('at octave 8 eleven of the twelve keys record a step that STORES NO NOTE', () => {
    // NOT a face defect and NOT introduced here — reported rather than changed,
    // because every available fix moves the pitch of an already-saved patch.
    //
    // `midiForKey` returns `(octave + 1) * 12 + semitone`, so octave 8 spans
    // MIDI 108..119 — and `coerceToNoteStep` nulls anything above MAX_MIDI=108.
    // The LIVE keypress sounds correctly (the manual path converts the raw int
    // to V/oct and never round-trips through a NoteStep); the RECORDED step
    // reads back `{on: true, midi: null}`, which `stepVoices` renders as NO
    // VOICES. So the step is lit and silent.
    const recorded = [...Array(12).keys()].map((st) => {
      const code = Object.keys(DEFAULT_KEYMAP).find((k) => DEFAULT_KEYMAP[k] === st)!;
      const midi = midiForKey(code, 8, 0)!;
      return { st, midi, stored: coerceToNoteStep({ on: true, midi }).midi };
    });
    expect(recorded.map((r) => r.midi)).toEqual([108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119]);
    expect(
      recorded.filter((r) => r.stored === null).length,
      'eleven of twelve keys record a step whose note cannot be stored',
    ).toBe(11);
    expect(recorded[0]!.stored, 'only the octave C survives').toBe(108);
  });
});
