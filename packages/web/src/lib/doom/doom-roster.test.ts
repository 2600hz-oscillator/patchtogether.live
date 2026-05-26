// packages/web/src/lib/doom/doom-roster.test.ts
//
// Unit suite for the slice-3 joined-player roster — the pure claim/release/
// prune logic that backs `node.data.players`. No Yjs, no WASM, no DOM: these
// are plain functions over a plain roster object, so we can pin slot
// assignment, the 4-player cap, idempotency, and disconnect pruning exactly.

import { describe, it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import * as Y from 'yjs';
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
  applyRosterMap,
  assignRequestedSlots,
  readPending,
  readRosterState,
  serializePending,
  combinedRoster,
  slotForUserInState,
  isActivePlayer,
  isPendingPlayer,
  assignSlots,
  promotePending,
  pruneRosterState,
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

  // ── owner-first seating (the guest-as-P1 fix) ─────────────────────────────
  it('seats the rack OWNER at slot 0 even when its id is NOT lex-smallest', () => {
    // owner sorts lex-LARGE; guest sorts lex-small. Pre-fix the guest grabbed
    // slot 0 (Player 1) — the operator-reported bug. Owner-first ordering puts
    // the owner at slot 0.
    const { roster, assigned } = assignRequestedSlots(
      {},
      ['aaa-guest', 'zzz-owner'],
      ['zzz-owner'],
    );
    expect(roster).toEqual({ '0': 'zzz-owner', '1': 'aaa-guest' });
    expect(assigned).toEqual({ 'zzz-owner': 0, 'aaa-guest': 1 });
  });

  it('owner-first is order-independent', () => {
    const a = assignRequestedSlots({}, ['g1', 'zzz-owner', 'g2'], ['zzz-owner']);
    const b = assignRequestedSlots({}, ['g2', 'g1', 'zzz-owner'], ['zzz-owner']);
    expect(a.roster).toEqual(b.roster);
    expect(a.assigned).toEqual({ 'zzz-owner': 0, g1: 1, g2: 2 });
  });
});

