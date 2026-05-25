// packages/web/src/lib/doom/doom-player-identity.test.ts
//
// Slice 5: pin the slot→color + slot→label mappings (the visual identity the
// DoomCard renders). Pure functions, no DOM / Yjs.

import { describe, it, expect } from 'vitest';
import {
  DOOM_SLOT_COLORS,
  slotColor,
  slotColorCss,
  slotLabel,
  slotBadge,
  spectatorBadge,
  spectatorLabel,
  type DoomViewerStatus,
} from './doom-player-identity';

describe('DOOM player slot colors (vanilla MT_PLAYER order)', () => {
  it('maps the four slots to green / indigo / brown / red in order', () => {
    expect(DOOM_SLOT_COLORS.map((c) => c.name)).toEqual([
      'Green',
      'Indigo',
      'Brown',
      'Red',
    ]);
  });

  it('slotColor returns the per-slot descriptor', () => {
    expect(slotColor(0).name).toBe('Green');
    expect(slotColor(1).name).toBe('Indigo');
    expect(slotColor(2).name).toBe('Brown');
    expect(slotColor(3).name).toBe('Red');
  });

  it('every slot color is a distinct CSS string', () => {
    const css = DOOM_SLOT_COLORS.map((c) => c.color);
    expect(new Set(css).size).toBe(css.length);
  });

  it('slotColorCss returns the bare color string', () => {
    expect(slotColorCss(3)).toBe('#c2342b');
  });

  it('falls back to slot-0 green for null / out-of-range / non-integer', () => {
    expect(slotColor(null).name).toBe('Green');
    expect(slotColor(-1).name).toBe('Green');
    expect(slotColor(4).name).toBe('Green');
    expect(slotColor(1.5).name).toBe('Green');
  });
});

describe('slotLabel', () => {
  it('formats "Player N — username" with 1-based slot numbering', () => {
    expect(slotLabel(0, 'alice', false)).toBe('Player 1 — alice');
    expect(slotLabel(2, 'carol', false)).toBe('Player 3 — carol');
  });

  it('appends "(you)" for the local peer', () => {
    expect(slotLabel(0, 'alice', true)).toBe('Player 1 — alice (you)');
  });

  it('omits the username when absent / blank', () => {
    expect(slotLabel(1, null, false)).toBe('Player 2');
    expect(slotLabel(1, undefined, false)).toBe('Player 2');
    expect(slotLabel(1, '   ', false)).toBe('Player 2');
    expect(slotLabel(1, null, true)).toBe('Player 2 (you)');
  });

  it('returns empty string for a spectator (null slot)', () => {
    expect(slotLabel(null, 'alice', false)).toBe('');
    expect(slotLabel(-1, 'alice', false)).toBe('');
  });

  it('trims surrounding whitespace from the username', () => {
    expect(slotLabel(0, '  bob  ', false)).toBe('Player 1 — bob');
  });
});

describe('slotBadge', () => {
  it('returns P1..P4 for slots 0..3', () => {
    expect(slotBadge(0)).toBe('P1');
    expect(slotBadge(3)).toBe('P4');
  });

  it('returns empty for a spectator', () => {
    expect(slotBadge(null)).toBe('');
    expect(slotBadge(-1)).toBe('');
  });
});

describe('slice 6: spectator / pending label states', () => {
  const SPECTATOR: DoomViewerStatus = 'spectator';
  const PENDING: DoomViewerStatus = 'pending';
  const PLAYER: DoomViewerStatus = 'player';

  describe('spectatorLabel', () => {
    it('plain "Spectating" for an unjoined spectator', () => {
      expect(spectatorLabel(SPECTATOR, null)).toBe('Spectating');
      // A spectator never has a slot, but a stray slot is ignored.
      expect(spectatorLabel(SPECTATOR, 2)).toBe('Spectating');
    });

    it('announces the reserved next-map slot for a pending late joiner', () => {
      expect(spectatorLabel(PENDING, 1)).toBe(
        'Spectating — joining as Player 2 next map',
      );
      expect(spectatorLabel(PENDING, 3)).toBe(
        'Spectating — joining as Player 4 next map',
      );
    });

    it('falls back to plain "Spectating" if pending has no valid slot', () => {
      expect(spectatorLabel(PENDING, null)).toBe('Spectating');
      expect(spectatorLabel(PENDING, -1)).toBe('Spectating');
    });

    it('returns empty for an active player (uses slotLabel instead)', () => {
      expect(spectatorLabel(PLAYER, 0)).toBe('');
    });
  });

  describe('spectatorBadge', () => {
    it('SPEC for a plain spectator', () => {
      expect(spectatorBadge(SPECTATOR, null)).toBe('SPEC');
    });

    it('shows the parenthesized future slot for a pending joiner', () => {
      expect(spectatorBadge(PENDING, 1)).toBe('P2?');
      expect(spectatorBadge(PENDING, 3)).toBe('P4?');
    });

    it('pending with no valid slot falls back to SPEC', () => {
      expect(spectatorBadge(PENDING, null)).toBe('SPEC');
    });

    it('empty for an active player', () => {
      expect(spectatorBadge(PLAYER, 0)).toBe('');
    });
  });
});
