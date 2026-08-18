// packages/web/src/lib/graph/lane-colors.test.ts
//
// THE ONE LANE-COLOUR DERIVATION (#1825) — the seam the node menu, the workflow
// column badges and the mixmstrs faceplate all read.
//
// ⚠ WHAT THIS IS ACTUALLY GUARDING is not "does it return eight strings". It is
// that there is exactly ONE answer to "which clip player is canonical" and one
// to "what colour is channel N", because Canvas held two of the first and was
// about to grow a second of the other. Each clause below is a way the two
// copies could have disagreed.

import { describe, expect, it } from 'vitest';
import { canonicalClipPlayerId, canonicalLaneColors } from './lane-colors';
import { PINNED_CLIP_ID } from './column-reconcile';
import { CLIP_LANES, defaultLaneColorHex, laneColorEff } from '$lib/audio/modules/clip-types';

type Nodes = Record<string, { type?: string; data?: unknown } | undefined>;

const player = (data?: unknown) => ({ type: 'clipplayer', data });
const other = { type: 'mixmstrs' as const };

describe('canonicalClipPlayerId', () => {
  it('null when the rack has no clip player at all', () => {
    expect(canonicalClipPlayerId({})).toBeNull();
    expect(canonicalClipPlayerId({ m: other, v: { type: 'vca' } } as Nodes)).toBeNull();
  });

  it('the lowest node id wins — NOT insertion order', () => {
    // Built in the WRONG order on purpose: `Object.entries` would answer 'zed'.
    const nodes: Nodes = { zed: player(), abc: player(), mid: player() };
    expect(canonicalClipPlayerId(nodes)).toBe('abc');
  });

  it('the PINNED player wins over a lower id — the clause Canvas had in ONE of its two copies', () => {
    // ⚠ THE REGRESSION THIS EXISTS FOR. `'clipplayer-1' < 'pinned-clipplayer'`,
    // so the lowest-id rule alone picks the palette-spawned player on a
    // workflow rack, while the column badges pick the pinned one — two sets of
    // channel colours on one screen. Asserted with the ordering that makes the
    // two rules DISAGREE, so a revert to either one alone is red.
    const nodes: Nodes = { 'clipplayer-1': player(), [PINNED_CLIP_ID]: player() };
    expect('clipplayer-1' < PINNED_CLIP_ID, 'the ids must really order this way').toBe(true);
    expect(canonicalClipPlayerId(nodes)).toBe(PINNED_CLIP_ID);
  });

  it('a node AT the pinned id that is not a clip player does not hijack the answer', () => {
    const nodes: Nodes = { [PINNED_CLIP_ID]: { type: 'mixmstrs' }, 'clipplayer-1': player() };
    expect(canonicalClipPlayerId(nodes)).toBe('clipplayer-1');
  });
});

describe('canonicalLaneColors', () => {
  it('EMPTY when there is no clip player — the "no lane" case every consumer must handle', () => {
    // Not black, not a default palette: `[]`. The faceplate reads this as "keep
    // the domain accent", and it can only do that if the absence is visible.
    expect(canonicalLaneColors({})).toEqual([]);
  });

  it('one colour per lane, off the clip module\'s own constant', () => {
    const cols = canonicalLaneColors({ cp: player() } as Nodes);
    expect(cols).toHaveLength(CLIP_LANES);
    expect(cols.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
  });

  it('unpicked lanes take the DEFAULT hue — the same one the card and the LEDs use', () => {
    const cols = canonicalLaneColors({ cp: player() } as Nodes);
    expect(cols).toEqual(Array.from({ length: CLIP_LANES }, (_, i) => defaultLaneColorHex(i)));
    // …and every lane is a DIFFERENT colour, which is the whole point of
    // colouring a console by channel.
    expect(new Set(cols).size).toBe(cols.length);
  });

  it('a PICKED colour overrides its lane and nothing else', () => {
    const picked = Array.from({ length: CLIP_LANES }, () => null) as (string | null)[];
    picked[2] = '#123456';
    const cols = canonicalLaneColors({ cp: player({ laneColor: picked }) } as Nodes);
    expect(cols[2]).toBe('#123456');
    expect(cols.filter((c, i) => i !== 2 && c !== defaultLaneColorHex(i))).toEqual([]);
  });

  it('it CHOOSES no colour — every entry is `laneColorEff` of the canonical player', () => {
    // The positive control: not "the output looks like colours" but "the output
    // IS the authority's output". A local palette that happened to match today
    // would fail here the moment `laneColorEff` changed.
    const data = { laneColor: [null, '#abcdef'] };
    const cols = canonicalLaneColors({ cp: player(data) } as Nodes);
    expect(cols).toEqual(
      Array.from({ length: CLIP_LANES }, (_, i) => laneColorEff(data as never, i)),
    );
  });

  it('reads the CANONICAL player, not just any player', () => {
    // Two players with different picks: the answer must follow the tie-break,
    // and swapping which one is pinned must swap the answer.
    const a = { laneColor: ['#aaaaaa'] };
    const b = { laneColor: ['#bbbbbb'] };
    expect(canonicalLaneColors({ 'clipplayer-1': player(a), [PINNED_CLIP_ID]: player(b) } as Nodes)[0]).toBe(
      '#bbbbbb',
    );
    expect(canonicalLaneColors({ 'clipplayer-1': player(a), 'clipplayer-2': player(b) } as Nodes)[0]).toBe(
      '#aaaaaa',
    );
  });
});
