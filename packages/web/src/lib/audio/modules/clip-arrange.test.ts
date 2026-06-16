// packages/web/src/lib/audio/modules/clip-arrange.test.ts
//
// Pure SONG-MODE arranger model: the event log the clip player records launches
// into and replays from. Covers shape defaults, garbage coercion, ordered
// recording, the half-open playback window, and loop-length derivation.

import { describe, it, expect } from 'vitest';
import {
  defaultArrangeData,
  coerceArrangeData,
  coerceArrangeEvent,
  recordEvent,
  clearArrange,
  arrangeLengthBeats,
  eventsInRange,
  hasArrangement,
  arrangeBlocks,
  moveBlock,
  setBlockSlot,
  deleteBlock,
  setArrangeLength,
  type ArrangeData,
} from './clip-arrange';

describe('defaultArrangeData', () => {
  it('is an empty, open, looping arrangement', () => {
    expect(defaultArrangeData()).toEqual({ events: [], lengthBeats: 0, loop: true });
  });
});

describe('coerceArrangeEvent', () => {
  it('accepts a valid launch + a stop', () => {
    expect(coerceArrangeEvent({ beat: 4, lane: 2, slot: 3 })).toEqual({ beat: 4, lane: 2, slot: 3 });
    expect(coerceArrangeEvent({ beat: 0, lane: 0, slot: 'stop' })).toEqual({ beat: 0, lane: 0, slot: 'stop' });
    expect(coerceArrangeEvent({ beat: 1.5, lane: 7, slot: 0, immediate: true })).toEqual({
      beat: 1.5,
      lane: 7,
      slot: 0,
      immediate: true,
    });
  });
  it('rejects out-of-range / garbage', () => {
    expect(coerceArrangeEvent(null)).toBeNull();
    expect(coerceArrangeEvent({ beat: -1, lane: 0, slot: 0 })).toBeNull(); // negative beat
    expect(coerceArrangeEvent({ beat: 0, lane: 8, slot: 0 })).toBeNull(); // lane out of range
    expect(coerceArrangeEvent({ beat: 0, lane: 0, slot: 8 })).toBeNull(); // slot out of range
    expect(coerceArrangeEvent({ beat: 0, lane: 0, slot: 'play' })).toBeNull(); // bad slot
    expect(coerceArrangeEvent({ beat: 0, lane: 0 })).toBeNull(); // missing slot
  });
  it('drops a non-true immediate flag', () => {
    const e = coerceArrangeEvent({ beat: 0, lane: 0, slot: 0, immediate: 'yes' });
    expect(e).toEqual({ beat: 0, lane: 0, slot: 0 });
    expect(e?.immediate).toBeUndefined();
  });
});

describe('coerceArrangeData', () => {
  it('normalizes + sorts events, drops bad ones, defaults loop=true', () => {
    const d = coerceArrangeData({
      events: [
        { beat: 8, lane: 1, slot: 2 },
        { beat: 0, lane: 0, slot: 0 },
        { beat: 99, lane: 9, slot: 0 }, // dropped (bad lane)
        { beat: 4, lane: 2, slot: 'stop' },
      ],
      lengthBeats: 16,
    });
    expect(d.events.map((e) => e.beat)).toEqual([0, 4, 8]); // sorted, garbage gone
    expect(d.lengthBeats).toBe(16);
    expect(d.loop).toBe(true);
  });
  it('returns a fresh default for garbage', () => {
    expect(coerceArrangeData(null)).toEqual(defaultArrangeData());
    expect(coerceArrangeData({ events: 'nope', lengthBeats: -5, loop: false })).toEqual({
      events: [],
      lengthBeats: 0,
      loop: false,
    });
  });
});

