// Real-Y.Doc coverage for the quicksave slot save/load path.
//
// transport-helpers.test.ts exercises the PURE resolvers against plain
// objects, which never integrate a Y.Map — so it could NOT catch the
// "can't save to slot 2" bug: saveToSlot rebuilt the whole slot map with
// `{ ...coerceSlots(data.slots) }` and re-assigned an already-integrated
// Y.Map at a new path, which Yjs rejects ("Type already integrated into a
// document"). That threw inside the transact on the 2nd+ save, so only the
// first slot ever persisted.
//
// These tests stand the slot map up on the SAME syncedStore + Y.Doc
// machinery the live patch graph uses (graph/store.ts `createPatch`), so the
// slots really are Y-backed and the regression reproduces.
import { describe, it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  saveToSlot,
  loadFromSlot,
  handleSlotClick,
  readSlots,
  setPendingMode,
  type TransportCardDeps,
  type PatchLike,
} from './transport-card';
import { SLOT_KEYS, type Snapshot } from './transport-helpers';

interface TestStep {
  on: boolean;
  midi: number;
  chord: string;
}
interface SeqData {
  data: { steps: TestStep[] };
  params: Record<string, number>;
}

function setup() {
  const store = syncedStore<{
    nodes: Record<string, unknown>;
    edges: Record<string, unknown>;
  }>({ nodes: {}, edges: {} });
  const ydoc = getYjsDoc(store);
  const id = 'seq1';
  store.nodes[id] = {
    id,
    type: 'sequencer',
    position: { x: 0, y: 0 },
    data: { steps: [{ on: true, midi: 60, chord: 'mono' }] },
    params: { bpm: 120, length: 16, octave: 0, gateLength: 0.5, swing: 0 },
  };

  const node = () => store.nodes[id] as unknown as SeqData;

  // Wired exactly like SequencerCard.svelte's transportDeps: a plain-object
  // snapshot of the live steps + params, and an applySnapshot that deep-clones
  // steps back in (so a loaded Y.Map snapshot isn't re-parented).
  const deps: TransportCardDeps = {
    nodeId: id,
    patch: store as unknown as PatchLike,
    transact: (fn) => ydoc.transact(fn),
    snapshot: (): Snapshot => {
      const t = node();
      return {
        steps: t.data.steps.map((s) => ({ on: s.on, midi: s.midi, chord: s.chord ?? 'mono' })),
        bpm: t.params.bpm,
        length: t.params.length,
        octave: t.params.octave,
        gateLength: t.params.gateLength,
        swing: t.params.swing,
      };
    },
    applySnapshot: (snap: Snapshot) => {
      const t = node();
      ydoc.transact(() => {
        if (Array.isArray(snap.steps)) {
          t.data.steps = (snap.steps as TestStep[]).map((s) => ({
            on: s.on,
            midi: s.midi,
            chord: s.chord ?? 'mono',
          }));
        }
        for (const k of ['bpm', 'length', 'octave', 'gateLength', 'swing'] as const) {
          const v = snap[k];
          if (typeof v === 'number') t.params[k] = v;
        }
      });
    },
  };

  /** Set the "live" pattern that the next snapshot() captures. */
  const setLive = (midi: number, bpm: number) =>
    ydoc.transact(() => {
      node().data.steps = [{ on: true, midi, chord: 'mono' }];
      node().params.bpm = bpm;
    });
  const liveMidi = () => node().data.steps[0].midi;
  const liveBpm = () => node().params.bpm;
  const slotSnap = (k: string) =>
    readSlots(deps.patch.nodes[id])[k as (typeof SLOT_KEYS)[number]] as
      | { steps: TestStep[]; bpm: number }
      | null;

  return { deps, setLive, liveMidi, liveBpm, slotSnap };
}

describe('quicksave slots over a real Y.Doc', () => {
  it('saves a distinct pattern into ALL 8 slots and recalls each (slot ≥2 used to throw)', () => {
    const { deps, setLive, liveMidi, liveBpm, slotSnap } = setup();

    // Save a distinct pattern to each of the 8 slots.
    SLOT_KEYS.forEach((k, i) => {
      setLive(60 + i, 100 + i);
      saveToSlot(deps, k);
    });

    // All 8 occupied, each with its own pattern (slot 1 not clobbered).
    SLOT_KEYS.forEach((k, i) => {
      const snap = slotSnap(k);
      expect(snap, `slot ${k} should hold a snapshot`).toBeTruthy();
      expect(snap!.steps[0].midi).toBe(60 + i);
      expect(snap!.bpm).toBe(100 + i);
    });

    // Recall each slot → applySnapshot restores its exact pattern.
    SLOT_KEYS.forEach((k, i) => {
      setLive(0, 0); // wipe the live pattern first
      expect(loadFromSlot(deps, k)).toBe(k);
      expect(liveMidi()).toBe(60 + i);
      expect(liveBpm()).toBe(100 + i);
    });
  });

  it('saving slot 2 after slot 1 keeps BOTH (the exact reported bug)', () => {
    const { deps, setLive, slotSnap } = setup();
    setLive(60, 120);
    saveToSlot(deps, '1');
    setLive(72, 130);
    saveToSlot(deps, '2'); // pre-fix: threw "Type already integrated"
    expect(slotSnap('1')!.steps[0].midi).toBe(60);
    expect(slotSnap('2')!.steps[0].midi).toBe(72);
  });

  it('save → change → re-save → load returns the LATEST save', () => {
    const { deps, setLive, liveMidi, liveBpm } = setup();
    setLive(64, 120);
    saveToSlot(deps, '1');
    setLive(67, 140);
    saveToSlot(deps, '1'); // overwrite slot 1
    setLive(0, 0);
    loadFromSlot(deps, '1');
    expect(liveMidi()).toBe(67);
    expect(liveBpm()).toBe(140);
  });

  it('armed SAVE mode writes any slot via handleSlotClick', () => {
    const { deps, setLive, slotSnap } = setup();
    setLive(65, 120);
    setPendingMode(deps, 'save');
    expect(handleSlotClick(deps, '5')).toBe('save');
    expect(slotSnap('5')).toBeTruthy();
  });
});
