// Unit tests for presence resolution (Stage B PR B-c).
// Pure functions — no DOM, no provider, no Yjs. Validates that the
// userId → (color, displayName) mapping is deterministic so the same user
// always renders the same hue across sessions and across collaborators.

import { describe, it, expect } from 'vitest';
import {
  colorForUserId,
  anonGuestName,
  resolvePresenceUser,
  distinctPresentUsers,
  countDistinctPresentUsers,
  type RemotePresence,
  type PresenceUser,
} from './presence';

function presence(clientId: number, user: Partial<PresenceUser> & { id: string }): RemotePresence {
  return {
    clientId,
    user: {
      displayName: user.displayName ?? user.id,
      color: user.color ?? colorForUserId(user.id),
      ...user,
    },
  };
}

describe('presence', () => {
  describe('colorForUserId', () => {
    it('is deterministic for the same userId', () => {
      const a = colorForUserId('user_2abc');
      const b = colorForUserId('user_2abc');
      expect(a).toBe(b);
    });

    it('returns a hex color from the palette', () => {
      const c = colorForUserId('user_2abc');
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('produces varied colors across distinct userIds (not always the same one)', () => {
      const colors = new Set<string>();
      for (let i = 0; i < 50; i++) {
        colors.add(colorForUserId(`user_${i}`));
      }
      expect(colors.size).toBeGreaterThan(3);
    });
  });

  describe('anonGuestName', () => {
    it('produces a "guest NNNN" name', () => {
      expect(anonGuestName('anon-abc')).toMatch(/^guest \d{4}$/);
    });

    it('is deterministic for the same id', () => {
      expect(anonGuestName('anon-stable')).toBe(anonGuestName('anon-stable'));
    });
  });

  describe('resolvePresenceUser', () => {
    it('uses the trimmed displayName for authed users', () => {
      const u = resolvePresenceUser({
        userId: 'user_2abc',
        displayName: '  Alice  ',
        isAnon: false,
      });
      expect(u.id).toBe('user_2abc');
      expect(u.displayName).toBe('Alice');
      expect(u.color).toBe(colorForUserId('user_2abc'));
    });

    it('falls back to a userId prefix when displayName is missing', () => {
      const u = resolvePresenceUser({
        userId: 'user_abcdef1234',
        displayName: null,
        isAnon: false,
      });
      expect(u.displayName).toBe('user_abc');
    });

    it('returns a guest name + deterministic color for anon users', () => {
      const u = resolvePresenceUser({
        userId: 'anon-tab-xyz',
        isAnon: true,
      });
      expect(u.id).toBe('anon-tab-xyz');
      expect(u.displayName).toMatch(/^guest \d{4}$/);
      expect(u.color).toBe(colorForUserId('anon-tab-xyz'));
    });

    it('generates a synthetic anon id when userId is null', () => {
      const u = resolvePresenceUser({ userId: null, isAnon: true });
      expect(u.id.startsWith('anon-')).toBe(true);
      expect(u.displayName).toMatch(/^guest \d{4}$/);
    });

    it('two distinct authed users get distinct colors most of the time', () => {
      const a = resolvePresenceUser({ userId: 'user_1', displayName: 'A', isAnon: false });
      const b = resolvePresenceUser({ userId: 'user_999_xyz', displayName: 'B', isAnon: false });
      // We don't strictly require uniqueness (palette is finite), but for
      // these specific seeds we expect different hues.
      expect(a.color).not.toBe(b.color);
    });

    it('publishes isRackOwner for the rack owner', () => {
      const owner = resolvePresenceUser({
        userId: 'user_owner',
        displayName: 'Owner',
        isAnon: false,
        isRackOwner: true,
      });
      expect(owner.isRackOwner).toBe(true);
    });

    it('defaults isRackOwner to false for authed non-owners', () => {
      const guest = resolvePresenceUser({ userId: 'user_guest', displayName: 'G', isAnon: false });
      expect(guest.isRackOwner).toBe(false);
    });

    it('never marks an anon member as the rack owner', () => {
      // Anon members can never own a rack; even a stray isRackOwner input is
      // dropped on the anon branch.
      const anon = resolvePresenceUser({ userId: 'anon-x', isAnon: true, isRackOwner: true });
      expect(anon.isRackOwner).toBeUndefined();
    });
  });

  // The "1/4 members, 2 dots" bug: the count and the dots are now derived from
  // ONE de-duped-by-user.id list, so count === number of dots, always.
  describe('distinctPresentUsers / countDistinctPresentUsers (count === dots)', () => {
    it('reproduces the reported case: 2 distinct present users → count 2, not 1', () => {
      // Owner (authed) + an anon-via-invite guest both present. Previously the
      // DB memberCount said "1" (anon not in memberUserIds) while two dots
      // rendered. Now both come from the same list.
      const presences: RemotePresence[] = [
        presence(1, { id: 'user_owner', displayName: 'Owner', isRackOwner: true }),
        presence(2, { id: 'anon-tab-abc' }),
      ];
      const dots = distinctPresentUsers(presences);
      expect(dots).toHaveLength(2);
      expect(countDistinctPresentUsers(presences)).toBe(2);
      // The count the UI shows is exactly the number of dots it renders.
      expect(countDistinctPresentUsers(presences)).toBe(dots.length);
    });

    it('de-dups a single user with two tabs (does NOT double-count)', () => {
      const presences: RemotePresence[] = [
        presence(1, { id: 'user_alice', displayName: 'Alice' }),
        presence(2, { id: 'user_alice', displayName: 'Alice' }), // second tab
      ];
      const dots = distinctPresentUsers(presences);
      expect(dots).toHaveLength(1);
      expect(dots[0].id).toBe('user_alice');
      expect(countDistinctPresentUsers(presences)).toBe(1);
      expect(countDistinctPresentUsers(presences)).toBe(dots.length);
    });

    it('keeps first-seen presence when a user has multiple tabs', () => {
      const presences: RemotePresence[] = [
        presence(1, { id: 'user_bob', displayName: 'Bob (tab 1)', color: '#111111' }),
        presence(2, { id: 'user_bob', displayName: 'Bob (tab 2)', color: '#222222' }),
      ];
      const [only] = distinctPresentUsers(presences);
      expect(only.displayName).toBe('Bob (tab 1)');
      expect(only.color).toBe('#111111');
    });

    it('counts an anon guest as a present user', () => {
      const presences: RemotePresence[] = [presence(7, { id: 'anon-tab-xyz' })];
      expect(countDistinctPresentUsers(presences)).toBe(1);
      expect(distinctPresentUsers(presences)).toHaveLength(1);
    });

    it('mixed: 2 authed (one with 2 tabs) + 1 anon → 3 distinct, count === dots', () => {
      const presences: RemotePresence[] = [
        presence(1, { id: 'user_a', displayName: 'A' }),
        presence(2, { id: 'user_b', displayName: 'B' }),
        presence(3, { id: 'user_a', displayName: 'A' }), // A's second tab
        presence(4, { id: 'anon-guest-1' }),
      ];
      const dots = distinctPresentUsers(presences);
      expect(dots.map((u) => u.id)).toEqual(['user_a', 'user_b', 'anon-guest-1']);
      expect(countDistinctPresentUsers(presences)).toBe(3);
      expect(countDistinctPresentUsers(presences)).toBe(dots.length);
    });

    it('caps the count at the rackspace member cap but never changes dot identity', () => {
      const presences: RemotePresence[] = [
        presence(1, { id: 'u1' }),
        presence(2, { id: 'u2' }),
        presence(3, { id: 'u3' }),
        presence(4, { id: 'u4' }),
        presence(5, { id: 'u5' }), // racey 5th tab beyond the 4-cap
      ];
      expect(countDistinctPresentUsers(presences, 4)).toBe(4);
      // The de-duped dot list itself is uncapped (so identity isn't lost);
      // only the displayed count is clamped to "/4".
      expect(distinctPresentUsers(presences)).toHaveLength(5);
    });

    it('handles empty + malformed presence rows', () => {
      expect(countDistinctPresentUsers([])).toBe(0);
      expect(distinctPresentUsers([])).toEqual([]);
      const bad = [
        { clientId: 1 } as unknown as RemotePresence,
        { clientId: 2, user: { id: '', displayName: 'x', color: '#000' } } as RemotePresence,
        presence(3, { id: 'real' }),
      ];
      expect(countDistinctPresentUsers(bad)).toBe(1);
    });
  });
});
