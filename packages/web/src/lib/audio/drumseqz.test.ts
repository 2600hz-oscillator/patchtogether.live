// packages/web/src/lib/audio/drumseqz.test.ts
//
// Unit tests for DRUMSEQZ helpers:
//   - applyEuclidean: Eucl slider rewrite policy (REPLACES on flags, preserves
//     per-step midi).
//   - cellVOct: per-track pitch fall-through math (cell midi or track root,
//     plus track + global octave shifts).

import { describe, it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  applyEuclidean,
  cellVOct,
  coerceToDrumseqzTracks,
  defaultCells,
  defaultTracks,
  STEP_COUNT,
  TRACK_COUNT,
  type DrumCell,
  type DrumTrack,
} from './modules/drumseqz';
import { bjorklund } from '$lib/audio/euclidean';
import { C3_MIDI } from '$lib/audio/note-entry';
import type { ModuleNode, Edge } from '$lib/graph/types';

describe('drumseqz / applyEuclidean: rewrite contract', () => {
  it('k=4 places gates at 0, 4, 8, 12 (downbeats every 4)', () => {
    const cells = applyEuclidean(defaultCells(), 4);
    const onIdx = cells
      .map((c, i) => (c.on ? i : -1))
      .filter((i) => i >= 0);
    expect(onIdx).toEqual([0, 4, 8, 12]);
  });

  it('k=0 clears every gate', () => {
    const seeded = defaultCells().map((c, i) =>
      i % 2 === 0 ? { on: true, midi: 60 + i } : c,
    );
    const cells = applyEuclidean(seeded, 0);
    expect(cells.every((c) => c.on === false)).toBe(true);
  });

  it('k=16 turns every gate on', () => {
    const cells = applyEuclidean(defaultCells(), 16);
    expect(cells.every((c) => c.on === true)).toBe(true);
    expect(cells).toHaveLength(STEP_COUNT);
  });

  it('preserves per-step midi when toggling on', () => {
    const seeded: DrumCell[] = defaultCells().map((_, i) => ({
      on: false,
      midi: 60 + i,
    }));
    const cells = applyEuclidean(seeded, 4);
    expect(cells[0]).toEqual({ on: true, midi: 60 });
    expect(cells[4]).toEqual({ on: true, midi: 64 });
    expect(cells[8]).toEqual({ on: true, midi: 68 });
    expect(cells[12]).toEqual({ on: true, midi: 72 });
  });

  it('preserves per-step midi even when re-OFFing a previously hand-set gate', () => {
    // Step 1 was hand-toggled on by the user with a specific pitch. The
    // user then moves the Eucl slider to k=4, which should turn step 1 OFF
    // (it's not on the Bjorklund grid) — but step 1's midi should NOT be
    // wiped, so a later re-toggle restores the user's chosen pitch.
    const seeded: DrumCell[] = defaultCells();
    seeded[1] = { on: true, midi: 75 };
    const cells = applyEuclidean(seeded, 4);
    expect(cells[1]).toEqual({ on: false, midi: 75 });
  });

  it('returns a new array (never mutates input)', () => {
    const before = defaultCells();
    const after = applyEuclidean(before, 5);
    expect(after).not.toBe(before);
    expect(before.every((c) => c.on === false)).toBe(true);
  });

  it('always emits exactly STEP_COUNT cells', () => {
    expect(applyEuclidean([], 3)).toHaveLength(STEP_COUNT);
    expect(applyEuclidean(defaultCells(), 5)).toHaveLength(STEP_COUNT);
  });
});

