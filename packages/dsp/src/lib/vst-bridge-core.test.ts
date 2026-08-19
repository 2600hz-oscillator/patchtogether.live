// Tests for the VST-bridge pure core: the poly-CV → MIDI voice state
// machine and the SAB MIDI event ring.
//
// TWIN PINS: the note/velocity/gate constants here are DUPLICATES of the
// web-side canon (note-entry.ts / midi-out-buddy.ts / clip-types.ts), and
// the MIDI ring layout is mirrored web-side in vst-ring.ts. The web test
// (packages/web/src/lib/audio/vst/vst-transport.test.ts) pins the SAME note
// table against the canonical functions and the SAME raw-byte ring sequence
// against the mirror — if either half drifts, one of the twins fails.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VELOCITY,
  GATE_HI,
  MAX_MIDI,
  MIN_MIDI,
  MidiRingIO,
  PolyMidiVoice,
  createMidiRingSpec,
  pitchCvToMidiNote,
  velocityCvToMidi,
} from './vst-bridge-core';

/** The owner-named correctness table (plan §5a): pitch CV V/oct → MIDI. */
const NOTE_TABLE: Array<[number, number, string]> = [
  [-4.0, 12, 'c0 (clamp floor boundary)'],
  [-1.0, 48, 'c3'],
  [0.0, 60, 'c4'],
  [0.75, 69, 'a4 = 440 Hz'],
  [1.0, 72, 'c5'],
  [4.0, 108, 'c8 (clamp ceiling boundary)'],
  [-10.0, MIN_MIDI, 'below c0 clamps to 12'],
  [10.0, MAX_MIDI, 'above c8 clamps to 108'],
];

function collector() {
  const events: Array<{ t: number; bytes: number[] }> = [];
  const emit = (t: number, d0: number, d1: number, d2: number, len: number) => {
    events.push({ t, bytes: len === 3 ? [d0, d1, d2] : len === 2 ? [d0, d1] : [d0] });
  };
  return { events, emit };
}

describe('note / velocity / gate conversion (duplicate of the web canon)', () => {
  it('pins the note table: c3=-1→48, c4=0→60, a4=+0.75→69, c5=+1→72, clamps 12..108', () => {
    for (const [cv, midi, name] of NOTE_TABLE) {
      expect(pitchCvToMidiNote(cv), `${name}: ${cv} V/oct`).toBe(midi);
    }
  });

  it('rounds to the NEAREST semitone (band edge at ±1/24 oct)', () => {
    expect(pitchCvToMidiNote(0.0416)).toBe(60); // 0.4992 semitones up
    expect(pitchCvToMidiNote(0.0417)).toBe(61); // 0.5004 semitones up
    expect(pitchCvToMidiNote(-0.0416)).toBe(60);
  });

  it('non-finite pitch lands on C4 (the cable rest value), not a throw', () => {
    expect(pitchCvToMidiNote(Number.NaN)).toBe(60);
    expect(pitchCvToMidiNote(Number.POSITIVE_INFINITY)).toBe(60);
  });

  it('velocity: floors at 1 (NoteOn vel 0 is NoteOff on the wire), caps 127', () => {
    expect(velocityCvToMidi(0)).toBe(1);
    expect(velocityCvToMidi(-1)).toBe(1);
    expect(velocityCvToMidi(1)).toBe(127);
    expect(velocityCvToMidi(2)).toBe(127);
    expect(velocityCvToMidi(0.5)).toBe(64);
    expect(velocityCvToMidi(Number.NaN)).toBe(1);
  });

  it('gate threshold is 0.5, high-inclusive (matches midi-out-buddy GATE_THRESHOLD)', () => {
    expect(GATE_HI).toBe(0.5);
    const { events, emit } = collector();
    const v = new PolyMidiVoice();
    v.process(0, 0.49, Number.NaN, 0, emit);
    expect(events).toHaveLength(0);
    v.process(0, 0.5, Number.NaN, 1, emit);
    expect(events).toEqual([{ t: 1, bytes: [0x90, 60, DEFAULT_VELOCITY] }]);
  });
});

