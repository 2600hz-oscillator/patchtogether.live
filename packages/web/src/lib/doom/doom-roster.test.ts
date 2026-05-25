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
  serializeRoster,
  assignRequestedSlots,
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

  it('decodes the JSON-STRING leaf form (the cross-context-safe shape)', () => {
    // DoomCard stores node.data.players as a JSON string (primitive leaf
    // syncs reliably; a nested Y.Map does not always reach a synced peer).
    expect(readRoster({ players: '{"0":"alice","1":"bob"}' })).toEqual({
      '0': 'alice',
      '1': 'bob',
    });
    // Malformed JSON string → empty, no throw.
    expect(readRoster({ players: '{bad json' })).toEqual({});
    // String form is normalized the same as the object form.
    expect(readRoster({ players: '{"0":"alice","4":"over-cap","x":"y"}' })).toEqual({
      '0': 'alice',
    });
  });

  it('serializeRoster ↔ readRoster round-trips (sorted keys, deterministic)', () => {
    const roster = { '2': 'carol', '0': 'alice', '1': 'bob' };
    const s = serializeRoster(roster);
    // Sorted keys → stable string regardless of insertion order.
    expect(s).toBe('{"0":"alice","1":"bob","2":"carol"}');
    expect(serializeRoster({ '0': 'alice', '1': 'bob', '2': 'carol' })).toBe(s);
    expect(readRoster({ players: s })).toEqual({
      '0': 'alice',
      '1': 'bob',
      '2': 'carol',
    });
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

describe('doom-roster: assignRequestedSlots (slice 4 — arbiter-authoritative)', () => {
  // This is the fix for the slice-3 clobber: instead of each peer writing the
  // roster (last-write-wins on a JSON string leaf → concurrent joins collide),
  // ONLY the arbiter writes, assigning slots from the batch of outstanding
  // join-requests in one deterministic pass. These tests pin that no two
  // concurrent requesters ever land in the same slot, the cap holds, and the
  // assignment is order-independent.

  it('two concurrent requesters get DISTINCT slots (no clobber)', () => {
    // The exact slice-3 race: both alice + bob request against an empty
    // roster at the same time. The single-pass arbiter assignment must give
    // them different slots — NOT both slot 0.
    const { roster, assigned, changed } = assignRequestedSlots({}, ['alice', 'bob']);
    expect(changed).toBe(true);
    // Lex order → alice slot 0, bob slot 1.
    expect(roster).toEqual({ '0': 'alice', '1': 'bob' });
    expect(assigned).toEqual({ alice: 0, bob: 1 });
    // No two users share a slot.
    const slots = Object.values(assigned);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('is order-independent (same assignment regardless of request order)', () => {
    const a = assignRequestedSlots({}, ['bob', 'alice', 'carol']);
    const b = assignRequestedSlots({}, ['carol', 'alice', 'bob']);
    expect(a.roster).toEqual(b.roster);
    expect(a.assigned).toEqual({ alice: 0, bob: 1, carol: 2 });
  });

  it('caps at MAX_DOOM_PLAYERS; the 5th requester is rejected', () => {
    const five = ['u1', 'u2', 'u3', 'u4', 'u5'];
    const { roster, assigned, rejected } = assignRequestedSlots({}, five);
    expect(rosterSize(roster)).toBe(MAX_DOOM_PLAYERS);
    expect(Object.keys(assigned).length).toBe(MAX_DOOM_PLAYERS);
    // u1..u4 (lex-first 4) get slots; u5 is rejected as full.
    expect(rejected).toEqual(['u5']);
    expect(assigned.u5).toBeUndefined();
    // Distinct slots for all four.
    expect(new Set(Object.values(assigned)).size).toBe(MAX_DOOM_PLAYERS);
  });

  it('keeps already-joined users in place (idempotent re-request)', () => {
    // alice already holds slot 0; she + a new requester bob both "request".
    // alice keeps slot 0, bob gets the next free slot — no reshuffle.
    const { roster, assigned } = assignRequestedSlots({ '0': 'alice' }, ['alice', 'bob']);
    expect(roster).toEqual({ '0': 'alice', '1': 'bob' });
    expect(assigned).toEqual({ alice: 0, bob: 1 });
  });

  it('fills the lowest free slot when an earlier slot is vacant', () => {
    // bob holds slot 1 (alice left slot 0). A new requester takes slot 0.
    const { roster } = assignRequestedSlots({ '1': 'bob' }, ['carol']);
    expect(roster).toEqual({ '0': 'carol', '1': 'bob' });
  });

  it('no-op (same reference, changed=false) when all requesters already joined', () => {
    const start = { '0': 'alice', '1': 'bob' };
    const { roster, changed } = assignRequestedSlots(start, ['alice', 'bob']);
    expect(changed).toBe(false);
    expect(roster).toBe(start);
  });

  it('does not mutate the input roster', () => {
    const start = { '0': 'alice' };
    assignRequestedSlots(start, ['bob', 'carol']);
    expect(start).toEqual({ '0': 'alice' });
  });

  it('ignores empty / non-string requesters defensively', () => {
    const { roster } = assignRequestedSlots({}, ['', 'alice', '']);
    expect(roster).toEqual({ '0': 'alice' });
  });

  it('a batch that exceeds the cap against a partially-full roster', () => {
    // Two slots taken; three new requesters → only two more fit, third
    // rejected.
    const start = { '0': 'a', '3': 'd' };
    const { roster, rejected } = assignRequestedSlots(start, ['e', 'f', 'g']);
    expect(rosterSize(roster)).toBe(MAX_DOOM_PLAYERS);
    // free slots were 1 + 2 → e, f (lex-first) take them; g rejected.
    expect(roster).toEqual({ '0': 'a', '1': 'e', '2': 'f', '3': 'd' });
    expect(rejected).toEqual(['g']);
  });
});