describe('drumseqz / Eucl slider transact contract', () => {
  // The card's setEuclid() handler MUST do a single ydoc.transact that:
  //   1. writes the new trkN_euclid param value
  //   2. rewrites only the targeted track's cells (other tracks untouched)
  //   3. emits exactly one Yjs update event (atomic for collaborators)
  // We exercise the same shape via SyncedStore here (no Svelte / no DOM).
  type Store = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

  function setupStore() {
    const patch = syncedStore<Store>({ nodes: {}, edges: {} });
    const ydoc = getYjsDoc(patch);
    patch.nodes['ds'] = {
      id: 'ds',
      type: 'drumseqz',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: {
        tracks: defaultTracks().map((t) => ({
          cells: t.cells.map((c) => ({ on: c.on, midi: c.midi })),
        })),
      },
    };
    return { patch, ydoc };
  }

  // SyncedStore types `patch.nodes` as `Partial<Record<string, ModuleNode>>`
  // (every key is implicitly optional). Use the runtime shape directly via
  // `typeof patch` so the inner setEuclid sees the same MappedTypeDescription
  // the constructor returns.
  type LivePatch = ReturnType<typeof setupStore>['patch'];

  function setEuclid(
    patch: LivePatch,
    ydoc: ReturnType<typeof getYjsDoc>,
    nodeId: string,
    trackIdx: number,
    k: number,
  ) {
    const target = patch.nodes[nodeId];
    if (!target) return;
    const arr = coerceToDrumseqzTracks((target.data as Record<string, unknown>)?.tracks);
    const cells = applyEuclidean(arr[trackIdx]?.cells ?? [], k);
    ydoc.transact(() => {
      target.params[`trk${trackIdx + 1}_euclid`] = k;
      if (!target.data) target.data = {};
      const next: DrumTrack[] = arr.map((tr, idx) => ({
        cells: (idx === trackIdx ? cells : tr.cells).map((c) => ({ on: c.on, midi: c.midi })),
      }));
      (target.data as Record<string, unknown>).tracks = next;
    });
  }

  it('emits exactly one Yjs update for a slider move (param + cells in one transact)', () => {
    const { patch, ydoc } = setupStore();
    let updates = 0;
    ydoc.on('update', () => { updates += 1; });
    setEuclid(patch, ydoc, 'ds', 1, 4);
    expect(updates, 'expected single Yjs update for atomic Eucl slider commit').toBe(1);
  });

  it('writes the trkN_euclid param value', () => {
    const { patch, ydoc } = setupStore();
    setEuclid(patch, ydoc, 'ds', 0, 5);
    expect(patch.nodes['ds']?.params['trk1_euclid']).toBe(5);
    setEuclid(patch, ydoc, 'ds', 2, 3);
    expect(patch.nodes['ds']?.params['trk3_euclid']).toBe(3);
  });

  it('rewrites only the targeted track; other tracks untouched', () => {
    const { patch, ydoc } = setupStore();
    // Hand-place a gate on track 3 (index 2) step 7, plus midi=70 elsewhere.
    const initialTracks: DrumTrack[] = defaultTracks();
    initialTracks[2]!.cells[7] = { on: true, midi: 70 };
    initialTracks[3]!.cells[15] = { on: true, midi: 80 };
    (patch.nodes['ds']!.data as Record<string, unknown>).tracks = initialTracks.map((tr) => ({
      cells: tr.cells.map((c) => ({ on: c.on, midi: c.midi })),
    }));

    setEuclid(patch, ydoc, 'ds', 0, 4); // rewrite track 0 only

    const tracks = coerceToDrumseqzTracks(
      (patch.nodes['ds']!.data as Record<string, unknown>).tracks,
    );
    // Track 0 was rewritten to E(4,16): pulses at 0, 4, 8, 12.
    expect(tracks[0]!.cells.map((c) => (c.on ? 1 : 0))).toEqual(bjorklund(4, STEP_COUNT));
    // Tracks 1, 3 are still all-off defaults.
    expect(tracks[1]!.cells.every((c) => !c.on)).toBe(true);
    expect(tracks[3]!.cells.filter((c) => c.on)).toHaveLength(1);
    expect(tracks[3]!.cells[15]).toEqual({ on: true, midi: 80 });
    // Track 2's hand-placed gate at step 7 is untouched.
    expect(tracks[2]!.cells[7]).toEqual({ on: true, midi: 70 });
    expect(tracks[2]!.cells.filter((c) => c.on)).toHaveLength(1);
  });

  it('preserves per-cell midi in the targeted track when reapplying Eucl', () => {
    const { patch, ydoc } = setupStore();
    // Set midi values on cells without turning them on.
    const tracks: DrumTrack[] = defaultTracks();
    for (let i = 0; i < STEP_COUNT; i++) {
      tracks[0]!.cells[i] = { on: false, midi: 60 + i };
    }
    (patch.nodes['ds']!.data as Record<string, unknown>).tracks = tracks.map((tr) => ({
      cells: tr.cells.map((c) => ({ on: c.on, midi: c.midi })),
    }));

    setEuclid(patch, ydoc, 'ds', 0, 4);

    const result = coerceToDrumseqzTracks(
      (patch.nodes['ds']!.data as Record<string, unknown>).tracks,
    );
    // Pulses at 0, 4, 8, 12 with original midi preserved.
    expect(result[0]!.cells[0]).toEqual({ on: true, midi: 60 });
    expect(result[0]!.cells[4]).toEqual({ on: true, midi: 64 });
    // Off cells keep their midi too.
    expect(result[0]!.cells[1]).toEqual({ on: false, midi: 61 });
  });
});

