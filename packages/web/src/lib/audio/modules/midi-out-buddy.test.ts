// packages/web/src/lib/audio/modules/midi-out-buddy.test.ts
//
// Unit tests for MIDI-OUT-BUDDY: module-def shape + the pure CV→MIDI mapping
// (pitch CV → note quantization, velocity CV → 1..127, NoteOn/NoteOff byte
// sequences) + the note-tracking state machine (NoteOff matches the held
// note even after pitch drift; retrigger / device-change flush). The live
// AudioContext + requestMIDIAccess permission path are covered by the E2E
// spec (midi-out-buddy.spec.ts) with a fake MIDIOutput.

import { describe, expect, it } from 'vitest';
import {
  midiOutBuddyDef,
  pitchCvToMidiNote,
  velocityCvToMidi,
  noteOnBytes,
  noteOffBytes,
  allNotesOffBytes,
  createMidiNoteTracker,
  DEFAULT_DATA,
} from './midi-out-buddy';
import { vOctToMidi, C4_MIDI } from '$lib/audio/note-entry';

describe('midiOutBuddyDef: module shape', () => {
  it('declares gate/pitch/velocity inputs and zero outputs (terminal MIDI sink)', () => {
    expect(midiOutBuddyDef.inputs.map((p) => p.id)).toEqual(['gate', 'pitch', 'velocity']);
    expect(midiOutBuddyDef.inputs.map((p) => p.type)).toEqual(['gate', 'cv', 'cv']);
    expect(midiOutBuddyDef.outputs).toEqual([]);
  });

  it('is an output-category module distinct from midiCvBuddy', () => {
    expect(midiOutBuddyDef.type).toBe('midiOutBuddy');
    expect(midiOutBuddyDef.type).not.toBe('midiCvBuddy');
    expect(midiOutBuddyDef.category).toBe('output');
    expect(midiOutBuddyDef.label).toBe('MIDI CV BUDDY OUT');
  });

  it('has no AudioParam-style knobs (channel + device live on node.data)', () => {
    expect(midiOutBuddyDef.params).toEqual([]);
  });

  it('default data is channel 1, no device', () => {
    expect(DEFAULT_DATA).toEqual({ channel: 1, lastDeviceId: null });
  });
});

describe('pitchCvToMidiNote: V/oct → MIDI note (C4 = 0V = MIDI 60)', () => {
  it('0 V → MIDI 60 (C4) — matches the repo C4 convention', () => {
    expect(pitchCvToMidiNote(0)).toBe(60);
    expect(C4_MIDI).toBe(60);
    expect(vOctToMidi(0)).toBe(60);
  });

  it('+1 V → MIDI 72 (C5), -1 V → MIDI 48 (C3)', () => {
    expect(pitchCvToMidiNote(1)).toBe(72);
    expect(pitchCvToMidiNote(-1)).toBe(48);
  });

  it('quantizes to the NEAREST semitone', () => {
    // 60 + 7 semitones = G4 (67). 7/12 V = 0.5833…; nudge either side.
    expect(pitchCvToMidiNote(7 / 12)).toBe(67);
    expect(pitchCvToMidiNote(7 / 12 + 0.49 / 12)).toBe(67); // < half-step up → still 67
    expect(pitchCvToMidiNote(7 / 12 + 0.51 / 12)).toBe(68); // > half-step up → 68
  });

  it('clamps to the playable 7-bit range', () => {
    expect(pitchCvToMidiNote(100)).toBeLessThanOrEqual(127);
    expect(pitchCvToMidiNote(-100)).toBeGreaterThanOrEqual(0);
  });

  it('NaN → C4 fallback (60)', () => {
    expect(pitchCvToMidiNote(NaN)).toBe(60);
  });
});

describe('velocityCvToMidi: 0..1 CV → MIDI velocity 1..127', () => {
  it('1.0 → 127', () => expect(velocityCvToMidi(1)).toBe(127));
  it('0 → 1 (never emit velocity-0, which is a NoteOff on the wire)', () => {
    expect(velocityCvToMidi(0)).toBe(1);
  });
  it('negative → 1 (floor)', () => expect(velocityCvToMidi(-0.5)).toBe(1));
  it('> 1 → 127 (clamp)', () => expect(velocityCvToMidi(2)).toBe(127));
  it('0.5 → 64 (round(0.5*127) = 64)', () => expect(velocityCvToMidi(0.5)).toBe(64));
  it('a tiny positive CV still floors to 1, not 0', () => {
    expect(velocityCvToMidi(0.001)).toBe(1);
  });
  it('NaN → 1', () => expect(velocityCvToMidi(NaN)).toBe(1));
});

