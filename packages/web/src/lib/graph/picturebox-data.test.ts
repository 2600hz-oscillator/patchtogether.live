// packages/web/src/lib/graph/picturebox-data.test.ts
//
// REAL-Y.Doc tests for the picturebox slot-bank writers, against the SAME
// syncedStore + Y.Doc the live patch uses (`graph/store.ts`) — the discipline
// [[yjs-save-load-real-ydoc]] records, and the only way a "Type already
// integrated" regression can be caught by a unit.
//
// WHY THIS FILE EXISTS AT ALL. The pad-and-slice below used to be written TWICE
// inside `PictureboxCard.svelte` — the load path and the clear path were the
// same eighteen lines — and the dock faceplate's `fullViewBody` would have been
// the third copy. Two surfaces sharing one writer is only an improvement if the
// writer is pinned, so the properties the copies happened to share are asserted
// here rather than left as a shape three files agree on by luck.
//
// ⚠ WHAT THESE TESTS ARE FOR, beyond "the function works": every leg below is a
// property that was TRUE OF THE CARD and had to survive the extraction. The
// interesting one is the ORIGIN. `store.ts` configures
// `trackedOrigins: new Set([LOCAL_ORIGIN])`, so a write that forgets the tag is
// silently NOT UNDOABLE — it works, it syncs, it looks correct, and Cmd-Z does
// nothing. That failure is invisible to every other test in this repo, so it is
// driven here against the real UndoManager rather than asserted in prose.

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { patch, ydoc, createUndoManager } from '$lib/graph/store';
import { ASSET_SLOTS } from '$lib/video/asset-select';
import {
  padSlotArray,
  isSlotIndex,
  setSlotAsset,
  clearSlotAsset,
  setSingleImage,
} from './picturebox-data';
import type { ModuleNode } from './types';

const NID = 'picturebox-data-test';

function makeNode(data: Record<string, unknown> = {}): void {
  patch.nodes[NID] = {
    id: NID,
    type: 'picturebox',
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
    data,
  } as unknown as ModuleNode;
}

/** The node's live `data`, read back through the real store. */
function readData(): Record<string, unknown> {
  return (patch.nodes[NID]?.data ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  // ⚠ GUARDED. SyncedStore's proxy throws `'deleteProperty' on proxy: trap
  // returned falsish` when the key was never written, and several tests here
  // (the pure `padSlotArray` / `isSlotIndex` legs, and the missing-node leg)
  // deliberately never create one.
  if (patch.nodes[NID]) delete patch.nodes[NID];
});

const JPEG = { base64: 'AAAA', mime: 'image/jpeg' };
const GIF = { base64: 'BBBB', mime: 'image/gif' };

describe('padSlotArray — the reader-side default that replaces a migration', () => {
  // ⚠ THE DEF DOCUMENTS A `schemaVersion` / `migrate` PAIR THAT HAS NEVER
  // EXISTED (fixed in the same PR as this file). The forward-compat behaviour is
  // real and it lives HERE: every absent or short array reads as seven nulls, so
  // a node written before `assets` / `assetMimes` existed is readable with no
  // rewrite step. These are the cases that actually occur on old racks.
  it('defaults an ABSENT array to exactly ASSET_SLOTS nulls', () => {
    expect(padSlotArray(undefined)).toEqual(new Array(ASSET_SLOTS).fill(null));
  });

  it('defaults a NON-array (the corrupt / wrong-type case) rather than throwing', () => {
    // A render loop calls this; a throw here takes the faceplate down mid-drag.
    for (const junk of [null, 42, 'nope', {}, true]) {
      expect(padSlotArray(junk)).toEqual(new Array(ASSET_SLOTS).fill(null));
    }
  });

  it('PADS a short array and preserves what was already there', () => {
    const out = padSlotArray(['a', 'b']);
    expect(out.length).toBe(ASSET_SLOTS);
    expect(out[0]).toBe('a');
    expect(out[1]).toBe('b');
    expect(out.slice(2)).toEqual(new Array(ASSET_SLOTS - 2).fill(null));
  });

  it('TRUNCATES an over-long array — an over-long one is as wrong as a short one', () => {
    const out = padSlotArray(new Array(ASSET_SLOTS + 5).fill('x'));
    expect(out.length).toBe(ASSET_SLOTS);
  });

  it('returns a FRESH array, never the caller\'s (aliasing would mutate node.data)', () => {
    const src = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const out = padSlotArray(src);
    out[0] = 'MUTATED';
    expect(src[0]).toBe('a');
  });
});

describe('isSlotIndex — the range guard both writers share', () => {
  it('accepts exactly 0..ASSET_SLOTS-1', () => {
    const accepted = Array.from({ length: ASSET_SLOTS + 4 }, (_, i) => i - 2).filter(isSlotIndex);
    expect(accepted).toEqual(Array.from({ length: ASSET_SLOTS }, (_, i) => i));
  });

  it('rejects the shapes a UI can actually produce', () => {
    for (const bad of [-1, ASSET_SLOTS, 1.5, NaN, Infinity, -Infinity]) {
      expect(isSlotIndex(bad), `isSlotIndex(${bad})`).toBe(false);
    }
  });
});

