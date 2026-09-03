// packages/web/src/lib/midi/midi-tail.test.ts
//
// The MIDI tail's decode vocabulary and ring semantics. Every string the
// debug panel can paint is decided in `midi-tail.ts`, so it is pinned here —
// a wrong decode on a diagnostic surface is worse than no surface, because a
// player trusts it over their own wiring.

import { describe, it, expect } from 'vitest';
import {
  MIDI_TAIL_CAPACITY,
  MIDI_TAIL_IDLE_TEXT,
  createMidiTailRing,
  decodeMidiMessage,
  formatMidiHex,
  formatMidiTailRow,
  midiNoteName,
} from './midi-tail';

describe('decodeMidiMessage — System Real-Time first, because a transport bridge lives on them', () => {
  it('names the transport vocabulary the owner report is about', () => {
    expect(decodeMidiMessage([0xf8])).toBe('CLOCK');
    expect(decodeMidiMessage([0xfa])).toBe('START');
    expect(decodeMidiMessage([0xfb])).toBe('CONTINUE');
    expect(decodeMidiMessage([0xfc])).toBe('STOP');
    expect(decodeMidiMessage([0xfe])).toBe('ACTIVE SENSE');
    expect(decodeMidiMessage([0xff])).toBe('RESET');
  });

  it('decodes System Common (song position is 14-bit little-endian)', () => {
    expect(decodeMidiMessage([0xf2, 0x01, 0x01])).toBe('SONG POS 129');
    expect(decodeMidiMessage([0xf3, 5])).toBe('SONG SEL 5');
    expect(decodeMidiMessage([0xf0])).toBe('SYSEX (1 bytes)');
    // The LENGTH is the diagnostic half of a sysex row — the hex column elides.
    expect(decodeMidiMessage([0xf0, 0x00, 0x21, 0x45, 0xf7])).toBe('SYSEX (5 bytes)');
  });

  it('decodes channel voice with the 1-based on-wire channel', () => {
    expect(decodeMidiMessage([0x90, 60, 100])).toBe('ch1 NOTE ON C4 v100');
    expect(decodeMidiMessage([0x85, 61, 0])).toBe('ch6 NOTE OFF C#4');
    expect(decodeMidiMessage([0xb0, 20, 64])).toBe('ch1 CC 20 = 64');
    expect(decodeMidiMessage([0xc2, 7])).toBe('ch3 PROGRAM 7');
    expect(decodeMidiMessage([0xe0, 0x00, 0x40])).toBe('ch1 BEND 0');
  });

  it('a velocity-0 note-on is DECODED as the note-off it is on the wire', () => {
    // The running-status idiom every hardware sequencer uses; a tail that
    // showed it as NOTE ON would tell a player their gate never falls.
    expect(decodeMidiMessage([0x90, 60, 0])).toBe('ch1 NOTE OFF C4 (v0)');
  });

  it('shows the unexplainable rather than hiding it', () => {
    expect(decodeMidiMessage([])).toBe('?');
    expect(decodeMidiMessage([0x42])).toBe('?'); // stray data byte
  });

  it('midiNoteName: 60 is middle C, octave math per the repo convention', () => {
    expect(midiNoteName(60)).toBe('C4');
    expect(midiNoteName(0)).toBe('C-1');
    expect(midiNoteName(127)).toBe('G9');
  });
});

describe('formatMidiTailRow — timestamped hex + decoded name', () => {
  it('carries seconds, upper-case hex and the decode in one row', () => {
    const row = formatMidiTailRow({ atMs: 1234.5678, bytes: [0xfa] });
    expect(row).toContain('1.235');
    expect(row).toContain('FA');
    expect(row).toContain('START');
  });

  it('formatMidiHex zero-pads and uppercases', () => {
    expect(formatMidiHex([0x90, 0x3c, 0x64])).toBe('90 3C 64');
    expect(formatMidiHex([0x0f])).toBe('0F');
  });

  it('a long message ELIDES its hex past 8 bytes — the row stays a row, the count survives', () => {
    // The tail paints unwrapped rows; an unbounded sysex body would put a mile
    // of horizontal scroll between the player and the next transport row.
    const row = formatMidiTailRow({
      atMs: 1,
      bytes: [0xf0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0xf7],
    });
    expect(row).toContain('… +4');
    expect(row).toContain('SYSEX (12 bytes)');
    expect(row).not.toContain('0A'); // byte 10 is inside the elision
  });
});

describe('createMidiTailRing — bounded, newest first, honest counter', () => {
  it('keeps rows NEWEST FIRST and counts everything it ever saw', () => {
    const ring = createMidiTailRing(3);
    ring.push({ atMs: 1, bytes: [0xfa] });
    ring.push({ atMs: 2, bytes: [0xf8] });
    expect(ring.lines()[0]).toContain('CLOCK'); // newest on top
    expect(ring.lines()[1]).toContain('START');
    expect(ring.seen()).toBe(2);
  });

  it('evicts the OLDEST row past capacity — the ring never grows', () => {
    const ring = createMidiTailRing(2);
    ring.push({ atMs: 1, bytes: [0xfa] });
    ring.push({ atMs: 2, bytes: [0xf8] });
    ring.push({ atMs: 3, bytes: [0xfc] });
    const lines = ring.lines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('STOP');
    expect(lines[1]).toContain('CLOCK');
    expect(lines.join('\n')).not.toContain('START'); // the evicted row
    expect(ring.seen(), 'eviction does not un-count').toBe(3);
  });

  it('clear() empties rows AND the counter', () => {
    const ring = createMidiTailRing();
    ring.push({ atMs: 1, bytes: [0xfa] });
    ring.clear();
    expect(ring.lines()).toEqual([]);
    expect(ring.seen()).toBe(0);
  });

  it('default capacity is the documented 200', () => {
    expect(MIDI_TAIL_CAPACITY).toBe(200);
    const ring = createMidiTailRing();
    for (let i = 0; i < 250; i++) ring.push({ atMs: i, bytes: [0xf8] });
    expect(ring.lines()).toHaveLength(200);
    expect(ring.seen()).toBe(250);
  });

  it('the idle sentence states the honest negative', () => {
    // A tail that says nothing when empty cannot separate "no traffic" from
    // "panel broken" — the exact ambiguity the owner report lived in.
    expect(MIDI_TAIL_IDLE_TEXT).toMatch(/no traffic/i);
  });
});
