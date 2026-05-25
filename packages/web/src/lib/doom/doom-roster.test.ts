// packages/web/src/lib/doom/doom-roster.test.ts
//
// Unit suite for the slice-3 joined-player roster — the pure claim/release/
// prune logic that backs `node.data.players`. No Yjs, no WASM, no DOM: these
// are plain functions over a plain roster object, so we can pin slot
// assignment, the 4-player cap, idempotency, and disconnect pruning exactly.

import { describe, it, expect } from 'vitest';
import {
  MAX_DOOM_PLAYERS,
  readRoster,
  slotForUser,
  isPlayer,
  rosterUsers,
  rosterSize,
  isFull,
  firstEmptySlot,
  claimSlot,
  releaseSlot,
  pruneRoster,
} from './doom-roster';

describe('doom-roster: readRoster', () => {
  it('returns empty for non-object / missing players', () => {
    expect(readRoster(undefined)).toEqual({});
    expect(readRoster(null)).toEqual({});
    expect(readRoster(42)).toEqual({});
    expect(readRoster({})).toEqual({});
    expect(readRoster({ players: null })).toEqual({});
    expect(readRoster({ players: 'nope' })).toEqual({});
  });

  it('normalizes valid entries + drops malformed ones', () => {
    const r = readRoster({
      players: {
        '0': 'alice',
        '1': 'bob',
        '2': '', // empty id → dropped
        '3': 123, // non-string → dropped
        '4': 'over-cap', // slot >= cap → dropped
        '-1': 'neg', // negative slot → dropped
        foo: 'bar', // non-int key → dropped
      },
    });
    expect(r).toEqual({ '0': 'alice', '1': 'bob' });
  });

  it('returns a fresh copy that does not alias the source', () => {
    const src = { players: { '0': 'alice' } };
    const r = readRoster(src);
    r['1'] = 'mutant';
    expect(src.players).toEqual({ '0': 'alice' });
  });
});

describe('doom-roster: queries', () => {
  const roster = { '0': 'alice', '2': 'carol' };

  it('slotForUser finds the held slot or null', () => {
    expect(slotForUser(roster, 'alice')).toBe(0);
    expect(slotForUser(roster, 'carol')).toBe(2);
    expect(slotForUser(roster, 'nobody')).toBeNull();
  });

  it('isPlayer reflects roster membership', () => {
    expect(isPlayer(roster, 'alice')).toBe(true);
    expect(isPlayer(roster, 'nobody')).toBe(false);
  });

  it('rosterUsers / rosterSize report occupancy', () => {
    expect(rosterUsers(roster).sort()).toEqual(['alice', 'carol']);
    expect(rosterSize(roster)).toBe(2);
  });

  it('firstEmptySlot returns the lowest free index', () => {
    expect(firstEmptySlot({})).toBe(0);
    expect(firstEmptySlot({ '0': 'a' })).toBe(1);
    expect(firstEmptySlot({ '0': 'a', '1': 'b' })).toBe(2);
    // Holes are filled lowest-first: slot 0 free even though 1 is taken.
    expect(firstEmptySlot({ '1': 'b' })).toBe(0);
  });

  it('isFull / firstEmptySlot at the 4-player cap', () => {
    const full = { '0': 'a', '1': 'b', '2': 'c', '3': 'd' };
    expect(rosterSize(full)).toBe(MAX_DOOM_PLAYERS);
    expect(isFull(full)).toBe(true);
    expect(firstEmptySlot(full)).toBeNull();
  });
});

