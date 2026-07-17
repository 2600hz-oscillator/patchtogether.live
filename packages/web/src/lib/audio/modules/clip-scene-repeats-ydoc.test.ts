// packages/web/src/lib/audio/modules/clip-scene-repeats-ydoc.test.ts
//
// SCENE REPEATS over REAL Y.Docs (syncedStore) — the sync-layer contracts:
//   - `sceneRepeats` is a PER-KEY map: two peers setting DIFFERENT scenes'
//     counts concurrently (offline) both survive the merge (no whole-map LWW);
//   - the auto-advance write is IDEMPOTENT/CONVERGENT: two peers writing the
//     SAME advance concurrently merge to one consistent state (identical
//     queued plan + marker) — the engine-side no-op application is covered in
//     clipplayer-scene-repeats.test.ts;
//   - the `sceneLaunch` marker + count sync live through a doc-to-doc pump
//     (what every peer's repeat tracker re-anchors from).
//
// Real syncedStore + Y.applyUpdate, mirroring clip-automation-integration's
// offline-merge + live-pump idioms ([[yjs-save-load-real-ydoc]]).

import { describe, it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import * as Y from 'yjs';
import {
  setSceneRepeat,
  sceneRepeatCount,
  applySceneLaunchWrite,
  readSceneLaunch,
} from './clip-scene-repeats';
import { clipIndex, defaultNoteClip, type ClipPlayerData } from './clip-types';

type Store = { nodes: Record<string, { id: string; type: string; data: ClipPlayerData }> };
const CLIP = 'cp1';

function makePeer() {
  const store = syncedStore<Store>({ nodes: {} });
  const ydoc = getYjsDoc(store);
  return { store, ydoc };
}
/** Seed peer A with a clipplayer node whose containers exist (the factory
 *  load-seam discipline: `sceneRepeats` is created OUTSIDE the racy writes). */
function seedA(a: ReturnType<typeof makePeer>) {
  a.ydoc.transact(() => {
    a.store.nodes[CLIP] = {
      id: CLIP,
      type: 'clipplayer',
      data: {
        sv: 2,
        clips: {
          [String(clipIndex(0, 0))]: defaultNoteClip(),
          [String(clipIndex(1, 0))]: defaultNoteClip(),
          [String(clipIndex(1, 3))]: defaultNoteClip(),
        },
        sceneRepeats: {},
        sceneLaunch: { slot: 0, n: 1 },
      },
    };
  });
}
function bootstrapB(a: ReturnType<typeof makePeer>) {
  const b = makePeer();
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  return b;
}
function dataOf(p: ReturnType<typeof makePeer>): ClipPlayerData {
  return p.store.nodes[CLIP]!.data;
}

describe('sceneRepeats over real Y.Docs', () => {
  it('PER-KEY merge: two peers set DIFFERENT scenes concurrently (offline) — both counts survive on both peers', () => {
    const a = makePeer();
    seedA(a);
    const b = bootstrapB(a); // then OFFLINE — updates exchanged only at the end

    a.ydoc.transact(() => setSceneRepeat(dataOf(a), 0, 4));
    b.ydoc.transact(() => setSceneRepeat(dataOf(b), 1, 2));

    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    for (const [name, p] of [['A', a] as const, ['B', b] as const]) {
      expect(sceneRepeatCount(dataOf(p), 0), `peer ${name}: A's count survived`).toBe(4);
      expect(sceneRepeatCount(dataOf(p), 1), `peer ${name}: B's count survived`).toBe(2);
    }
  });

  it('setting INFINITE deletes only its key — concurrently with another peer setting a different scene', () => {
    const a = makePeer();
    seedA(a);
    a.ydoc.transact(() => {
      setSceneRepeat(dataOf(a), 0, 4);
      setSceneRepeat(dataOf(a), 1, 7);
    });
    const b = bootstrapB(a);

    a.ydoc.transact(() => setSceneRepeat(dataOf(a), 0, 0)); // back to infinite
    b.ydoc.transact(() => setSceneRepeat(dataOf(b), 5, 3));

    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    for (const p of [a, b]) {
      expect(sceneRepeatCount(dataOf(p), 0)).toBe(0);
      expect(sceneRepeatCount(dataOf(p), 1)).toBe(7);
      expect(sceneRepeatCount(dataOf(p), 5)).toBe(3);
    }
  });

  it('CONCURRENT IDENTICAL advance writes converge — one consistent queued plan + marker on both peers (no divergent double-launch state)', () => {
    const a = makePeer();
    seedA(a);
    const b = bootstrapB(a);

    // Both peers' engines decide the SAME advance from the same synced state
    // (scene 0 → next content scene 1) within the race window and write it.
    a.ydoc.transact(() => applySceneLaunchWrite(dataOf(a), 1, false));
    b.ydoc.transact(() => applySceneLaunchWrite(dataOf(b), 1, false));

    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    const qA = dataOf(a).queued;
    const qB = dataOf(b).queued;
    // Identical content: lanes 0+3 launch slot 1, the rest stop — whichever
    // peer's write won the LWW, the PLAN is byte-identical (deterministic from
    // synced state), so the launch applies exactly once per lane.
    expect(qA).toEqual([1, 'stop', 'stop', 1, 'stop', 'stop', 'stop', 'stop']);
    expect(qB).toEqual(qA);
    const mA = readSceneLaunch(dataOf(a));
    const mB = readSceneLaunch(dataOf(b));
    expect(mA).toEqual(mB);
    expect(mA?.slot).toBe(1);
    expect(mA?.n).toBe(2); // both computed prev(1)+1 — identical marker either way
  });

  it('LIVE PUMP: a scene launch + a count edit propagate peer-to-peer (the re-anchor signal every tracker reads)', () => {
    const a = makePeer();
    seedA(a);
    const b = makePeer();
    const pump = (to: Y.Doc) => (u: Uint8Array) => Y.applyUpdate(to, u);
    a.ydoc.on('update', pump(b.ydoc));
    b.ydoc.on('update', pump(a.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    // Peer B sets a count; peer A sees it.
    b.ydoc.transact(() => setSceneRepeat(dataOf(b), 0, 2));
    expect(sceneRepeatCount(dataOf(a), 0)).toBe(2);

    // Peer A launches scene 1; peer B sees the queued plan AND the marker bump.
    a.ydoc.transact(() => applySceneLaunchWrite(dataOf(a), 1, false));
    expect(dataOf(b).queued).toEqual([1, 'stop', 'stop', 1, 'stop', 'stop', 'stop', 'stop']);
    expect(readSceneLaunch(dataOf(b))).toEqual({ slot: 1, n: 2 });

    // An EMPTY scene launch writes nothing on either peer.
    a.ydoc.transact(() => {
      expect(applySceneLaunchWrite(dataOf(a), 7, false)).toBe(false);
    });
    expect(readSceneLaunch(dataOf(b))?.n).toBe(2);
  });
});