describe('drumseqz / coerceToDrumseqzTracks: shape coercion', () => {
  it('returns 4 default tracks when input is undefined or wrong shape', () => {
    expect(coerceToDrumseqzTracks(undefined)).toHaveLength(TRACK_COUNT);
    expect(coerceToDrumseqzTracks({})).toHaveLength(TRACK_COUNT);
    expect(coerceToDrumseqzTracks(coerceToDrumseqzTracks(undefined))).toHaveLength(TRACK_COUNT);
  });

  it('pads truncated input up to TRACK_COUNT', () => {
    const tracks = coerceToDrumseqzTracks([{ cells: [{ on: true, midi: 60 }] }]);
    expect(tracks).toHaveLength(TRACK_COUNT);
    expect(tracks[0]!.cells).toHaveLength(STEP_COUNT);
    // First cell preserved.
    expect(tracks[0]!.cells[0]).toEqual({ on: true, midi: 60 });
    // Remaining padded with off/null.
    expect(tracks[0]!.cells[15]).toEqual({ on: false, midi: null });
  });

  it('truncates over-long input down to TRACK_COUNT', () => {
    const overlong = Array.from({ length: TRACK_COUNT + 5 }, () => ({
      cells: defaultCells(),
    }));
    const tracks = coerceToDrumseqzTracks(overlong);
    expect(tracks).toHaveLength(TRACK_COUNT);
  });
});

describe('drumseqz / cellVOct: per-track pitch fall-through math', () => {
  it('off cell returns null (silent)', () => {
    expect(cellVOct({ on: false, midi: 60 }, C3_MIDI, 0, 0)).toBeNull();
    expect(cellVOct({ on: false, midi: null }, C3_MIDI, 0, 0)).toBeNull();
  });

  it('per-step midi override beats the track root', () => {
    // c4 (midi 60) -> V/oct 0
    expect(cellVOct({ on: true, midi: 60 }, C3_MIDI, 0, 0)).toBe(0);
    // a4 (midi 69) -> V/oct 9/12 = 0.75
    expect(cellVOct({ on: true, midi: 69 }, C3_MIDI, 0, 0)).toBeCloseTo(0.75, 6);
  });

  it('null cell midi falls through to the track root', () => {
    // root C3 (midi 48) -> V/oct (48-60)/12 = -1
    expect(cellVOct({ on: true, midi: null }, C3_MIDI, 0, 0)).toBe(-1);
    // root c4 (midi 60) -> V/oct 0
    expect(cellVOct({ on: true, midi: null }, 60, 0, 0)).toBe(0);
  });

  it('track octave shifts by integer V/oct', () => {
    expect(cellVOct({ on: true, midi: 60 }, C3_MIDI, 1, 0)).toBe(1);
    expect(cellVOct({ on: true, midi: 60 }, C3_MIDI, -2, 0)).toBe(-2);
  });

  it('global octave stacks on top of track octave', () => {
    // c4 + trkOct 1 + globalOct 1 = +2 V/oct.
    expect(cellVOct({ on: true, midi: 60 }, C3_MIDI, 1, 1)).toBe(2);
    // root C3 + trkOct -1 + globalOct +1 = -1 + (-1) + 1 = -1 V/oct.
    expect(cellVOct({ on: true, midi: null }, C3_MIDI, -1, 1)).toBe(-1);
  });
});
