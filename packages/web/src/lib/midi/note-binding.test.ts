// packages/web/src/lib/midi/note-binding.test.ts
//
// Unit tests for the PURE note-message parsing + binding guards.

import { describe, it, expect } from 'vitest';
import {
  parseNoteMessage,
  noteMatches,
  isCcBinding,
  isNoteBinding,
  bindingAddress,
  dedupeBindingsByAddress,
  type MidiBinding,
  type MidiCcBinding,
  type MidiNoteBinding,
} from './note-binding';

describe('parseNoteMessage', () => {
  it('parses a note-on (0x9n, velocity > 0) as kind=on', () => {
    const p = parseNoteMessage(new Uint8Array([0x90, 60, 100]));
    expect(p).toEqual({ channel: 0, note: 60, velocity: 100, kind: 'on' });
  });

  it('parses a note-off (0x8n) as kind=off', () => {
    const p = parseNoteMessage(new Uint8Array([0x82, 60, 0]));
    expect(p).toEqual({ channel: 2, note: 60, velocity: 0, kind: 'off' });
  });

  it('treats a note-on with velocity 0 as a note-off (running-status convention)', () => {
    const p = parseNoteMessage(new Uint8Array([0x91, 64, 0]));
    expect(p).toEqual({ channel: 1, note: 64, velocity: 0, kind: 'off' });
  });

  it('captures the channel nibble', () => {
    const p = parseNoteMessage(new Uint8Array([0x9f, 36, 127]));
    expect(p?.channel).toBe(15);
    expect(p?.kind).toBe('on');
  });

  it('returns null for a CC message (0xBn)', () => {
    expect(parseNoteMessage(new Uint8Array([0xb0, 7, 100]))).toBeNull();
  });

  it('returns null for a short message', () => {
    expect(parseNoteMessage(new Uint8Array([0x90, 60]))).toBeNull();
  });

  it('masks the data bytes to 7 bits', () => {
    const p = parseNoteMessage([0x90, 0xff, 0xff]);
    expect(p?.note).toBe(127);
    expect(p?.velocity).toBe(127);
  });
});

describe('noteMatches', () => {
  const binding: MidiNoteBinding = { kind: 'note', key: 'm:p', channel: 3, note: 48, learnedAt: 0 };

  it('matches same channel + note', () => {
    expect(noteMatches(binding, { channel: 3, note: 48, velocity: 1, kind: 'on' })).toBe(true);
  });

  it('ignores a different channel', () => {
    expect(noteMatches(binding, { channel: 2, note: 48, velocity: 1, kind: 'on' })).toBe(false);
  });

  it('ignores a different note', () => {
    expect(noteMatches(binding, { channel: 3, note: 49, velocity: 1, kind: 'on' })).toBe(false);
  });

  it('matches regardless of on/off kind (release uses the same binding)', () => {
    expect(noteMatches(binding, { channel: 3, note: 48, velocity: 0, kind: 'off' })).toBe(true);
  });
});

describe('binding guards', () => {
  const cc: MidiCcBinding = { kind: 'cc', key: 'm:p', channel: 0, cc: 7, learnedAt: 0 };
  const note: MidiNoteBinding = { kind: 'note', key: 'm:g', channel: 0, note: 60, learnedAt: 0 };

  it('isCcBinding is true for a cc binding', () => {
    expect(isCcBinding(cc)).toBe(true);
    expect(isNoteBinding(cc)).toBe(false);
  });

  it('isNoteBinding is true for a note binding', () => {
    expect(isNoteBinding(note)).toBe(true);
    expect(isCcBinding(note)).toBe(false);
  });

  it('treats a legacy record with no kind as cc', () => {
    const legacy = { key: 'm:p', channel: 0, cc: 7, learnedAt: 0 };
    expect(isCcBinding(legacy)).toBe(true);
    expect(isNoteBinding(legacy)).toBe(false);
  });
});

