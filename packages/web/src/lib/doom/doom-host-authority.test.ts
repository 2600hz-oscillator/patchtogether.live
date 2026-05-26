// packages/web/src/lib/doom/doom-host-authority.test.ts
//
// Unit coverage for the deterministic, split-brain-proof host authority.
// The headline invariants (never-two-hosts, guest-never-seats-itself,
// wait-under-empty-awareness, anon-fallback) are asserted directly here so a
// regression can't reach the e2e layer.

import { describe, it, expect } from 'vitest';
import { decideHostRole, type HostDecisionInput } from './doom-host-authority';

function input(over: Partial<HostDecisionInput>): HostDecisionInput {
  return {
    localUserId: 'me',
    localIsOwner: null,
    currentHost: null,
    members: ['me'],
    ownerIds: [],
    ...over,
  };
}

describe('decideHostRole — confirmed owner', () => {
  it('a confirmed owner is host unconditionally, even seeing only itself', () => {
    const d = decideHostRole(
      input({ localUserId: 'owner', localIsOwner: true, members: ['owner'] }),
    );
    expect(d.role).toBe('host');
    expect(d.hostUserId).toBe('owner');
  });

  it('a confirmed owner is host regardless of where its id sorts', () => {
    // owner sorts lex-LARGE; a guest sorts lex-small but is also present.
    const d = decideHostRole(
      input({
        localUserId: 'zzz-owner',
        localIsOwner: true,
        members: ['aaa-guest', 'zzz-owner'],
        ownerIds: ['zzz-owner'],
      }),
    );
    expect(d.role).toBe('host');
    expect(d.hostUserId).toBe('zzz-owner');
  });

  it('a confirmed owner is host even if awareness has not arrived (empty member view)', () => {
    const d = decideHostRole(
      input({ localUserId: 'owner', localIsOwner: true, members: [] }),
    );
    expect(d.role).toBe('host');
    expect(d.hostUserId).toBe('owner');
  });
});

describe('decideHostRole — confirmed guest NEVER seats itself (the split-brain fix)', () => {
  it('a confirmed guest is a guest even when it sees ONLY itself (empty awareness)', () => {
    // THIS is the live bug: a guest whose awareness shows only itself must
    // NOT elect itself host. Pre-fix lex-min over [me] picked itself → split.
    const d = decideHostRole(
      input({ localUserId: 'guest', localIsOwner: false, members: ['guest'], ownerIds: [] }),
    );
    expect(d.role).toBe('guest');
    expect(d.hostUserId).toBeNull(); // can't name the owner yet, but still a guest
  });

  it('a confirmed guest stays a guest even if its id sorts lex-smallest', () => {
    const d = decideHostRole(
      input({
        localUserId: 'aaa-guest',
        localIsOwner: false,
        members: ['aaa-guest', 'zzz-owner'],
        ownerIds: ['zzz-owner'],
      }),
    );
    expect(d.role).toBe('guest');
    expect(d.hostUserId).toBe('zzz-owner'); // names the owner once visible
  });

  it('a confirmed guest names the owner once exactly one owner is visible', () => {
    const d = decideHostRole(
      input({
        localUserId: 'g',
        localIsOwner: false,
        members: ['g', 'o'],
        ownerIds: ['o'],
      }),
    );
    expect(d.role).toBe('guest');
    expect(d.hostUserId).toBe('o');
  });

  it('a confirmed guest stays a guest even if NO owner is visible yet', () => {
    const d = decideHostRole(
      input({ localUserId: 'g', localIsOwner: false, members: ['g', 'other'], ownerIds: [] }),
    );
    expect(d.role).toBe('guest');
    expect(d.hostUserId).toBeNull();
  });
});

describe('decideHostRole — never two hosts (cross-peer consistency)', () => {
  it('owner sees host, guest sees guest — in the SAME 2-user rack, both partial views', () => {
    // Owner's perspective: it only sees itself so far.
    const ownerView = decideHostRole(
      input({ localUserId: 'owner', localIsOwner: true, members: ['owner'] }),
    );
    // Guest's perspective: it only sees itself so far.
    const guestView = decideHostRole(
      input({ localUserId: 'guest', localIsOwner: false, members: ['guest'] }),
    );
    // Exactly one host across the two peers — the split-brain is impossible.
    expect(ownerView.role).toBe('host');
    expect(guestView.role).toBe('guest');
    const hosts = [ownerView, guestView].filter((d) => d.role === 'host');
    expect(hosts).toHaveLength(1);
  });

  it('guest loading FIRST (owner not yet connected) still does not seat itself', () => {
    // The "guest loads first / awareness arrives late" scenario.
    const guestFirst = decideHostRole(
      input({ localUserId: 'guest', localIsOwner: false, members: ['guest'], ownerIds: [] }),
    );
    expect(guestFirst.role).toBe('guest');
  });
});

describe('decideHostRole — anon rack fallback (no owner concept)', () => {
  it('unknown ownership falls back to lex-min election', () => {
    const d = decideHostRole(
      input({ localUserId: 'bbb', localIsOwner: null, members: ['aaa', 'bbb'], ownerIds: [] }),
    );
    // lex-min is 'aaa' → this peer ('bbb') is a guest.
    expect(d.role).toBe('guest');
    expect(d.hostUserId).toBe('aaa');
  });

  it('unknown ownership: the lex-min peer is the host', () => {
    const d = decideHostRole(
      input({ localUserId: 'aaa', localIsOwner: null, members: ['aaa', 'bbb'], ownerIds: [] }),
    );
    expect(d.role).toBe('host');
    expect(d.hostUserId).toBe('aaa');
  });

  it('anon fallback is symmetric across peers → exactly one host', () => {
    const a = decideHostRole(
      input({ localUserId: 'aaa', localIsOwner: null, members: ['aaa', 'bbb', 'ccc'] }),
    );
    const b = decideHostRole(
      input({ localUserId: 'bbb', localIsOwner: null, members: ['bbb', 'aaa', 'ccc'] }),
    );
    const c = decideHostRole(
      input({ localUserId: 'ccc', localIsOwner: null, members: ['ccc', 'ccc', 'aaa', 'bbb'] }),
    );
    const hosts = [a, b, c].filter((d) => d.role === 'host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.hostUserId).toBe('aaa');
  });

  it('anon fallback keeps a still-live current host (no churn)', () => {
    const d = decideHostRole(
      input({
        localUserId: 'mmm',
        localIsOwner: null,
        currentHost: 'mmm',
        members: ['aaa', 'mmm'],
        ownerIds: [],
      }),
    );
    expect(d.role).toBe('host'); // sticky — no needless migration
  });

  it('anon fallback prefers a visible owner even when ownership is locally unknown', () => {
    // A rare mixed case: this peer can't confirm its own ownership (null) but
    // sees an owner flag in awareness → defer to that owner deterministically.
    const d = decideHostRole(
      input({
        localUserId: 'aaa',
        localIsOwner: null,
        members: ['aaa', 'zzz-owner'],
        ownerIds: ['zzz-owner'],
      }),
    );
    expect(d.role).toBe('guest');
    expect(d.hostUserId).toBe('zzz-owner');
  });
});