describe('setSlotAsset / clearSlotAsset — real Y.Doc', () => {
  it('writes bytes, filename and MIME into ONE slot, keeping all three arrays parallel', () => {
    makeNode();
    setSlotAsset(NID, 3, JPEG, 'photo.jpg');
    const d = readData();
    expect(padSlotArray(d.assets)[3]).toBe(JPEG.base64);
    expect(padSlotArray(d.assetNames)[3]).toBe('photo.jpg');
    expect(padSlotArray(d.assetMimes)[3]).toBe(JPEG.mime);
    // …and touched nothing else. A writer that splatters neighbours would pass
    // a "slot 3 is set" assertion and still be wrong.
    for (const i of [0, 1, 2, 4, 5, 6]) {
      expect(padSlotArray(d.assets)[i], `slot ${i}`).toBeNull();
      expect(padSlotArray(d.assetNames)[i], `slot ${i}`).toBeNull();
      expect(padSlotArray(d.assetMimes)[i], `slot ${i}`).toBeNull();
    }
  });

  it('all three arrays land at exactly ASSET_SLOTS even from an EMPTY node', () => {
    makeNode();
    setSlotAsset(NID, 0, GIF, 'loop.gif');
    const d = readData();
    for (const key of ['assets', 'assetNames', 'assetMimes'] as const) {
      expect((d[key] as unknown[]).length, key).toBe(ASSET_SLOTS);
    }
  });

  it('UPGRADES a node whose arrays predate assetMimes (the v3-shaped node)', () => {
    // The real back-compat case: `assets` and `assetNames` present and full
    // length, `assetMimes` absent entirely.
    const assets = new Array(ASSET_SLOTS).fill(null);
    assets[1] = 'OLD';
    const names = new Array(ASSET_SLOTS).fill(null);
    names[1] = 'old.jpg';
    makeNode({ assets, assetNames: names });
    setSlotAsset(NID, 2, GIF, 'new.gif');
    const d = readData();
    // The pre-existing slot survives…
    expect(padSlotArray(d.assets)[1]).toBe('OLD');
    expect(padSlotArray(d.assetNames)[1]).toBe('old.jpg');
    // …its MIME defaults to null (= read as JPEG, which is correct: a node
    // written before this key existed could only hold JPEGs)…
    expect(padSlotArray(d.assetMimes)[1]).toBeNull();
    // …and the new slot is fully populated.
    expect(padSlotArray(d.assets)[2]).toBe(GIF.base64);
    expect(padSlotArray(d.assetMimes)[2]).toBe(GIF.mime);
  });

  it('clearSlotAsset nulls the SAME three entries and leaves its neighbours alone', () => {
    makeNode();
    setSlotAsset(NID, 4, JPEG, 'a.jpg');
    setSlotAsset(NID, 5, GIF, 'b.gif');
    clearSlotAsset(NID, 4);
    const d = readData();
    expect(padSlotArray(d.assets)[4]).toBeNull();
    expect(padSlotArray(d.assetNames)[4]).toBeNull();
    expect(padSlotArray(d.assetMimes)[4]).toBeNull();
    // The NEIGHBOUR is the negative control: a clear that reset the whole array
    // would pass every assertion above.
    expect(padSlotArray(d.assets)[5]).toBe(GIF.base64);
    expect(padSlotArray(d.assetNames)[5]).toBe('b.gif');
    expect(padSlotArray(d.assetMimes)[5]).toBe(GIF.mime);
  });

  it('REPEATED writes do not throw (the "Type already integrated" trap)', () => {
    // The exact shape that broke the control surface on its SECOND add: the
    // first write integrates the array into the Y.Doc, and a mutator that then
    // spreads the integrated value into a fresh one throws.
    makeNode();
    expect(() => {
      for (let i = 0; i < ASSET_SLOTS; i++) setSlotAsset(NID, i, JPEG, `f${i}.jpg`);
      for (let i = 0; i < ASSET_SLOTS; i++) clearSlotAsset(NID, i);
      for (let i = 0; i < ASSET_SLOTS; i++) setSlotAsset(NID, i, GIF, `g${i}.gif`);
    }).not.toThrow();
    expect(padSlotArray(readData().assets).every((v) => v === GIF.base64)).toBe(true);
  });

  it('an OUT-OF-RANGE slot is a no-op, not a throw and not a stray key', () => {
    makeNode();
    setSlotAsset(NID, 0, JPEG, 'keep.jpg');
    const before = JSON.stringify(readData());
    expect(() => {
      setSlotAsset(NID, -1, GIF, 'x.gif');
      setSlotAsset(NID, ASSET_SLOTS, GIF, 'x.gif');
      clearSlotAsset(NID, -1);
      clearSlotAsset(NID, ASSET_SLOTS);
    }).not.toThrow();
    expect(JSON.stringify(readData())).toBe(before);
  });

  it('a MISSING node is a safe no-op (deleted between the click and the commit)', () => {
    expect(() => {
      setSlotAsset('no-such-node', 0, JPEG, 'x.jpg');
      clearSlotAsset('no-such-node', 0);
      setSingleImage('no-such-node', JPEG, 'x.jpg');
    }).not.toThrow();
    expect(patch.nodes['no-such-node']).toBeUndefined();
  });
});

