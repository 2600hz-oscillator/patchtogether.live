// packages/web/src/lib/midi/note-binding.test.ts
//
// Unit tests for the PURE note-message parsing + binding guards.

import { describe, it, expect } from 'vitest';
import {
  parseNoteMessage,
  noteMatches,
  isCcBinding,
  isNoteBinding,
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
