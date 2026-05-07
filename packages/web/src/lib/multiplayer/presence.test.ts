// Unit tests for presence resolution (Stage B PR B-c).
// Pure functions — no DOM, no provider, no Yjs. Validates that the
// userId → (color, displayName) mapping is deterministic so the same user
// always renders the same hue across sessions and across collaborators.

import { describe, it, expect } from 'vitest';
import {
  colorForUserId,
  anonGuestName,
  resolvePresenceUser,
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
  });
});