describe('bindingAddress', () => {
  it('a CC binding addresses cc:<channel>:<cc>', () => {
    expect(bindingAddress({ kind: 'cc', key: 'a:b', channel: 0, cc: 7, learnedAt: 0 })).toBe('cc:0:7');
    expect(bindingAddress({ kind: 'cc', key: 'a:b', channel: 5, cc: 11, learnedAt: 0 })).toBe('cc:5:11');
  });
  it('a NOTE binding addresses note:<channel>:<note>', () => {
    expect(bindingAddress({ kind: 'note', key: 'a:g', channel: 3, note: 60, learnedAt: 0 })).toBe('note:3:60');
  });
  it('a legacy record (no kind) addresses as a CC', () => {
    expect(bindingAddress({ channel: 1, cc: 2 })).toBe('cc:1:2');
  });
  it('the SAME cc on DIFFERENT channels is a DIFFERENT address (no collision)', () => {
    expect(bindingAddress({ channel: 0, cc: 4 })).not.toBe(bindingAddress({ channel: 1, cc: 4 }));
  });
});

describe('dedupeBindingsByAddress — one owner per (channel, cc|note)', () => {
  it('keeps the NEWEST learnedAt when two keys collide on one address', () => {
    const stale: MidiCcBinding = { kind: 'cc', key: 'cubeA:slice', channel: 0, cc: 0, learnedAt: 100 };
    const fresh: MidiCcBinding = { kind: 'cc', key: 'cubeB:slice', channel: 0, cc: 0, learnedAt: 200 };
    const out = dedupeBindingsByAddress([stale, fresh]);
    expect(out).toEqual([fresh]); // the stale collider is dropped
  });

  it('on a learnedAt TIE the LATER element wins (fresh import supersedes)', () => {
    const a: MidiCcBinding = { kind: 'cc', key: 'a:p', channel: 0, cc: 3, learnedAt: 5 };
    const b: MidiCcBinding = { kind: 'cc', key: 'b:p', channel: 0, cc: 3, learnedAt: 5 };
    expect(dedupeBindingsByAddress([a, b])).toEqual([b]);
  });

  it('distinct addresses are ALL preserved (CC vs NOTE, per-channel)', () => {
    const set: MidiBinding[] = [
      { kind: 'cc', key: 'm:a', channel: 0, cc: 0, learnedAt: 1 },
      { kind: 'cc', key: 'm:b', channel: 1, cc: 0, learnedAt: 1 }, // same cc, other channel
      { kind: 'note', key: 'm:g', channel: 0, note: 0, learnedAt: 1 }, // note 0 ≠ cc 0
    ];
    expect(dedupeBindingsByAddress(set)).toHaveLength(3);
  });

  it('preserves input order of the surviving winners (deterministic)', () => {
    const set: MidiCcBinding[] = [
      { kind: 'cc', key: 'first', channel: 0, cc: 1, learnedAt: 9 },
      { kind: 'cc', key: 'second', channel: 0, cc: 2, learnedAt: 9 },
      { kind: 'cc', key: 'dupe-of-first', channel: 0, cc: 1, learnedAt: 1 }, // older → dropped
    ];
    expect(dedupeBindingsByAddress(set).map((b) => b.key)).toEqual(['first', 'second']);
  });

  it('collapses a heavily-colliding set to exactly the distinct-address count', () => {
    // 3 keys all parked on cc0, 2 keys on cc1 → 2 survivors (one per address).
    const set: MidiCcBinding[] = [
      { kind: 'cc', key: 'x:1', channel: 0, cc: 0, learnedAt: 1 },
      { kind: 'cc', key: 'x:2', channel: 0, cc: 0, learnedAt: 2 },
      { kind: 'cc', key: 'x:3', channel: 0, cc: 0, learnedAt: 3 },
      { kind: 'cc', key: 'y:1', channel: 0, cc: 1, learnedAt: 1 },
      { kind: 'cc', key: 'y:2', channel: 0, cc: 1, learnedAt: 2 },
    ];
    const out = dedupeBindingsByAddress(set);
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.key).sort()).toEqual(['x:3', 'y:2']); // newest per address
  });
});
