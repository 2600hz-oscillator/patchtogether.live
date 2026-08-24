// packages/web/src/lib/audio/modules/kria-writes.test.ts
//
// The write seam, against the app's REAL graph store.
//
// Three properties, each of which was FALSE before this PR and none of which
// any existing gate could see (`mutate.guard.test.ts` anchors on the literal
// token `.params`; this whole module's state is `.data`):
//
//   1. a sequencer edit is UNDOABLE — it was not, because both call sites
//      transacted with no origin and the UndoManager only tracks LOCAL_ORIGIN;
//   2. an edit is GRANULAR — one step click used to rewrite four tracks ×
//      seven lanes × sixteen steps as a single whole-pattern assignment;
//   3. therefore two collaborators editing DIFFERENT TRACKS converge instead
//      of overwriting each other.
//
// (3) is the one that matters to a player, and it is asserted as real
// convergence between two docs rather than as a proxy for it.

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { patch, ydoc, undoManager } from '$lib/graph/store';
import {
  editKriaTrack,
  selectKriaPattern,
  selectKriaTrack,
  setKriaRoot,
  setKriaScale,
  readSelectedTrack,
  readActivePattern,
} from './kria-writes';
import {
  applyLaneEdit,
  coerceTrack,
  defaultKriaData,
  setLoopLength,
  toggleTrig,
  KRIA_STEPS,
  type KriaData,
} from './kria-types';

const N = 'kria-writes-1';

function clearPatch() {
  for (const k of Object.keys(patch.nodes)) delete patch.nodes[k];
  for (const k of Object.keys(patch.edges)) delete patch.edges[k];
}

function seed(withData = true) {
  patch.nodes[N] = {
    id: N,
    type: 'kria',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: withData ? (defaultKriaData() as unknown as Record<string, unknown>) : {},
  } as never;
}

function data(): KriaData {
  return patch.nodes[N]!.data as KriaData;
}
function trackAt(i: number) {
  return coerceTrack(readActivePattern(data()).tracks[i]);
}

beforeEach(() => {
  clearPatch();
  undoManager.clear();
  seed();
});

describe('kria write seam — undo', () => {
  it('a step edit lands on the Cmd-Z stack and reverts', () => {
    expect(trackAt(0).trig[4]).toBe(false);

    editKriaTrack(N, 0, (t) => toggleTrig(t, 4));
    expect(trackAt(0).trig[4], 'the edit applied').toBe(true);

    undoManager.undo();
    expect(trackAt(0).trig[4], 'Cmd-Z reverted the step — the D1 fix').toBe(false);

    undoManager.redo();
    expect(trackAt(0).trig[4], 'and redo puts it back').toBe(true);
  });

  it('a per-track scalar edit is undoable too', () => {
    editKriaTrack(N, 2, (t) => setLoopLength(t, 5));
    expect(trackAt(2).loopLength).toBe(5);
    undoManager.undo();
    expect(trackAt(2).loopLength).toBe(KRIA_STEPS);
  });

  it('a pattern cue is undoable', () => {
    selectKriaPattern(N, 3);
    expect(data().active, 'an empty slot seeds and activates').toBe(3);
    undoManager.undo();
    expect(data().active).toBe(0);
  });

  it('⚠ NAVIGATION is deliberately NOT undoable — undo walks back through edits, not clicks', () => {
    // The permanent negative control on KRIA_VIEW_ORIGIN. If the selection were
    // tagged LOCAL_ORIGIN, this undo would revert the track selection and the
    // step edit below would need a SECOND Cmd-Z to reach.
    editKriaTrack(N, 0, (t) => toggleTrig(t, 1));
    selectKriaTrack(N, 2);
    expect((data() as { selTrack?: number }).selTrack).toBe(2);

    undoManager.undo();
    expect(
      (data() as { selTrack?: number }).selTrack,
      'the selection did NOT move — it is not on the stack',
    ).toBe(2);
    expect(trackAt(0).trig[1], 'the one undo reached the EDIT').toBe(false);
  });

  it('⚠ the coalescing window is real: two clicks inside 500 ms are ONE undo step', () => {
    // captureTimeout: 500 (store.ts). Not asserted as a preference — asserted so
    // that the behaviour is WRITTEN DOWN, because the feature has never worked
    // and nobody had looked at it. Two rapid clicks collapse; a click after the
    // window is its own entry (proved by `undoManager.stopCapturing()`, which is
    // what a real 500 ms gap does).
    editKriaTrack(N, 0, (t) => toggleTrig(t, 6));
    editKriaTrack(N, 0, (t) => toggleTrig(t, 7));
    undoManager.undo();
    expect(
      [trackAt(0).trig[6], trackAt(0).trig[7]],
      'a burst inside the capture window reverts together',
    ).toEqual([false, false]);

    undoManager.clear();
    editKriaTrack(N, 0, (t) => toggleTrig(t, 8));
    undoManager.stopCapturing(); // what a >500 ms pause does
    editKriaTrack(N, 0, (t) => toggleTrig(t, 9));
    undoManager.undo();
    expect(
      [trackAt(0).trig[8], trackAt(0).trig[9]],
      'across the window, only the LAST edit reverts',
    ).toEqual([true, false]);
  });
});