describe('byte builders: NoteOn / NoteOff / AllNotesOff', () => {
  it('NoteOn channel 1 → status 0x90', () => {
    expect(noteOnBytes(1, 60, 100)).toEqual([0x90, 60, 100]);
  });
  it('NoteOn channel 16 → status 0x9F', () => {
    expect(noteOnBytes(16, 64, 80)).toEqual([0x9f, 64, 80]);
  });
  it('NoteOff channel 1 → status 0x80, velocity 0', () => {
    expect(noteOffBytes(1, 60)).toEqual([0x80, 60, 0]);
  });
  it('NoteOff channel 10 → status 0x89', () => {
    expect(noteOffBytes(10, 60)).toEqual([0x89, 60, 0]);
  });
  it('AllNotesOff → CC 123 value 0 on the channel', () => {
    expect(allNotesOffBytes(1)).toEqual([0xb0, 123, 0]);
    expect(allNotesOffBytes(16)).toEqual([0xbf, 123, 0]);
  });
  it('channel is clamped to 1..16', () => {
    expect(noteOnBytes(0, 60, 100)[0]).toBe(0x90); // clamps up to 1
    expect(noteOnBytes(99, 60, 100)[0]).toBe(0x9f); // clamps down to 16
  });
  it('note + velocity are masked to 7 bits', () => {
    expect(noteOnBytes(1, 200, 200)).toEqual([0x90, 200 & 0x7f, 200 & 0x7f]);
  });
});

describe('createMidiNoteTracker: gate edges → byte sequences + note tracking', () => {
  it('starts silent', () => {
    expect(createMidiNoteTracker().soundingNote).toBeNull();
  });

  it('gate rise → single NoteOn, tracks the sounding note', () => {
    const t = createMidiNoteTracker();
    const msgs = t.onGateRise(1, 64, 100);
    expect(msgs).toEqual([[0x90, 64, 100]]);
    expect(t.soundingNote).toBe(64);
  });

  it('rise then fall → NoteOn then matching NoteOff', () => {
    const t = createMidiNoteTracker();
    expect(t.onGateRise(3, 67, 90)).toEqual([[0x92, 67, 90]]);
    expect(t.onGateFall(3)).toEqual([[0x82, 67, 0]]);
    expect(t.soundingNote).toBeNull();
  });

  it('NoteOff targets the HELD note even if a different note is requested later (pitch drift)', () => {
    const t = createMidiNoteTracker();
    // Gate rose on MIDI 60.
    t.onGateRise(1, 60, 100);
    // Pitch drifted to 64 while gate held — but no new rise, so no NoteOn.
    // The fall must close note 60, NOT 64.
    expect(t.onGateFall(1)).toEqual([[0x80, 60, 0]]);
    expect(t.soundingNote).toBeNull();
  });

  it('retrigger (rise while already sounding) closes the old note before the new NoteOn', () => {
    const t = createMidiNoteTracker();
    t.onGateRise(1, 60, 100);
    // A second rise with no observed fall (sub-tick pulse): close 60, open 62.
    expect(t.onGateRise(1, 62, 110)).toEqual([
      [0x80, 60, 0], // NoteOff old
      [0x90, 62, 110], // NoteOn new
    ]);
    expect(t.soundingNote).toBe(62);
  });

  it('fall while silent is a no-op (no spurious NoteOff)', () => {
    const t = createMidiNoteTracker();
    expect(t.onGateFall(1)).toEqual([]);
  });

  it('flush sends matched NoteOff + AllNotesOff and clears tracking', () => {
    const t = createMidiNoteTracker();
    t.onGateRise(5, 72, 64);
    expect(t.flush(5)).toEqual([
      [0x84, 72, 0], // NoteOff held note on channel 5
      [0xb4, 123, 0], // AllNotesOff on channel 5
    ]);
    expect(t.soundingNote).toBeNull();
  });

  it('flush while silent sends only AllNotesOff', () => {
    const t = createMidiNoteTracker();
    expect(t.flush(1)).toEqual([[0xb0, 123, 0]]);
  });

  it('end-to-end: CV → bytes — pitch+velocity CV feed the NoteOn', () => {
    const t = createMidiNoteTracker();
    // pitch CV +1 V → MIDI 72; velocity CV 0.5 → 64; channel 2.
    const note = pitchCvToMidiNote(1);
    const vel = velocityCvToMidi(0.5);
    expect(t.onGateRise(2, note, vel)).toEqual([[0x91, 72, 64]]);
    expect(t.onGateFall(2)).toEqual([[0x81, 72, 0]]);
  });
});
