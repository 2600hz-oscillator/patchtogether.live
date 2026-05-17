// packages/web/src/lib/audio/modules/midi-cv-buddy.test.ts
//
// Unit tests for MIDI-CV-BUDDY: module-def shape + pure helpers
// (voice priority, velocity scaling, pitch-bend math, held-stack
// manipulation, MIDI status parsing). Live AudioContext + the
// requestMIDIAccess permission path are covered by the E2E spec.

import { describe, expect, it } from 'vitest';
import {
  midiCvBuddyDef,
  pickWinner,
  velocityToCv,
  bendToVOct,
  channelMatches,
  parseNoteEvent,
  parsePitchBend,
  pushHeld,
  removeHeld,
  SCHED_LOOKAHEAD_S,
  DEFAULT_BEND_SEMITONES,
} from './midi-cv-buddy';
import { midiToVOct } from '$lib/audio/note-entry';

describe('midiCvBuddyDef: module shape', () => {
  it('declares no inputs and three outputs (pitch / gate / velocity)', () => {
    expect(midiCvBuddyDef.inputs).toEqual([]);
    const outIds = midiCvBuddyDef.outputs.map((o) => o.id);
    expect(outIds).toEqual(['pitch_cv', 'gate', 'velocity_cv']);
  });

  it('belongs to the sources category', () => {
    expect(midiCvBuddyDef.category).toBe('sources');
  });

  it('has no AudioParam-style knobs (discrete settings live on node.data)', () => {
    expect(midiCvBuddyDef.params).toEqual([]);
  });

  it('lookahead is a small positive number (~ one audio block)', () => {
    expect(SCHED_LOOKAHEAD_S).toBeGreaterThan(0);
    expect(SCHED_LOOKAHEAD_S).toBeLessThan(0.01);
  });
});

describe('pickWinner: voice priority modes', () => {
  it('returns null on empty stack', () => {
    expect(pickWinner([], 'last')).toBeNull();
    expect(pickWinner([], 'low')).toBeNull();
    expect(pickWinner([], 'high')).toBeNull();
  });

  it('LAST returns the most recently pressed (top of stack)', () => {
    expect(pickWinner([60, 64, 67], 'last')).toBe(67);
    expect(pickWinner([67, 60], 'last')).toBe(60);
  });

  it('LOW returns the lowest MIDI note', () => {
    expect(pickWinner([67, 60, 64], 'low')).toBe(60);
    expect(pickWinner([60], 'low')).toBe(60);
  });

  it('HIGH returns the highest MIDI note', () => {
    expect(pickWinner([60, 67, 64], 'high')).toBe(67);
    expect(pickWinner([60], 'high')).toBe(60);
  });
});

describe('velocityToCv: 0..127 → 0..1', () => {
  it('0 → 0', () => expect(velocityToCv(0)).toBe(0));
  it('127 → 1', () => expect(velocityToCv(127)).toBeCloseTo(1, 8));
  it('64 → 64/127 (≈ 0.504)', () => expect(velocityToCv(64)).toBeCloseTo(64 / 127, 6));
  it('clamps negative + over-range', () => {
    expect(velocityToCv(-10)).toBe(0);
    expect(velocityToCv(200)).toBeCloseTo(1, 8);
  });
  it('rejects NaN gracefully', () => expect(velocityToCv(NaN)).toBe(0));
});

describe('bendToVOct: 14-bit pitch bend → V/oct', () => {
  it('center (8192) → 0 V', () => expect(bendToVOct(8192)).toBe(0));
  it('max bend (16383) → +2 semitones / 12 ≈ 0.1666 V (±2 default)', () => {
    expect(bendToVOct(16383)).toBeCloseTo((16383 - 8192) / 8192 * 2 / 12, 6);
  });
  it('min bend (0) → -2 semitones / 12 ≈ -0.1666 V', () => {
    expect(bendToVOct(0)).toBeCloseTo(-1 * 2 / 12, 6);
  });
  it('custom semitone range', () => {
    expect(bendToVOct(8192, 12)).toBe(0);
    expect(bendToVOct(16383, 12)).toBeCloseTo((16383 - 8192) / 8192 * 12 / 12, 6);
  });
  it('default range is 2 semitones each side', () => {
    expect(DEFAULT_BEND_SEMITONES).toBe(2);
  });
});

describe('channelMatches: channel filter', () => {
  it('null filter passes any channel', () => {
    for (let ch = 0; ch < 16; ch++) {
      expect(channelMatches(0x90 | ch, null)).toBe(true);
    }
  });
  it('matches only the chosen channel', () => {
    expect(channelMatches(0x90 | 0, 0)).toBe(true);
    expect(channelMatches(0x90 | 1, 0)).toBe(false);
    expect(channelMatches(0x90 | 15, 15)).toBe(true);
  });
});