describe('doom-roster slice 6: pending (late-join) vs active state', () => {
  describe('read / serialize', () => {
    it('readPending decodes the `pending` leaf (object + JSON-string forms)', () => {
      expect(readPending({ pending: { '1': 'bob' } })).toEqual({ '1': 'bob' });
      expect(readPending({ pending: '{"2":"carol"}' })).toEqual({ '2': 'carol' });
      expect(readPending({})).toEqual({});
      expect(readPending(undefined)).toEqual({});
      // Same normalization as readRoster (over-cap / malformed dropped).
      expect(readPending({ pending: { '4': 'x', '0': 'a' } })).toEqual({ '0': 'a' });
    });

    it('readRosterState reads both leaves at once', () => {
      const data = { players: '{"0":"alice"}', pending: '{"1":"bob"}' };
      expect(readRosterState(data)).toEqual({
        active: { '0': 'alice' },
        pending: { '1': 'bob' },
      });
    });

    it('serializePending round-trips through readPending', () => {
      const s = serializePending({ '2': 'carol', '1': 'bob' });
      expect(s).toBe('{"1":"bob","2":"carol"}');
      expect(readPending({ pending: s })).toEqual({ '1': 'bob', '2': 'carol' });
    });
  });

  describe('combined queries', () => {
    const state = { active: { '0': 'alice' }, pending: { '2': 'bob' } };

    it('combinedRoster unions both maps (one occupancy space)', () => {
      expect(combinedRoster(state)).toEqual({ '0': 'alice', '2': 'bob' });
    });

    it('slotForUserInState finds a user in either map', () => {
      expect(slotForUserInState(state, 'alice')).toBe(0);
      expect(slotForUserInState(state, 'bob')).toBe(2);
      expect(slotForUserInState(state, 'nobody')).toBeNull();
    });

    it('isActivePlayer / isPendingPlayer distinguish the two', () => {
      expect(isActivePlayer(state, 'alice')).toBe(true);
      expect(isActivePlayer(state, 'bob')).toBe(false);
      expect(isPendingPlayer(state, 'bob')).toBe(true);
      expect(isPendingPlayer(state, 'alice')).toBe(false);
    });
  });

  describe('assignSlots (game-in-progress routing)', () => {
    const empty = { active: {}, pending: {} };

    it('routes new requesters to ACTIVE when no game is in progress', () => {
      const { state, assigned, changed } = assignSlots(empty, ['alice', 'bob'], false);
      expect(changed).toBe(true);
      expect(state.active).toEqual({ '0': 'alice', '1': 'bob' });
      expect(state.pending).toEqual({});
      expect(assigned).toEqual({
        alice: { slot: 0, pending: false },
        bob: { slot: 1, pending: false },
      });
    });

    it('routes a late joiner to PENDING when a game IS in progress', () => {
      // alice is the active player mid-level; bob joins late → pending.
      const start = { active: { '0': 'alice' }, pending: {} };
      const { state, assigned } = assignSlots(start, ['alice', 'bob'], true);
      expect(state.active).toEqual({ '0': 'alice' }); // unchanged
      expect(state.pending).toEqual({ '1': 'bob' }); // reserved, not live
      expect(assigned.bob).toEqual({ slot: 1, pending: true });
      // alice stays active.
      expect(assigned.alice).toEqual({ slot: 0, pending: false });
    });

    it('pending + active share one slot space (no double-claim)', () => {
      // bob pending at slot 1; a NEW active requester must NOT also get slot 1.
      const start = { active: { '0': 'alice' }, pending: { '1': 'bob' } };
      // Game ended (gameInProgress=false): carol joins → next free slot is 2,
      // NOT 1 (bob's pending reservation is respected).
      const { state } = assignSlots(start, ['carol'], false);
      expect(state.active).toEqual({ '0': 'alice', '2': 'carol' });
      expect(state.pending).toEqual({ '1': 'bob' });
    });

    it('caps the COMBINED size at MAX_DOOM_PLAYERS', () => {
      const start = { active: { '0': 'a', '1': 'b' }, pending: { '2': 'c' } };
      const { state, rejected } = assignSlots(start, ['d', 'e'], true);
      // Only slot 3 free → d (lex-first) pending; e rejected.
      expect(state.pending).toEqual({ '2': 'c', '3': 'd' });
      expect(rejected).toEqual(['e']);
      expect(rosterSize(combinedRoster(state))).toBe(MAX_DOOM_PLAYERS);
    });

    it('is idempotent for already-seated users (active or pending)', () => {
      const start = { active: { '0': 'alice' }, pending: { '1': 'bob' } };
      const { changed } = assignSlots(start, ['alice', 'bob'], true);
      expect(changed).toBe(false);
    });

    it('does not mutate the input state', () => {
      const start = { active: { '0': 'alice' }, pending: {} };
      assignSlots(start, ['bob'], true);
      expect(start).toEqual({ active: { '0': 'alice' }, pending: {} });
    });

    it('seats the rack OWNER as active player 0 even with a lex-smaller guest', () => {
      // owner sorts lex-LARGE; guest lex-small. No game in progress → both go
      // active, owner first (slot 0). This is the host-MP-start path.
      const empty2 = { active: {}, pending: {} };
      const { state, assigned } = assignSlots(
        empty2,
        ['aaa-guest', 'zzz-owner'],
        false,
        ['zzz-owner'],
      );
      expect(state.active).toEqual({ '0': 'zzz-owner', '1': 'aaa-guest' });
      expect(assigned['zzz-owner']).toEqual({ slot: 0, pending: false });
      expect(assigned['aaa-guest']).toEqual({ slot: 1, pending: false });
    });
  });

  describe('promotePending (next-map seating)', () => {
    it('promotes every pending slot to active at the SAME index', () => {
      const start = { active: { '0': 'alice' }, pending: { '1': 'bob', '2': 'carol' } };
      const { state, changed, promoted } = promotePending(start);
      expect(changed).toBe(true);
      expect(state.active).toEqual({ '0': 'alice', '1': 'bob', '2': 'carol' });
      expect(state.pending).toEqual({});
      expect(promoted.sort()).toEqual(['bob', 'carol']);
    });

    it('is a no-op (same reference) when there is nothing pending', () => {
      const start = { active: { '0': 'alice' }, pending: {} };
      const { state, changed, promoted } = promotePending(start);
      expect(changed).toBe(false);
      expect(state).toBe(start);
      expect(promoted).toEqual([]);
    });

    it('never evicts a live active player on an (impossible) slot collision', () => {
      // Defensive: a pending entry whose slot already holds a DIFFERENT active
      // user is dropped, not promoted over the active occupant.
      const start = { active: { '1': 'alice' }, pending: { '1': 'bob' } };
      const { state, promoted } = promotePending(start);
      expect(state.active['1']).toBe('alice'); // alice kept
      expect(promoted).toEqual([]); // bob NOT promoted over her
    });

    it('does not mutate the input state', () => {
      const start = { active: {}, pending: { '0': 'bob' } };
      promotePending(start);
      expect(start).toEqual({ active: {}, pending: { '0': 'bob' } });
    });
  });

  describe('pruneRosterState (disconnect cleanup across both maps)', () => {
    it('drops disconnected users from active AND pending', () => {
      const start = { active: { '0': 'alice', '1': 'bob' }, pending: { '2': 'carol' } };
      const { state, changed } = pruneRosterState(start, ['alice']);
      expect(changed).toBe(true);
      expect(state.active).toEqual({ '0': 'alice' });
      expect(state.pending).toEqual({});
    });

    it('is a no-op (same reference) when everyone is live', () => {
      const start = { active: { '0': 'alice' }, pending: { '1': 'bob' } };
      const { state, changed } = pruneRosterState(start, ['alice', 'bob', 'late']);
      expect(changed).toBe(false);
      expect(state).toBe(start);
    });

    it('a late joiner who leaves before the next map vacates only pending', () => {
      const start = { active: { '0': 'alice' }, pending: { '1': 'bob' } };
      const { state } = pruneRosterState(start, ['alice']);
      expect(state.active).toEqual({ '0': 'alice' });
      expect(state.pending).toEqual({});
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  //  applyRosterMap — the per-slot-CRDT write seam (the soak fix)
  // ────────────────────────────────────────────────────────────────────────
  //
  //  These exercise the REAL Yjs merge, not the pure helpers: two synced docs
  //  each apply a roster to node.data via applyRosterMap, exchange updates, and
  //  we assert both slots survive the CRDT merge. This is the regression guard
  //  for the 4-bot soak bug (the highest slot getting clobbered). We use plain
  //  SyncedStore docs (no Svelte / WASM / DOM) so it runs in the unit suite.
  describe('applyRosterMap: per-slot CRDT merge (soak regression)', () => {
    type Store = { nodes: Record<string, { data?: Record<string, unknown> }> };
    const makeDoc = () => {
      const store = syncedStore<Store>({ nodes: {} });
      const doc = getYjsDoc(store);
      return { store, doc };
    };
    type Peer = ReturnType<typeof makeDoc>;
    const sync = (a: Y.Doc, b: Y.Doc) => {
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    };
    /** Create the shared DOOM node on ONE doc (the host), the way the real app
     *  does — the host spawns the node, then peers receive it via sync. Both
     *  docs then share the SAME nested `data` Y.Map, so per-key roster writes
     *  on either side merge. (Creating the node independently on both docs
     *  would make two divergent `data` Y.Maps that collapse to one on merge —
     *  that is a node-creation race, not the roster bug under test.) */
    const seedSharedNode = (host: Peer, peers: Peer[]) => {
      host.store.nodes['doom'] = { data: {} };
      for (const p of peers) sync(host.doc, p.doc);
    };

    it('writes a roster as a nested per-key map (not a string leaf)', () => {
      const host = makeDoc();
      seedSharedNode(host, []);
      const { store, doc } = host;
      doc.transact(() => {
        applyRosterMap(store.nodes['doom']!.data!, 'players', {
          '0': 'alice',
          '1': 'bob',
        });
      });
      const players = store.nodes['doom']!.data!.players;
      // Nested object/map, NOT a JSON string leaf.
      expect(typeof players).toBe('object');
      expect(readRoster(store.nodes['doom']!.data)).toEqual({ '0': 'alice', '1': 'bob' });
    });

    it('CONCURRENT claims of different slots both survive the merge', () => {
      // Two synced docs that share an empty roster, then EACH claims a
      // different slot offline and they reconcile — the slice-3 string-leaf
      // bug would have one whole-object write clobber the other; per-key Y.Map
      // writes merge cleanly.
      const A = makeDoc();
      const B = makeDoc();
      // Host (A) spawns the shared node; B receives it via sync. Now both share
      // the SAME nested data Y.Map.
      seedSharedNode(A, [B]);
      // Establish the `players` nested Y.Map ONCE (migration write) and sync it
      // so both peers reference the SAME map — the per-key writes below are then
      // genuine per-key Y.Map ops that CRDT-merge. (Only the arbiter migrates in
      // the real app; this just sets up the shared map for the merge assertion.)
      A.doc.transact(() => {
        applyRosterMap(A.store.nodes['doom']!.data!, 'players', {});
      });
      sync(A.doc, B.doc);

      // CONCURRENT per-key claims of DIFFERENT slots on the shared players map.
      A.doc.transact(() => {
        applyRosterMap(A.store.nodes['doom']!.data!, 'players', { '0': 'alice' });
      });
      B.doc.transact(() => {
        applyRosterMap(B.store.nodes['doom']!.data!, 'players', { '3': 'dave' });
      });

      sync(A.doc, B.doc);

      // BOTH slots present on BOTH peers after the merge — the highest slot
      // (3, the one the soak lost) is not clobbered. With the old single
      // string-leaf this was last-writer-wins and one slot vanished.
      expect(readRoster(A.store.nodes['doom']!.data)).toEqual({ '0': 'alice', '3': 'dave' });
      expect(readRoster(B.store.nodes['doom']!.data)).toEqual({ '0': 'alice', '3': 'dave' });
    });

    it('a 4-way arbiter seating sequence converges with all four slots', () => {
      // Simulate the arbiter seating four players in rapid successive writes
      // (the soak bring-up), each write reconciling the full desired roster.
      // The 4th (slot 3) must survive on a freshly-synced late peer.
      const arb = makeDoc();
      const late = makeDoc();
      // Arbiter spawns the shared node; the late peer syncs it first (it joins
      // after the node exists, like a guest in the soak).
      seedSharedNode(arb, [late]);
      const desired: Record<string, string> = {};
      for (let i = 0; i < MAX_DOOM_PLAYERS; i++) {
        desired[String(i)] = `bot${i}`;
        arb.doc.transact(() => {
          applyRosterMap(arb.store.nodes['doom']!.data!, 'players', { ...desired });
        });
      }
      sync(arb.doc, late.doc);
      expect(readRoster(late.store.nodes['doom']!.data)).toEqual({
        '0': 'bot0',
        '1': 'bot1',
        '2': 'bot2',
        '3': 'bot3',
      });
    });

    it('migrates a legacy string-leaf roster to a nested map on first write', () => {
      const host = makeDoc();
      seedSharedNode(host, []);
      const { store, doc } = host;
      // Seed the legacy primitive-string-leaf shape (older snapshots).
      doc.transact(() => {
        store.nodes['doom']!.data!.players = serializeRoster({ '0': 'alice' });
      });
      expect(typeof store.nodes['doom']!.data!.players).toBe('string');
      // readRoster decodes the legacy string form (back-compat).
      expect(readRoster(store.nodes['doom']!.data)).toEqual({ '0': 'alice' });
      // First write migrates it to a nested map, preserving the existing slot
      // and adding the new one per-key.
      doc.transact(() => {
        applyRosterMap(store.nodes['doom']!.data!, 'players', { '0': 'alice', '1': 'bob' });
      });
      expect(typeof store.nodes['doom']!.data!.players).toBe('object');
      expect(readRoster(store.nodes['doom']!.data)).toEqual({ '0': 'alice', '1': 'bob' });
    });

    it('releasing a slot deletes only that key (per-key delete)', () => {
      const host = makeDoc();
      seedSharedNode(host, []);
      const { store, doc } = host;
      doc.transact(() => {
        applyRosterMap(store.nodes['doom']!.data!, 'players', {
          '0': 'alice',
          '1': 'bob',
          '2': 'carol',
        });
      });
      doc.transact(() => {
        applyRosterMap(store.nodes['doom']!.data!, 'players', { '0': 'alice', '2': 'carol' });
      });
      expect(readRoster(store.nodes['doom']!.data)).toEqual({ '0': 'alice', '2': 'carol' });
    });
  });
});
