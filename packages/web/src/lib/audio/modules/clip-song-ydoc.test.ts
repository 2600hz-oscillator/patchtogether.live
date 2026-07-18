// packages/web/src/lib/audio/modules/clip-song-ydoc.test.ts
//
// SONG MODE v2 storage over REAL Y.Docs (syncedStore) — the sync-layer
// contracts ([[yjs-save-load-real-ydoc]]):
//   - save/load round-trip: a printed song survives an encodeStateAsUpdate →
//     applyUpdate bootstrap to a fresh peer, coerce-clean on both sides;
//   - PER-LANE key merge: two peers PRINT DIFFERENT lane channels concurrently
//     (offline) → both survive the merge (no whole-`notes`-map LWW);
//   - the arranger lane's tracks are a PER-KEY map (per-track writes merge);
//   - the print commit is IN-PLACE (read existing events from the LIVE proxy,
//     plain-copy, write a plain channel back into the lane key) — never a
//     map rebuild+reassign, and it never throws "Type already integrated".
//
// Mirrors clip-scene-repeats-ydoc's offline-merge + live-pump idioms.

import { describe, it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import * as Y from 'yjs';
import {
  ensureSongContainers,
  mergeSongNotes,
  coerceSongData,
  songNoteChannel,
  songNoteCount,
  type SongData,
  type SongNoteEvent,
} from './clip-song';

interface CPData {
  song?: SongData;
}
type Store = { nodes: Record<string, { id: string; type: string; data: CPData }> };
const CLIP = 'cp1';

function makePeer() {
  const store = syncedStore<Store>({ nodes: {} });
  const ydoc = getYjsDoc(store);
  return { store, ydoc };
}
/** Seed peer A with a clipplayer node whose SONG containers exist (the factory
 *  load-seam discipline — created OUTSIDE the racy commit path). */
function seedA(a: ReturnType<typeof makePeer>) {
  a.ydoc.transact(() => {
    a.store.nodes[CLIP] = { id: CLIP, type: 'clipplayer', data: {} };
    ensureSongContainers(a.store.nodes[CLIP]!.data);
  });
}
function bootstrapB(a: ReturnType<typeof makePeer>) {
  const b = makePeer();
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  return b;
}
function dataOf(p: ReturnType<typeof makePeer>): CPData {
  return p.store.nodes[CLIP]!.data;
}
/** Simulate the engine's flushSongNotes commit for ONE lane (per-key, in-place,
 *  reading existing events from the LIVE proxy + plain-merging). */
function commitLane(p: ReturnType<typeof makePeer>, lane: number, incoming: SongNoteEvent[]) {
  p.ydoc.transact(() => {
    const d = dataOf(p);
    ensureSongContainers(d);
    const existing = songNoteChannel(d.song, lane)?.events ?? [];
    d.song!.notes![String(lane)] = { events: mergeSongNotes(existing, incoming) };
  });
}

describe('SONG storage over real Y.Docs', () => {
  it('save/load round-trip: a printed song bootstraps to a fresh peer, coerce-clean', () => {
    const a = makePeer();
    seedA(a);
    commitLane(a, 0, [{ beat: 0, midi: 60, velocity: 100, lengthBeats: 0.5 }, { beat: 1, midi: 64 }]);
    commitLane(a, 3, [{ beat: 0.5, midi: 48 }]);

    const b = bootstrapB(a);
    // The live proxy carries the printed notes on the fresh peer.
    expect(songNoteCount(dataOf(b).song)).toBe(3);
    // coerceSongData severs the live children into a clean plain object.
    const clean = coerceSongData(dataOf(b).song);
    expect(clean.notes!['0']!.events.map((e) => e.midi)).toEqual([60, 64]);
    expect(clean.notes!['3']!.events[0]).toEqual({ beat: 0.5, midi: 48 });
  });

  it('PER-LANE merge: two peers PRINT DIFFERENT channels concurrently (offline) — both survive', () => {
    const a = makePeer();
    seedA(a);
    const b = bootstrapB(a); // then OFFLINE

    commitLane(a, 0, [{ beat: 0, midi: 60 }]);
    commitLane(b, 1, [{ beat: 0, midi: 62 }]);

    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    for (const [name, p] of [['A', a] as const, ['B', b] as const]) {
      const s = dataOf(p).song;
      expect(songNoteChannel(s, 0)?.events[0]?.midi, `peer ${name}: lane 0 survived`).toBe(60);
      expect(songNoteChannel(s, 1)?.events[0]?.midi, `peer ${name}: lane 1 survived`).toBe(62);
    }
  });

  it('IN-PLACE overdub: re-committing the SAME lane merges with the live existing events (no throw, no loss)', () => {
    const a = makePeer();
    seedA(a);
    commitLane(a, 0, [{ beat: 0, midi: 60 }, { beat: 2, midi: 64 }]);
    // A second pass punches in a middle onset — reads existing from the LIVE
    // proxy, plain-copies, merges. This must not throw "Type already integrated".
    expect(() => commitLane(a, 0, [{ beat: 1, midi: 62 }])).not.toThrow();
    const clean = coerceSongData(dataOf(a).song);
    expect(clean.notes!['0']!.events.map((e) => e.beat)).toEqual([0, 1, 2]);
  });

  it('arranger-lane tracks are a PER-KEY map: two peers add DIFFERENT tracks concurrently — both survive', () => {
    const a = makePeer();
    seedA(a);
    const b = bootstrapB(a);

    a.ydoc.transact(() => {
      dataOf(a).song!.arrangerAuto!.tracks['modA::freq'] = { events: [{ beat: 0, value: 0.5 }] };
    });
    b.ydoc.transact(() => {
      dataOf(b).song!.arrangerAuto!.tracks['modB::gain'] = { events: [{ beat: 0, value: 0.2 }] };
    });

    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    for (const p of [a, b]) {
      const clean = coerceSongData(dataOf(p).song);
      expect(Object.keys(clean.arrangerAuto!.tracks).sort()).toEqual(['modA::freq', 'modB::gain']);
    }
  });

  it('LIVE PUMP: a print on peer A propagates to peer B', () => {
    const a = makePeer();
    seedA(a);
    const b = makePeer();
    const pump = (to: Y.Doc) => (u: Uint8Array) => Y.applyUpdate(to, u);
    a.ydoc.on('update', pump(b.ydoc));
    b.ydoc.on('update', pump(a.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    commitLane(a, 5, [{ beat: 0, midi: 36 }, { beat: 1, midi: 38 }]);
    expect(songNoteCount(dataOf(b).song)).toBe(2);
    expect(songNoteChannel(dataOf(b).song, 5)?.events.map((e) => e.midi)).toEqual([36, 38]);
  });
});
