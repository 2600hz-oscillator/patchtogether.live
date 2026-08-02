// packages/web/src/lib/control/push2/push-lane.test.ts
//
// The PURE lane-selection rules behind the owner's spec: which modules are in a
// lane, in what order, and which one's push card the Push shows by default.
//
// The load-bearing assertion in here is the ORDER one: the whole "most recent
// module added" rule is the claim that the column array's TAIL is the newest
// member. A test that only checked "focus is some member of the lane" would
// pass against `[0]` — so every default-focus case appends and watches the
// focus FOLLOW.
import { describe, it, expect } from 'vitest';

import {
  laneMembers,
  resolveLaneFocus,
  stepLaneFocus,
  laneFocusIndex,
  clampScrollDelta,
  PUSH_LANE_COUNT,
  MAX_SCROLL_STEP,
  type LaneNodeLike,
} from './push-lane';

/** A node map from `{ id: lane }` pairs. `null` = a node with no channel (a
 *  video module, or anything the video zone owns). */
function nodes(spec: Record<string, number | null>): Record<string, LaneNodeLike | undefined> {
  const out: Record<string, LaneNodeLike> = {};
  for (const [id, ch] of Object.entries(spec)) {
    out[id] = { data: ch === null ? {} : { channel: ch } };
  }
  return out;
}

const cols = (columns: Record<string, string[]>) => ({ columns });

describe('laneMembers — the ordered lane roster', () => {
  it('returns the column order, bottom tile first and the NEWEST member LAST', () => {
    const n = nodes({ vco: 1, filt: 1, vca: 1 });
    // Every add site appends (insertBottom), so this is what the array looks
    // like after adding vco, then filt, then vca.
    expect(laneMembers(n, cols({ '1': ['vco', 'filt', 'vca'] }), 1)).toEqual(['vco', 'filt', 'vca']);
  });

  it('PRUNES a member that left the lane and ADOPTS one the array lost', () => {
    // `moved` says channel 2 but is still listed under 1 → pruned.
    // `orphan` says channel 1 but is missing from the array (a lost concurrent
    // append) → adopted at the TAIL, the feature's own "added at bottom".
    const n = nodes({ vco: 1, moved: 2, orphan: 1 });
    expect(laneMembers(n, cols({ '1': ['vco', 'moved'] }), 1)).toEqual(['vco', 'orphan']);
  });

  it('a node with NO channel is in no lane at all (video modules are unreachable)', () => {
    const n = nodes({ vco: 1, cube: null });
    for (let lane = 1; lane <= PUSH_LANE_COUNT; lane++) {
      expect(laneMembers(n, cols({ '1': ['vco', 'cube'] }), lane)).not.toContain('cube');
    }
  });

  it('an absent mixer / absent column / out-of-range lane is EMPTY, not a throw', () => {
    const n = nodes({ vco: 1 });
    expect(laneMembers(n, undefined, 1)).toEqual(['vco']); // adopted by channel alone
    expect(laneMembers(n, cols({}), 2)).toEqual([]);
    expect(laneMembers(n, cols({ '1': ['vco'] }), 0)).toEqual([]);
    expect(laneMembers(n, cols({ '1': ['vco'] }), PUSH_LANE_COUNT + 1)).toEqual([]);
    expect(laneMembers({}, cols({ '1': ['ghost'] }), 1)).toEqual([]); // dead ids drop
  });
});

describe('resolveLaneFocus — viewed-else-newest', () => {
  const members = ['a', 'b', 'c'];

  it('a never-viewed lane focuses the MOST RECENTLY ADDED module (the tail)', () => {
    expect(resolveLaneFocus(members, null)).toBe('c');
  });

  it('the remembered module wins while it is still in the lane', () => {
    expect(resolveLaneFocus(members, 'a')).toBe('a');
  });

  it('a remembered module that LEFT the lane falls back to the tail', () => {
    // Deleted, moved to another lane, or removed by a peer — all the same here.
    expect(resolveLaneFocus(members, 'gone')).toBe('c');
  });

  it('an empty lane has no focus', () => {
    expect(resolveLaneFocus([], 'a')).toBeNull();
    expect(resolveLaneFocus([], null)).toBeNull();
  });

  it('ORDER NEGATIVE CONTROL: appending moves the default focus', () => {
    // If the rule read members[0] instead of the tail, this pair would both be
    // 'a' and the "most recently added" claim would be untested.
    expect(resolveLaneFocus(['a'], null)).toBe('a');
    expect(resolveLaneFocus(['a', 'd'], null)).toBe('d');
  });
});

describe('stepLaneFocus — the card flip encoder', () => {
  const m = ['a', 'b', 'c'];

  it('steps one card per detent, forwards and backwards', () => {
    expect(stepLaneFocus(m, 'a', 1)).toBe('b');
    expect(stepLaneFocus(m, 'b', 1)).toBe('c');
    expect(stepLaneFocus(m, 'b', -1)).toBe('a');
  });

  it('WRAPS at both ends', () => {
    expect(stepLaneFocus(m, 'c', 1)).toBe('a');
    expect(stepLaneFocus(m, 'a', -1)).toBe('c');
  });

  it('a hard flick is CLAMPED to ±4 so it cannot jump the list', () => {
    // decodeRelativeCc legitimately reports up to ±63.
    const long = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    expect(stepLaneFocus(long, 'a', 63)).toBe(long[MAX_SCROLL_STEP]); // 'e', not 'j'
    expect(stepLaneFocus(long, 'a', -63)).toBe(long[long.length - MAX_SCROLL_STEP]); // 'g'
  });

  it('a zero / non-finite delta holds the current card', () => {
    expect(stepLaneFocus(m, 'b', 0)).toBe('b');
    expect(stepLaneFocus(m, 'b', Number.NaN)).toBe('b');
  });

  it('an unknown current card restarts at the tail (the newest module)', () => {
    expect(stepLaneFocus(m, 'gone', 1)).toBe('c');
    expect(stepLaneFocus(m, null, 1)).toBe('c');
  });

  it('an empty lane has nothing to step to', () => {
    expect(stepLaneFocus([], 'a', 1)).toBeNull();
  });

  it('a one-module lane always lands on that module (wrap is a no-op)', () => {
    expect(stepLaneFocus(['solo'], 'solo', 1)).toBe('solo');
    expect(stepLaneFocus(['solo'], 'solo', -3)).toBe('solo');
  });
});

describe('clampScrollDelta / laneFocusIndex', () => {
  it('clamps to ±MAX_SCROLL_STEP and truncates', () => {
    expect(clampScrollDelta(63)).toBe(MAX_SCROLL_STEP);
    expect(clampScrollDelta(-63)).toBe(-MAX_SCROLL_STEP);
    expect(clampScrollDelta(2)).toBe(2);
    expect(clampScrollDelta(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('numbers from array index 0 = "1", so the DEFAULT focus reads N/N', () => {
    const m = ['a', 'b', 'c'];
    expect(laneFocusIndex(m, 'a')).toBe(1);
    expect(laneFocusIndex(m, 'c')).toBe(3); // the default focus → "3/3"
    expect(laneFocusIndex(m, 'gone')).toBeNull();
    expect(laneFocusIndex(m, null)).toBeNull();
  });
});