describe('kria write seam — granularity (D2)', () => {
  /** The distinct Y types one call modifies. */
  function changedTypes(fn: () => void): number {
    let n = -1;
    const onAfter = (tx: Y.Transaction) => {
      n = tx.changed.size;
    };
    ydoc.on('afterTransaction', onAfter);
    try {
      fn();
    } finally {
      ydoc.off('afterTransaction', onAfter);
    }
    return n;
  }

  it('one step click touches exactly ONE Y type — the edited lane array', () => {
    // The whole-pattern assignment it replaces touched the BANK map and rebuilt
    // four tracks. Units: distinct Y types in the transaction's `changed` set.
    const touched = changedTypes(() => editKriaTrack(N, 1, (t) => toggleTrig(t, 9)));
    expect(touched, 'distinct Y types modified by one step edit').toBe(1);
    expect(trackAt(1).trig[9]).toBe(true);
  });

  it('a no-op edit writes NOTHING', () => {
    // `applyLaneEdit` returns null for an inert row (the octave page's row 0).
    // A write that opens an undo entry for a click that changed nothing is its
    // own defect, so the seam must decline before it transacts.
    const before = Y.encodeStateAsUpdate(ydoc).length;
    editKriaTrack(N, 0, (t) => applyLaneEdit('octave', t, 3, 0));
    const after = Y.encodeStateAsUpdate(ydoc).length;
    expect(after, 'an inert-row click added no document bytes').toBe(before);
  });

  it('editing one track leaves every other track byte-identical (§8 state 6)', () => {
    const others = [0, 2, 3].map((i) => JSON.stringify(trackAt(i)));
    editKriaTrack(N, 1, (t) => toggleTrig(t, 3));
    editKriaTrack(N, 1, (t) => setLoopLength(t, 7));
    expect(
      [0, 2, 3].map((i) => JSON.stringify(trackAt(i))),
      'the edit stayed inside the selected track',
    ).toEqual(others);
    expect(trackAt(1).trig[3]).toBe(true);
    expect(trackAt(1).loopLength).toBe(7);
  });

  it('scale and root are pattern-level and move NO track', () => {
    const before = [0, 1, 2, 3].map((i) => JSON.stringify(trackAt(i)));
    setKriaScale(N, 'minor');
    setKriaRoot(N, 50);
    expect(readActivePattern(data()).scale).toBe('minor');
    expect(readActivePattern(data()).root).toBe(50);
    expect([0, 1, 2, 3].map((i) => JSON.stringify(trackAt(i)))).toEqual(before);
  });
});

describe('kria write seam — two collaborators (the reason D2 is a defect)', () => {
  it('peer A editing track 3 does NOT discard peer B’s track-1 edit', () => {
    // Peer B is a second doc holding the same patch. B edits track 1; A edits
    // track 3; the updates cross. Under the whole-pattern assignment this PR
    // removes, whichever update arrived last replaced the entire pattern object
    // and the other peer's track edit vanished.
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(ydoc));

    // B's edit, made with raw Yjs on B's own doc (the same keyed write the seam
    // performs — expressed here without importing the seam, so this is a real
    // second writer rather than the same code twice).
    const bTrig = docB
      .getMap('nodes')
      .get(N)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .get('data')
      .get('patterns')
      .get('0')
      .get('tracks')
      .get(1)
      .get('trig') as Y.Array<boolean>;
    docB.transact(() => {
      bTrig.delete(2, 1);
      bTrig.insert(2, [true]);
    });

    // A's edit, through the seam.
    editKriaTrack(N, 3, (t) => toggleTrig(t, 11));

    // Cross the updates.
    const updA = Y.encodeStateAsUpdate(ydoc);
    const updB = Y.encodeStateAsUpdate(docB);
    Y.applyUpdate(ydoc, updB);
    Y.applyUpdate(docB, updA);

    expect(trackAt(1).trig[2], "peer B's track-1 edit survived on A").toBe(true);
    expect(trackAt(3).trig[11], "peer A's own track-3 edit survived").toBe(true);

    const bPat = docB
      .getMap('nodes')
      .get(N)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .get('data')
      .get('patterns')
      .get('0')
      .toJSON() as { tracks: { trig: boolean[] }[] };
    expect(bPat.tracks[1]!.trig[2], 'and both are present on B — they converged').toBe(true);
    expect(bPat.tracks[3]!.trig[11]).toBe(true);
  });
});

describe('kria write seam — seeding', () => {
  it('a node with EMPTY data seeds a pattern on first edit', () => {
    clearPatch();
    seed(false);
    editKriaTrack(N, 0, (t) => toggleTrig(t, 0));
    expect(trackAt(0).trig[0]).toBe(true);
    expect(readSelectedTrack(data()).trig[0]).toBe(true);
  });
});