describe('PolyMidiVoice state machine', () => {
  it('rise → NoteOn with pitch sampled AT the rise; fall → NoteOff of the SOUNDING note', () => {
    const { events, emit } = collector();
    const v = new PolyMidiVoice();
    v.process(-1.0, 1, Number.NaN, 10, emit); // rise at c3
    // Move pitch and drop the gate in the SAME sample: the fall takes
    // priority (no legato pair), and the NoteOff names the note that is
    // SOUNDING (48), not the pitch the cable points at now (c5).
    v.process(1.0, 0, Number.NaN, 20, emit);
    expect(events).toEqual([
      { t: 10, bytes: [0x90, 48, DEFAULT_VELOCITY] },
      { t: 20, bytes: [0x80, 48, 0] },
    ]);
  });

  it('retrigger (gate dips low then back, clipplayer-style) → clean off + on pair', () => {
    const { events, emit } = collector();
    const v = new PolyMidiVoice();
    v.process(0, 1, Number.NaN, 0, emit);
    // ~3 ms low at 48 kHz ≈ 144 samples — the machine only needs one.
    v.process(0, 0, Number.NaN, 100, emit);
    v.process(0, 1, Number.NaN, 244, emit);
    expect(events).toEqual([
      { t: 0, bytes: [0x90, 60, DEFAULT_VELOCITY] },
      { t: 100, bytes: [0x80, 60, 0] },
      { t: 244, bytes: [0x90, 60, DEFAULT_VELOCITY] },
    ]);
  });

  it('legato/tied step (pitch crosses a semitone while gate HIGH) → NoteOff(old) then NoteOn(new, SAME velocity) at the same sampleTime', () => {
    const { events, emit } = collector();
    const v = new PolyMidiVoice();
    v.process(0, 1, 0.5, 0, emit); // NoteOn c4 vel 64
    v.process(0.02, 1, 0.9, 50, emit); // < half a semitone: nothing
    v.process(1.0, 1, 0.9, 99, emit); // tied step to c5 — vel stays 64
    expect(events).toEqual([
      { t: 0, bytes: [0x90, 60, 64] },
      { t: 99, bytes: [0x80, 60, 0] },
      { t: 99, bytes: [0x90, 72, 64] },
    ]);
    expect(events[1]!.t).toBe(events[2]!.t);
  });

  it('velocity: NaN (unpatched) → DEFAULT_VELOCITY 100; patched → sampled at the rise', () => {
    expect(DEFAULT_VELOCITY).toBe(100);
    const { events, emit } = collector();
    const v = new PolyMidiVoice();
    v.process(0, 1, Number.NaN, 0, emit);
    v.process(0, 0, Number.NaN, 1, emit);
    v.process(0, 1, 1.0, 2, emit);
    expect(events[0]!.bytes[2]).toBe(100);
    expect(events[2]!.bytes[2]).toBe(127);
  });

  it('flush → NoteOff for a sounding note, idempotent, resets the gate', () => {
    const { events, emit } = collector();
    const v = new PolyMidiVoice();
    v.process(0.75, 1, Number.NaN, 5, emit);
    v.flush(6, emit);
    v.flush(7, emit);
    expect(events).toEqual([
      { t: 5, bytes: [0x90, 69, DEFAULT_VELOCITY] },
      { t: 6, bytes: [0x80, 69, 0] },
    ]);
    // After a flush the next high level is a fresh rise.
    v.process(0.75, 1, Number.NaN, 8, emit);
    expect(events[2]).toEqual({ t: 8, bytes: [0x90, 69, DEFAULT_VELOCITY] });
  });

  it('16 voices are independent: each voice-pair gates its own note, no cross-talk', () => {
    // Simulate what the worklet does: one machine per poly voice-pair, all
    // fed per-sample. Voice i plays note (48 + i), gated on at sample i*8,
    // off at i*8+4; the shared mono vel cable applies to every rise.
    const voices = Array.from({ length: 16 }, () => new PolyMidiVoice());
    const { events, emit } = collector();
    for (let s = 0; s < 16 * 8 + 8; s++) {
      for (let i = 0; i < 16; i++) {
        const pitch = (48 + i - 60) / 12;
        const gate = s >= i * 8 && s < i * 8 + 4 ? 1 : 0;
        voices[i]!.process(pitch, gate, 0.5, s, emit);
      }
    }
    expect(events).toHaveLength(32);
    for (let i = 0; i < 16; i++) {
      const on = events.find((e) => e.bytes[0] === 0x90 && e.bytes[1] === 48 + i)!;
      const off = events.find((e) => e.bytes[0] === 0x80 && e.bytes[1] === 48 + i)!;
      expect(on.t).toBe(i * 8);
      expect(off.t).toBe(i * 8 + 4);
      expect(on.bytes[2]).toBe(64);
    }
  });
});