describe('setSingleImage — the "Choose image…" path', () => {
  it('writes bytes, MIME and name together', () => {
    makeNode();
    setSingleImage(NID, GIF, 'anim.gif');
    const d = readData();
    expect(d.imageBytes).toBe(GIF.base64);
    expect(d.imageMime).toBe(GIF.mime);
    expect(d.imageName).toBe('anim.gif');
  });

  it('does NOT touch the slot bank — the single image and the bank are separate state', () => {
    makeNode();
    setSlotAsset(NID, 6, JPEG, 'bank.jpg');
    setSingleImage(NID, GIF, 'single.gif');
    const d = readData();
    expect(padSlotArray(d.assets)[6]).toBe(JPEG.base64);
    expect(padSlotArray(d.assetNames)[6]).toBe('bank.jpg');
  });
});

describe('⚠ THE ORIGIN — the leg no other test in this repo can fail on', () => {
  // `mutate.ts` states the mechanism: an untagged write "is silently NOT
  // undoable", because `store.ts` sets `trackedOrigins: new Set([LOCAL_ORIGIN])`.
  // Every one of picturebox's pre-existing writers passed the tag; the whole
  // point of the extraction is that they keep doing so from two surfaces. So the
  // property is driven against a real UndoManager rather than described.
  // ⚠ THE PRODUCT'S OWN CONSTRUCTOR, not a second spelling of it. `store.ts`
  // exports `createUndoManager(ydoc)` and the live app calls exactly this — so
  // the roots it watches and the origins it tracks cannot drift from what these
  // assertions claim. A hand-rolled UndoManager here would be a different
  // instrument measuring a different thing (the first draft of this helper
  // watched `ydoc.getMap('patch')`, which the store does not use at all, and
  // reported every write as untracked).
  function withUndoManager<T>(fn: (um: Y.UndoManager) => T): T {
    const um = createUndoManager(ydoc);
    try {
      return fn(um);
    } finally {
      um.destroy();
    }
  }

  it('setSlotAsset lands on the undo stack (positive control)', () => {
    makeNode();
    withUndoManager((um) => {
      setSlotAsset(NID, 2, JPEG, 'undoable.jpg');
      expect(
        um.undoStack.length,
        'the write produced no undo entry — it was committed with an untracked ' +
          'origin, so Cmd-Z will silently do nothing on a real rack',
      ).toBeGreaterThan(0);
    });
  });

  it('clearSlotAsset and setSingleImage do too', () => {
    makeNode();
    setSlotAsset(NID, 2, JPEG, 'x.jpg');
    withUndoManager((um) => {
      clearSlotAsset(NID, 2);
      const afterClear = um.undoStack.length;
      expect(afterClear, 'clearSlotAsset produced no undo entry').toBeGreaterThan(0);
      // ⚠ `stopCapturing()` IS LOAD-BEARING, and leaving it out is how this leg
      // first failed. Y.UndoManager MERGES transactions that land inside its
      // `captureTimeout` (500 ms by default) into ONE stack item, so two writes
      // in the same tick produce one entry — a real property of the product's
      // undo, not a test artefact, and one a "the stack grew twice" assertion
      // would misread as a dropped origin.
      um.stopCapturing();
      setSingleImage(NID, GIF, 'y.gif');
      expect(um.undoStack.length, 'setSingleImage produced no undo entry').toBeGreaterThan(afterClear);
    });
  });

  it('…and the instrument can say NO (negative control on the UndoManager itself)', () => {
    // ⚠ Without this, a manager that recorded EVERYTHING — or one watching the
    // wrong root — would make the two legs above pass while proving nothing
    // about the origin. Drive the same store with a DIFFERENT origin and require
    // the stack to stay empty.
    makeNode();
    withUndoManager((um) => {
      const before = um.undoStack.length;
      ydoc.transact(() => {
        const target = patch.nodes[NID];
        if (target) (target.data as Record<string, unknown>).imageName = 'untracked.jpg';
      }, 'some-other-origin');
      expect(
        um.undoStack.length,
        'the manager recorded a write made with an UNTRACKED origin, so it is not ' +
          'measuring the origin at all and the two legs above are vacuous',
      ).toBe(before);
      // …and the write itself really happened, so this is not "nothing occurred".
      expect(readData().imageName).toBe('untracked.jpg');
    });
  });
});
