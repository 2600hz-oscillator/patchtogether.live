// Unit tests for presence resolution (Stage B PR B-c).
// Pure functions — no DOM, no provider, no Yjs. Validates that the
// userId → (color, displayName) mapping is deterministic so the same user
// always renders the same hue across sessions and across collaborators.

import { describe, it, expect } from 'vitest';
import {
  colorForUserId,
  anonGuestName,
  resolvePresenceUser,
  countDistinctPresentUsers,
} from './presence';

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

  describe('countDistinctPresentUsers', () => {
    // This is the helper behind the live "N/4 members" count. It MUST count
    // distinct humans (by user.id), not distinct awareness clientIds (tabs),
    // so the cap is a per-human cap and a second tab doesn't burn a slot.
    it('counts one per distinct user.id', () => {
      const presences = [
        { user: { id: 'user_a' } },
        { user: { id: 'user_b' } },
      ];
      expect(countDistinctPresentUsers(presences)).toBe(2);
    });

    it('de-dups multiple tabs of the same user.id to one (NOT per clientId)', () => {
      // Two tabs for user_a (each a distinct awareness clientId / dot) + one
      // for user_b → 3 dots but only 2 members.
      const presences = [
        { user: { id: 'user_a' } },
        { user: { id: 'user_a' } },
        { user: { id: 'user_b' } },
      ];
      expect(countDistinctPresentUsers(presences)).toBe(2);
    });

    it('returns 0 for an empty list', () => {
      expect(countDistinctPresentUsers([])).toBe(0);
    });

    it('ignores entries with no user or no id', () => {
      const presences = [
        { user: { id: 'user_a' } },
        { user: undefined },
        { user: { id: '' } },
        {},
      ];
      expect(countDistinctPresentUsers(presences)).toBe(1);
    });

    it('matches the dot count in the common single-tab case', () => {
      // One tab per user → distinct-user count equals the number of dots.
      const presences = [
        { user: { id: 'user_a' } },
        { user: { id: 'user_b' } },
        { user: { id: 'anon-xyz' } },
      ];
      const dotCount = presences.length;
      expect(countDistinctPresentUsers(presences)).toBe(dotCount);
    });
  });
});