describe('recordEvent', () => {
  it('appends in chronological order, immutably', () => {
    const d0 = defaultArrangeData();
    const d1 = recordEvent(d0, { beat: 4, lane: 0, slot: 1 });
    const d2 = recordEvent(d1, { beat: 0, lane: 1, slot: 2 }); // earlier — inserts before
    const d3 = recordEvent(d2, { beat: 8, lane: 2, slot: 3 });
    expect(d3.events.map((e) => e.beat)).toEqual([0, 4, 8]);
    expect(d0.events).toEqual([]); // original untouched
    expect(d1.events).toHaveLength(1);
  });
  it('keeps stable order for events at the SAME beat (scene order preserved)', () => {
    let d = defaultArrangeData();
    d = recordEvent(d, { beat: 4, lane: 0, slot: 0 });
    d = recordEvent(d, { beat: 4, lane: 1, slot: 0 });
    d = recordEvent(d, { beat: 4, lane: 2, slot: 0 });
    expect(d.events.map((e) => e.lane)).toEqual([0, 1, 2]); // insertion order at beat 4
  });
});

describe('clearArrange', () => {
  it('drops events but keeps loop settings', () => {
    const d: ArrangeData = { events: [{ beat: 0, lane: 0, slot: 0 }], lengthBeats: 16, loop: false };
    const c = clearArrange(d);
    expect(c.events).toEqual([]);
    expect(c.lengthBeats).toBe(16);
    expect(c.loop).toBe(false);
    expect(d.events).toHaveLength(1); // immutable
  });
});

describe('arrangeLengthBeats', () => {
  it('uses the explicit length when set', () => {
    expect(arrangeLengthBeats({ events: [], lengthBeats: 32, loop: true })).toBe(32);
  });
  it('derives from the last event, rounded up to the next bar (4 beats)', () => {
    expect(arrangeLengthBeats({ events: [{ beat: 0, lane: 0, slot: 0 }], lengthBeats: 0, loop: true })).toBe(4);
    expect(arrangeLengthBeats({ events: [{ beat: 5, lane: 0, slot: 0 }], lengthBeats: 0, loop: true })).toBe(8);
    expect(arrangeLengthBeats({ events: [{ beat: 12, lane: 0, slot: 0 }], lengthBeats: 0, loop: true })).toBe(16);
  });
  it('empty arrangement is one bar', () => {
    expect(arrangeLengthBeats(defaultArrangeData())).toBe(4);
  });
  it('honours a custom bar length', () => {
    expect(arrangeLengthBeats({ events: [{ beat: 4, lane: 0, slot: 0 }], lengthBeats: 0, loop: true }, 3)).toBe(6);
  });
});

describe('eventsInRange (the playback cursor window)', () => {
  const d: ArrangeData = {
    events: [
      { beat: 0, lane: 0, slot: 0 },
      { beat: 4, lane: 1, slot: 1 },
      { beat: 4, lane: 2, slot: 2 },
      { beat: 8, lane: 3, slot: 3 },
    ],
    lengthBeats: 16,
    loop: true,
  };
  it('returns events in the half-open window [from, to)', () => {
    expect(eventsInRange(d, 0, 4).map((e) => e.beat)).toEqual([0]); // 4 excluded
    expect(eventsInRange(d, 4, 8).map((e) => e.beat)).toEqual([4, 4]); // both at 4 fire once
    expect(eventsInRange(d, 8, 16).map((e) => e.beat)).toEqual([8]);
  });
  it('an event exactly on a tick boundary fires once, not twice', () => {
    // Cursor 3.9→4.1 catches beat 4; the next tick 4.1→4.5 must NOT re-fire it.
    expect(eventsInRange(d, 3.9, 4.1)).toHaveLength(2);
    expect(eventsInRange(d, 4.1, 4.5)).toHaveLength(0);
  });
  it('an empty / inverted range is empty', () => {
    expect(eventsInRange(d, 4, 4)).toEqual([]);
    expect(eventsInRange(d, 8, 4)).toEqual([]);
  });
});