describe('parseNoteEvent: raw MIDI → note event', () => {
  it('note-on with velocity > 0 → note-on', () => {
    const ev = parseNoteEvent(new Uint8Array([0x90, 60, 100]));
    expect(ev).toEqual({ kind: 'note-on', note: 60, velocity: 100 });
  });

  it('note-on with velocity 0 → note-off (running-status convention)', () => {
    const ev = parseNoteEvent(new Uint8Array([0x90, 60, 0]));
    expect(ev).toEqual({ kind: 'note-off', note: 60 });
  });

  it('note-off → note-off', () => {
    const ev = parseNoteEvent(new Uint8Array([0x80, 60, 64]));
    expect(ev).toEqual({ kind: 'note-off', note: 60 });
  });

  it('cc / pitch-bend / sysex returns null (not a note event)', () => {
    expect(parseNoteEvent(new Uint8Array([0xb0, 7, 100]))).toBeNull();
    expect(parseNoteEvent(new Uint8Array([0xe0, 0, 64]))).toBeNull();
    expect(parseNoteEvent(new Uint8Array([0xf0, 0x7e]))).toBeNull();
  });

  it('strips the channel low-nibble (note-on on channel 5 still parses)', () => {
    const ev = parseNoteEvent(new Uint8Array([0x95, 60, 100]));
    expect(ev).toEqual({ kind: 'note-on', note: 60, velocity: 100 });
  });
});

describe('parsePitchBend: 14-bit value extraction', () => {
  it('center bend → 8192', () => {
    expect(parsePitchBend(new Uint8Array([0xe0, 0, 64]))).toBe(8192);
  });

  it('full positive → 16383', () => {
    expect(parsePitchBend(new Uint8Array([0xe0, 0x7f, 0x7f]))).toBe(16383);
  });

  it('full negative → 0', () => {
    expect(parsePitchBend(new Uint8Array([0xe0, 0, 0]))).toBe(0);
  });

  it('returns null on non-pitch-bend status', () => {
    expect(parsePitchBend(new Uint8Array([0x90, 60, 100]))).toBeNull();
  });

  it('returns null on truncated data', () => {
    expect(parsePitchBend(new Uint8Array([0xe0, 0]))).toBeNull();
  });
});

describe('pushHeld / removeHeld: stack manipulation', () => {
  it('pushHeld appends a new note', () => {
    expect(pushHeld([60], 64)).toEqual([60, 64]);
  });

  it('pushHeld re-anchors an existing note to the top (re-press)', () => {
    expect(pushHeld([60, 64, 67], 60)).toEqual([64, 67, 60]);
  });

  it('removeHeld drops the matching note', () => {
    expect(removeHeld([60, 64, 67], 64)).toEqual([60, 67]);
  });

  it('removeHeld is a no-op when note not present', () => {
    expect(removeHeld([60, 64], 67)).toEqual([60, 64]);
  });
});

describe('Last-note priority scenario: key 1 held + key 2 pressed + key 2 released', () => {
  it('pitch follows key 2 while held, returns to key 1 on release', () => {
    let stack: number[] = [];
    stack = pushHeld(stack, 60); // key 1: middle C
    expect(pickWinner(stack, 'last')).toBe(60);
    stack = pushHeld(stack, 67); // key 2: G above
    expect(pickWinner(stack, 'last')).toBe(67);
    stack = removeHeld(stack, 67); // release key 2
    expect(pickWinner(stack, 'last')).toBe(60);
    stack = removeHeld(stack, 60); // release key 1
    expect(pickWinner(stack, 'last')).toBeNull();
  });

  it('LOW priority: holding 60+67 always yields 60 regardless of press order', () => {
    let stack: number[] = [];
    stack = pushHeld(stack, 67);
    stack = pushHeld(stack, 60);
    expect(pickWinner(stack, 'low')).toBe(60);
    stack = removeHeld(stack, 60);
    expect(pickWinner(stack, 'low')).toBe(67);
  });

  it('HIGH priority: 60+67 yields 67 regardless of press order', () => {
    let stack: number[] = [];
    stack = pushHeld(stack, 60);
    stack = pushHeld(stack, 67);
    expect(pickWinner(stack, 'high')).toBe(67);
    stack = removeHeld(stack, 67);
    expect(pickWinner(stack, 'high')).toBe(60);
  });
});

describe('MIDI note → V/oct: octave correctness', () => {
  it('C4 (60) = 0 V', () => expect(midiToVOct(60)).toBe(0));
  it('C5 (72) = +1 V', () => expect(midiToVOct(72)).toBe(1));
  it('C3 (48) = -1 V', () => expect(midiToVOct(48)).toBe(-1));
  it('every semitone in an octave is 1/12 V', () => {
    for (let i = 0; i <= 12; i++) {
      expect(midiToVOct(60 + i)).toBeCloseTo(i / 12, 8);
    }
  });
});

describe('Channel filter logic', () => {
  it('all-channels (null) accepts every channel byte', () => {
    for (let ch = 0; ch < 16; ch++) {
      // Note-on status with channel low-nibble
      expect(channelMatches(0x90 | ch, null)).toBe(true);
      // Pitch-bend status
      expect(channelMatches(0xe0 | ch, null)).toBe(true);
    }
  });

  it('channel 3 filter accepts only ch3 messages', () => {
    expect(channelMatches(0x93, 3)).toBe(true);
    expect(channelMatches(0xe3, 3)).toBe(true);
    expect(channelMatches(0x90, 3)).toBe(false);
    expect(channelMatches(0x94, 3)).toBe(false);
  });
});
