// clipplayer-arrange-edit.test.ts
//
// The store-aware arrangement edit helpers, exercised against the REAL
// SyncedStore patch + Y.Doc (repo memory yjs-save-load-real-ydoc — never mock
// the Y layer). Covers the px↔beat math, the commitMove no-op guard + ONE-
// transaction discipline, and that writeArrange is in-place safe (no "already
// integrated" throw, edits compose).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { writeArrange, xToBeat, commitMove } from './clipplayer-arrange-edit';
import { setBlockSlot, type ArrangeData } from '$lib/audio/modules/clip-arrange';

const NID = 'cp-arrange-edit-test';

/** Seed a clipplayer node with an arrangement, via a real ydoc transaction. */
function seed(arrangement: ArrangeData): void {
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'clipplayer',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: { arrangement },
    } as ModuleNode;
  });
}

/** Read the live (coerced-shape) arrangement back off the node. */
function readArrangement(): ArrangeData {
  const d = patch.nodes[NID]?.data as { arrangement?: ArrangeData } | undefined;
  return d?.arrangement ?? { events: [], lengthBeats: 0, loop: true };
}

beforeEach(() => {
  for (const k of Object.keys(patch.nodes)) delete patch.nodes[k];
});
afterEach(() => {
  for (const k of Object.keys(patch.nodes)) delete patch.nodes[k];
});

describe('xToBeat (px → song-beat)', () => {
  it('maps the timeline midpoint to half the length', () => {
    expect(xToBeat(156, 312, 16)).toBe(8);
  });
  it('clamps to [0, lengthBeats]', () => {
    expect(xToBeat(-50, 312, 16)).toBe(0);
    expect(xToBeat(9999, 312, 16)).toBe(16);
  });
  it('guards a zero/negative width or length', () => {
    expect(xToBeat(100, 0, 16)).toBe(0);
    expect(xToBeat(100, 312, 0)).toBe(0);
  });
});

describe('commitMove (drag commit on the real store)', () => {
  it('snaps the drop to the bar and retimes the launch, re-sorting', () => {
    seed({
      events: [
        { beat: 0, lane: 0, slot: 1 },
        { beat: 4, lane: 0, slot: 2 },
      ],
      lengthBeats: 8,
      loop: true,
    });
    // drag slot-2 from beat 4 to ~2.2, snap-to-beat (1) → 2
    commitMove(NID, 0, 4, 2.2, 1);
    const a = readArrangement();
    expect(a.events.map((e) => e.beat)).toEqual([0, 2]); // re-sorted
    expect(a.events.find((e) => e.slot === 2)?.beat).toBe(2);
    expect(a.events.find((e) => e.slot === 1)?.beat).toBe(0); // other untouched
    expect(a.lengthBeats).toBe(8); // length preserved
  });

  it('a snapped-to-source drop is a NO-OP (no write at all)', () => {
    seed({
      events: [
        { beat: 0, lane: 0, slot: 1 },
        { beat: 4, lane: 0, slot: 2 },
      ],
      lengthBeats: 8,
      loop: true,
    });
    let updates = 0;
    const h = () => { updates += 1; };
    ydoc.on('update', h);
    // drag slot-2 to 5.4, bar-snap (4) → 4 === source → skip the write
    commitMove(NID, 0, 4, 5.4, 4);
    ydoc.off('update', h);
    expect(updates).toBe(0); // no transaction fired
    expect(readArrangement().events.find((e) => e.slot === 2)?.beat).toBe(4); // unchanged
  });

  it('a real move fires EXACTLY ONE transaction', () => {
    seed({
      events: [
        { beat: 0, lane: 0, slot: 1 },
        { beat: 4, lane: 0, slot: 2 },
      ],
      lengthBeats: 8,
      loop: true,
    });
    let updates = 0;
    const h = () => { updates += 1; };
    ydoc.on('update', h);
    commitMove(NID, 0, 4, 0.6, 1); // → beat 1, a real move
    ydoc.off('update', h);
    expect(updates).toBe(1); // one ydoc.transact == one update event
  });
});

describe('writeArrange (in-place Y safety)', () => {
  it('composes across calls — the second edit sees the first, no Yjs throw', () => {
    seed({ events: [{ beat: 0, lane: 0, slot: 1 }], lengthBeats: 8, loop: true });
    // First edit: append a launch in lane 1.
    expect(() =>
      writeArrange(NID, (a) => ({
        ...a,
        events: [...a.events, { beat: 4, lane: 1, slot: 3 }],
      })),
    ).not.toThrow();
    // Second edit: swap lane 1's clip — must SEE the first edit's event.
    expect(() => writeArrange(NID, (a) => setBlockSlot(a, 1, 4, 5))).not.toThrow();
    const a = readArrangement();
    expect(a.events).toHaveLength(2);
    expect(a.events.find((e) => e.lane === 1)?.slot).toBe(5);
    expect(a.events.find((e) => e.lane === 0)?.slot).toBe(1);
  });

  it('seeds node.data + a fresh arrangement when absent', () => {
    ydoc.transact(() => {
      patch.nodes[NID] = {
        id: NID, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {},
      } as ModuleNode; // NO data
    });
    writeArrange(NID, (a) => ({ ...a, events: [...a.events, { beat: 2, lane: 0, slot: 0 }] }));
    const a = readArrangement();
    expect(a.events).toEqual([{ beat: 2, lane: 0, slot: 0 }]);
  });

  it('no-ops cleanly for a missing node', () => {
    expect(() => writeArrange('nope', (a) => a)).not.toThrow();
  });
});