describe('hasArrangement', () => {
  it('true only with ≥1 recorded launch', () => {
    expect(hasArrangement(undefined)).toBe(false);
    expect(hasArrangement(defaultArrangeData())).toBe(false);
    expect(hasArrangement({ events: [{ beat: 0, lane: 0, slot: 0 }], lengthBeats: 0, loop: true })).toBe(true);
  });
});

describe('arrangeBlocks (song-view derivation)', () => {
  it('a lane block runs from its launch until the next event (or arrangement end)', () => {
    const d: ArrangeData = {
      events: [
        { beat: 0, lane: 0, slot: 1 },
        { beat: 4, lane: 0, slot: 2 },
      ],
      lengthBeats: 8,
      loop: true,
    };
    const b = arrangeBlocks(d).filter((x) => x.lane === 0);
    expect(b).toEqual([
      { lane: 0, startBeat: 0, endBeat: 4, slot: 1 },
      { lane: 0, startBeat: 4, endBeat: 8, slot: 2 },
    ]);
  });
  it("a 'stop' event ends a block — its silent span emits none", () => {
    const d: ArrangeData = {
      events: [
        { beat: 0, lane: 1, slot: 0 },
        { beat: 4, lane: 1, slot: 'stop' },
        { beat: 6, lane: 1, slot: 3 },
      ],
      lengthBeats: 8,
      loop: true,
    };
    const b = arrangeBlocks(d).filter((x) => x.lane === 1);
    expect(b).toEqual([
      { lane: 1, startBeat: 0, endBeat: 4, slot: 0 }, // ends at the stop
      { lane: 1, startBeat: 6, endBeat: 8, slot: 3 }, // resumes; 4..6 is silent
    ]);
  });
  it('derives the end from the last event when length is open', () => {
    const d: ArrangeData = { events: [{ beat: 5, lane: 0, slot: 0 }], lengthBeats: 0, loop: true };
    // last event 5 → rounds up to 8 (next bar)
    expect(arrangeBlocks(d)[0]).toEqual({ lane: 0, startBeat: 5, endBeat: 8, slot: 0 });
  });
});

describe('song-view edit ops', () => {
  const base: ArrangeData = {
    events: [
      { beat: 0, lane: 0, slot: 1 },
      { beat: 4, lane: 0, slot: 2 },
    ],
    lengthBeats: 8,
    loop: true,
  };
  it('moveBlock retimes the launch (clamped ≥0) + re-sorts', () => {
    const d = moveBlock(base, 0, 4, 2);
    expect(d.events.map((e) => e.beat)).toEqual([0, 2]); // re-sorted
    expect(d.events.find((e) => e.slot === 2)?.beat).toBe(2);
    expect(moveBlock(base, 0, 0, -5).events[0].beat).toBe(0); // clamp
    expect(base.events[1].beat).toBe(4); // immutable
  });
  it('setBlockSlot swaps which clip the block launches', () => {
    const d = setBlockSlot(base, 0, 4, 5);
    expect(d.events.find((e) => e.beat === 4)?.slot).toBe(5);
    expect(base.events[1].slot).toBe(2); // immutable
  });
  it('deleteBlock removes the launch (prior clip extends over the gap)', () => {
    const d = deleteBlock(base, 0, 4);
    expect(d.events).toHaveLength(1);
    // the remaining slot-1 block now runs the whole length
    expect(arrangeBlocks(d)).toEqual([{ lane: 0, startBeat: 0, endBeat: 8, slot: 1 }]);
  });
  it('a no-match edit returns the data unchanged', () => {
    expect(moveBlock(base, 3, 0, 2)).toBe(base); // wrong lane
    expect(deleteBlock(base, 0, 99)).toBe(base); // no block at 99
  });
  it('setArrangeLength clamps ≥ 0', () => {
    expect(setArrangeLength(base, 16).lengthBeats).toBe(16);
    expect(setArrangeLength(base, -4).lengthBeats).toBe(0);
  });
});