describe('MIDI event ring (SAB SPSC, 16-byte records)', () => {
  it('round-trips events across the wrap boundary, preserving order', () => {
    const ring = new MidiRingIO(createMidiRingSpec(8));
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < 6; i++) {
        expect(ring.write(cycle * 1000 + i, 0x90, i, 100, 3)).toBe(true);
      }
      const seen: Array<{ t: number; d1: number }> = [];
      expect(ring.read(6, (t, _d0, d1) => seen.push({ t, d1 }))).toBe(6);
      expect(seen.map((e) => e.d1)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(seen[0]!.t).toBe(cycle * 1000);
    }
  });

  it('drops (returns false) when full instead of blocking or overwriting', () => {
    const ring = new MidiRingIO(createMidiRingSpec(4));
    for (let i = 0; i < 4; i++) expect(ring.write(i, 0x90, 60, 100, 3)).toBe(true);
    expect(ring.write(99, 0x90, 61, 100, 3)).toBe(false);
    const seen: number[] = [];
    ring.read(10, (_t, _d0, d1) => seen.push(d1));
    expect(seen).toEqual([60, 60, 60, 60]);
  });

  it('sampleTime survives beyond 2^32 (hi/lo split)', () => {
    const ring = new MidiRingIO(createMidiRingSpec(4));
    const big = 2 ** 40 + 12345;
    ring.write(big, 0x80, 48, 0, 3);
    let got = -1;
    ring.read(1, (t) => { got = t; });
    expect(got).toBe(big);
  });

  it('LAYOUT PIN: identical to the web mirror (lo/hi u32, len@8, data@9..11)', () => {
    // Same raw-byte assertions as vst-transport.test.ts — if either half's
    // layout drifts, one of the twin tests fails.
    const spec = createMidiRingSpec(8);
    const ring = new MidiRingIO(spec);
    ring.write(2 ** 32 + 5, 0x90, 60, 100, 3);
    const raw = new Uint8Array(spec.data);
    expect([...raw.slice(0, 16)]).toEqual([
      5, 0, 0, 0, // sampleTime lo LE
      1, 0, 0, 0, // sampleTime hi LE
      3,          // len
      0x90, 60, 100, // data
      0, 0, 0, 0, // reserved
    ]);
    const header = new Int32Array(spec.header);
    expect(header[0]).toBe(1);
    expect(header[1]).toBe(0);
  });

  it('zero-pads unused data bytes on short events', () => {
    const spec = createMidiRingSpec(4);
    const ring = new MidiRingIO(spec);
    ring.write(0, 0xf8, 0x7f, 0x7f, 1); // realtime clock: len 1, d1/d2 noise ignored
    const raw = new Uint8Array(spec.data);
    expect([...raw.slice(8, 12)]).toEqual([1, 0xf8, 0, 0]);
  });
});
