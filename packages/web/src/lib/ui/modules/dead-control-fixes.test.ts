// packages/web/src/lib/ui/modules/dead-control-fixes.test.ts
//
// TWO CONTROLS THAT WERE ON THE PANEL AND DID NOT WORK, and the assertions that
// would have caught each. Both are the same shape — a CARD disagreeing with the
// rest of the system, on a dimension no def-reading gate can see — and neither
// is an audio bug, so neither ART nor the behavioral sweep could have flagged
// them either.
//
//   1. analogVco FM / PM — the def declares both `-1..1`; the card hardcoded
//      `min={0}`. The ENTIRE NEGATIVE HALF of both modulation-depth controls
//      had no user interface, on a module whose inverted depth is a real,
//      deliberately-implemented feature with its own unit test
//      (analog-vco-modulation.test.ts: "negative PM depth inverts the phase
//      offset (bipolar)"). contract-lock, module-docs-lint and every range
//      assertion read the DEF — and the def was right.
//
//   2. filter MODE — committed as a BARE proxy assignment
//      (`patch.nodes[id].params.mode = m`) instead of `setNodeParam`, so it
//      landed in the document untagged. The UndoManager tracks only
//      `LOCAL_ORIGIN`, so switching LP→BP was NOT UNDOABLE while cutoff and
//      resonance on the same card were. `mutate.guard.test.ts`'s
//      RAW_PARAM_WRITE check is bracket-form only (`params['x'] =`), so the
//      guard and the bug were blind in the same direction.
//
// The filter half is a BEHAVIOUR test against the real Y.Doc + UndoManager —
// undo granularity is a property of the real store and a mock cannot see it.
//
// ⚠ BOTH HALVES USED TO CARRY A CARD-SOURCE LEG BESIDE THEM, and neither does
// now. That is not a retreat: each defect was a CARD disagreeing with the def,
// and with one surface left there is no second party to the disagreement. The
// shell renders these params from the ParamDef and writes them through
// `shellParamWrite`, so "a literal range in markup" and "a bare proxy
// assignment" have no module-local place to live. What is kept is the half that
// still has a subject — the def's own declaration, the face's ranking of it,
// and the real undo behaviour.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import { analogVcoDef } from '$lib/audio/modules/analog-vco';
import { filterDef } from '$lib/audio/modules/filter';
import type { ModuleNode } from '$lib/graph/types';


// ── 1 · analogVco: the negative half is reachable ───────────────────────────

describe('analogVco — bipolar modulation depth is reachable from the faceplate', () => {
  it('the DEF declares FM and PM bipolar (the fact no surface may narrow)', () => {
    for (const id of ['fmAmount', 'pmAmount']) {
      const p = analogVcoDef.params.find((q) => q.id === id)!;
      expect(p.min, `${id}.min — inverted depth is a shipped feature`).toBeLessThan(0);
      expect(p.max, `${id}.max`).toBeGreaterThan(0);
    }
  });

  it('the FACE ranks both, so the def bounds are what a player actually gets', () => {
    // ⚠ TWO CARD-SOURCE LEGS STOOD HERE AND BOTH ARE UNSPELLABLE NOW, which is
    // a stronger outcome than either of them. They read `AnalogVcoCard.svelte`
    // and asserted (a) no `min={0}`-style literal range prop and (b) every fader
    // threaded through the def-reading `spec()` helper — the narrow, card-scoped
    // form of "a range comes from ONE place". The card was the only surface that
    // could restate a bound; with it gone the shell renders these params from
    // the ParamDef itself, so there is no second number to drift.
    //
    // What replaces them is the reachability half, which is what the ORIGINAL
    // DEFECT actually cost the player: the negative travel existed in the model
    // and had no control. A param the face never ranks has no control either, so
    // the bipolar assertion above is only meaningful while both params are on
    // the faceplate. That is asserted here rather than assumed.
    const ranked = new Set(analogVcoDef.face?.order ?? []);
    for (const id of ['fmAmount', 'pmAmount']) {
      expect(ranked.has(id), `${id} must be ranked on the face or its bipolar range is dead`)
        .toBe(true);
    }
  });
});

// ── 2 · filter: MODE is undoable ────────────────────────────────────────────

describe('filter — MODE lands on the undo stack like every other control', () => {
  const NID = 'filter-mode-undo-test';

  function spawn(): void {
    ydoc.transact(() => {
      patch.nodes[NID] = {
        id: NID,
        type: 'filter',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: { cutoff: 1000, resonance: 0.1, mode: 0 },
        data: {},
      } as unknown as ModuleNode;
    }, LOCAL_ORIGIN);
    undoManager.clear();
    undoManager.stopCapturing();
  }

  beforeEach(() => {
    if (patch.nodes[NID]) ydoc.transact(() => { delete patch.nodes[NID]; }, LOCAL_ORIGIN);
    spawn();
  });
  afterEach(() => {
    if (patch.nodes[NID]) ydoc.transact(() => { delete patch.nodes[NID]; }, LOCAL_ORIGIN);
    undoManager.clear();
  });

  it('`mode` is a real param, so an untagged write reaches the doc but not undo', () => {
    expect(filterDef.params.find((p) => p.id === 'mode')).toBeTruthy();
  });

  it('THE BUG: a bare proxy assignment changes the value and adds NO undo entry', () => {
    // The negative control on the test itself — reproduce the shipped commit
    // form and show it really is invisible to undo. Without this leg, the
    // passing test below could be passing for any reason at all.
    const depth = undoManager.undoStack.length;
    patch.nodes[NID]!.params.mode = 2;
    expect(patch.nodes[NID]!.params.mode, 'the raw write DOES reach the document').toBe(2);
    expect(
      undoManager.undoStack.length,
      'an untagged write is invisible to the UndoManager — this is what shipped',
    ).toBe(depth);
  });

  it('THE FIX: the setNodeParam commit is undoable, and Cmd-Z restores the mode', () => {
    const depth = undoManager.undoStack.length;
    setNodeParam(NID, 'mode', 2);
    undoManager.stopCapturing();
    expect(patch.nodes[NID]!.params.mode).toBe(2);
    expect(undoManager.undoStack.length, 'MODE must be undoable like cutoff/res').toBe(depth + 1);
    undoManager.undo();
    expect(patch.nodes[NID]!.params.mode, 'undo returns to the previous mode').toBe(0);
  });

  // ⚠ THE CARD-SOURCE LEG IS GONE AND THE BEHAVIOUR LEG ABOVE IS THE WHOLE
  // CLAIM. It read `FilterCard.svelte` for `set('mode')` and for the absence of
  // the exact shipped bare-proxy line. That was always the weaker of the pair:
  // the leg above drives the REAL Y.Doc + UndoManager and fails if MODE lands
  // untagged, whatever the source spelling. The surviving surface writes through
  // `shellParamWrite`, one seam for every cell, and `mutate.guard.test.ts` holds
  // the raw-write rule across the tree — so a bare proxy assignment has no
  // module-local place left to hide.
});