describe('doom-roster: claimSlot', () => {
  it('claims the first empty slot for a new user', () => {
    const { roster, changed, slot } = claimSlot({}, 'alice');
    expect(slot).toBe(0);
    expect(changed).toBe(true);
    expect(roster).toEqual({ '0': 'alice' });
  });

  it('assigns lex-stable slots when claims arrive in order', () => {
    let r = {};
    ({ roster: r } = claimSlot(r, 'aaa'));
    ({ roster: r } = claimSlot(r, 'bbb'));
    ({ roster: r } = claimSlot(r, 'ccc'));
    expect(r).toEqual({ '0': 'aaa', '1': 'bbb', '2': 'ccc' });
  });

  it('is idempotent: re-claiming returns the held slot unchanged', () => {
    const start = { '0': 'alice' };
    const { roster, changed, slot } = claimSlot(start, 'alice');
    expect(slot).toBe(0);
    expect(changed).toBe(false);
    expect(roster).toBe(start); // same reference (no mutation)
  });

  it('fills the lowest hole left by a departed player', () => {
    // alice (0), bob (1); bob leaves → slot 1 free; carol claims it.
    const afterLeave = { '0': 'alice' };
    const { roster, slot } = claimSlot(afterLeave, 'carol');
    expect(slot).toBe(0 + 1);
    expect(roster).toEqual({ '0': 'alice', '1': 'carol' });
  });

  it('refuses to claim when the roster is full (no slot, unchanged)', () => {
    const full = { '0': 'a', '1': 'b', '2': 'c', '3': 'd' };
    const { roster, changed, slot } = claimSlot(full, 'eve');
    expect(slot).toBeNull();
    expect(changed).toBe(false);
    expect(roster).toBe(full);
  });

  it('a user already in a full roster still resolves to their slot', () => {
    const full = { '0': 'a', '1': 'b', '2': 'c', '3': 'd' };
    const { changed, slot } = claimSlot(full, 'c');
    expect(slot).toBe(2);
    expect(changed).toBe(false);
  });

  it('does not mutate the input roster', () => {
    const start = { '0': 'alice' };
    claimSlot(start, 'bob');
    expect(start).toEqual({ '0': 'alice' });
  });
});

describe('doom-roster: releaseSlot', () => {
  it('removes the user from their slot', () => {
    const { roster, changed, slot } = releaseSlot({ '0': 'alice', '1': 'bob' }, 'alice');
    expect(slot).toBe(0);
    expect(changed).toBe(true);
    expect(roster).toEqual({ '1': 'bob' });
  });

  it('is idempotent for a user not in the roster', () => {
    const start = { '0': 'alice' };
    const { roster, changed, slot } = releaseSlot(start, 'nobody');
    expect(slot).toBeNull();
    expect(changed).toBe(false);
    expect(roster).toBe(start);
  });

  it('leaves a hole that claimSlot then refills lowest-first', () => {
    let r: Record<string, string> = { '0': 'alice', '1': 'bob', '2': 'carol' };
    ({ roster: r } = releaseSlot(r, 'alice')); // free slot 0
    expect(r).toEqual({ '1': 'bob', '2': 'carol' });
    ({ roster: r } = claimSlot(r, 'dave'));
    expect(r).toEqual({ '0': 'dave', '1': 'bob', '2': 'carol' });
  });

  it('does not mutate the input roster', () => {
    const start = { '0': 'alice', '1': 'bob' };
    releaseSlot(start, 'alice');
    expect(start).toEqual({ '0': 'alice', '1': 'bob' });
  });
});

describe('doom-roster: pruneRoster (disconnect cleanup)', () => {
  it('drops entries whose user is no longer live', () => {
    const roster = { '0': 'alice', '1': 'bob', '2': 'carol' };
    const { roster: next, changed } = pruneRoster(roster, ['alice', 'carol']);
    expect(changed).toBe(true);
    expect(next).toEqual({ '0': 'alice', '2': 'carol' });
  });

  it('is a no-op when everyone is still live (same reference)', () => {
    const roster = { '0': 'alice', '1': 'bob' };
    const { roster: next, changed } = pruneRoster(roster, ['alice', 'bob', 'late-joiner']);
    expect(changed).toBe(false);
    expect(next).toBe(roster);
  });

  it('preserves stable slot indices for survivors (no reshuffle)', () => {
    // alice in slot 0 leaves; bob KEEPS slot 1 (DOOM slot semantics).
    const roster = { '0': 'alice', '1': 'bob' };
    const { roster: next } = pruneRoster(roster, ['bob']);
    expect(next).toEqual({ '1': 'bob' });
  });

  it('clears the whole roster when nobody is live', () => {
    const { roster: next, changed } = pruneRoster({ '0': 'alice' }, []);
    expect(changed).toBe(true);
    expect(next).toEqual({});
  });
});
