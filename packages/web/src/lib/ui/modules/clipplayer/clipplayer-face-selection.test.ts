// packages/web/src/lib/ui/modules/clipplayer/clipplayer-face-selection.test.ts
//
// Pins the node-keyed SELECTION seam the launch panel writes and the note panel
// reads — specifically its ACCEPTANCE DOMAIN, because that is what shipped
// wrong: the guard checked `CLIP_COUNT` (the visible 8×8 = 64, a PAD count)
// against a STRIDE-64 flat key (`clipIndex(slot, lane) = lane * 64 + slot`), so
// every pad off lane 1 — 56 of the 64 visible pads — was silently ignored and
// the face's editor stayed bound to the previously selected clip. The launch
// panel's double-click had already CREATED the clip, so the failure left no
// error and no missing write to notice: only the selection was dropped.
//
// The e2e twin (face-clipplayer.spec.ts: "editor follows the pad you
// double-click across lanes") drives the real pads; this file pins the domain
// arithmetic so the next stride/count refactor fails HERE, in milliseconds,
// with the guard named.

import { describe, it, expect, beforeEach } from 'vitest';
import { patch, ydoc } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { CLIP_LANES, SCENE_STRIDE, clipIndex } from '$lib/audio/modules/clip-types';
import {
  clipplayerNowSticky,
  clipplayerSelectClip,
  clipplayerSelectedClip,
  clipplayerSetNowSticky,
} from './clipplayer-face-selection.svelte';

const NID = 'cpsel-node';
const NID2 = 'cpsel-node-2';

function makeNode(id: string): void {
  ydoc.transact(() => {
    patch.nodes[id] = {
      id,
      type: 'clipplayer',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: {},
    } as unknown as ModuleNode;
  });
}

function dropNode(id: string): void {
  ydoc.transact(() => {
    delete patch.nodes[id];
  });
}

beforeEach(() => {
  // Fresh nodes; a stale selection for these ids from a previous test is
  // reset by selecting 0 explicitly (the registry is module-global).
  makeNode(NID);
  makeNode(NID2);
  clipplayerSelectClip(NID, 0);
  clipplayerSelectClip(NID2, 0);
});

describe('clipplayerSelectClip acceptance domain', () => {
  it('defaults to clip 0 (lane 1, slot 1)', () => {
    expect(clipplayerSelectedClip('cpsel-never-touched')).toBe(0);
  });

  it('accepts every VISIBLE pad, on every lane — the stride-64 keys the grid renders', () => {
    // THE SHIPPED BUG, pinned by name: lane 2 slot 1 is flat index 64, the
    // first key the old `CLIP_COUNT` bound rejected.
    clipplayerSelectClip(NID, clipIndex(0, 1));
    expect(clipplayerSelectedClip(NID)).toBe(64);

    // Every corner of the visible 8×8.
    for (const [slot, lane] of [
      [0, 0],
      [7, 0],
      [0, 7],
      [7, 7],
      [2, 3],
    ] as const) {
      const idx = clipIndex(slot, lane);
      clipplayerSelectClip(NID, idx);
      expect(clipplayerSelectedClip(NID)).toBe(idx);
    }
  });

  it('accepts Launchpad-scrolled scenes past the visible 8 (slot up to SCENE_STRIDE-1)', () => {
    const idx = clipIndex(SCENE_STRIDE - 1, CLIP_LANES - 1); // 511, the key-space ceiling
    clipplayerSelectClip(NID, idx);
    expect(clipplayerSelectedClip(NID)).toBe(idx);
  });

  it('IGNORES (never clamps) indices outside the stride-64 key space', () => {
    clipplayerSelectClip(NID, clipIndex(2, 3));
    const held = clipplayerSelectedClip(NID);
    for (const bad of [-1, 0.5, NaN, CLIP_LANES * SCENE_STRIDE, 99999]) {
      clipplayerSelectClip(NID, bad);
      expect(clipplayerSelectedClip(NID)).toBe(held);
    }
  });

  it('is node-keyed: two players keep independent selections', () => {
    clipplayerSelectClip(NID, clipIndex(1, 1));
    clipplayerSelectClip(NID2, clipIndex(4, 6));
    expect(clipplayerSelectedClip(NID)).toBe(clipIndex(1, 1));
    expect(clipplayerSelectedClip(NID2)).toBe(clipIndex(4, 6));
  });

  it('prunes selections (and NOW flags) for deleted nodes on the next write', () => {
    clipplayerSelectClip(NID2, clipIndex(3, 3));
    clipplayerSetNowSticky(NID2, true);
    dropNode(NID2);
    // Any later select triggers the prune.
    clipplayerSelectClip(NID, clipIndex(1, 0));
    expect(clipplayerSelectedClip(NID2)).toBe(0); // back to the default
    expect(clipplayerNowSticky(NID2)).toBe(false);
    makeNode(NID2); // restore for the shared registry's other tests
  });
});

describe('clipplayerNowSticky', () => {
  it('defaults off, toggles per node', () => {
    expect(clipplayerNowSticky(NID)).toBe(false);
    clipplayerSetNowSticky(NID, true);
    expect(clipplayerNowSticky(NID)).toBe(true);
    expect(clipplayerNowSticky(NID2)).toBe(false);
    clipplayerSetNowSticky(NID, false);
    expect(clipplayerNowSticky(NID)).toBe(false);
  });
});
