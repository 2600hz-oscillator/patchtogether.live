// packages/web/src/lib/audio/poly.test.ts
//
// Unit tests for the chord math and the cable-type resolver. These don't
// touch Web Audio — sender/receiver helpers are exercised in the ART scenario
// (which runs under node-web-audio-api) and in the E2E spec.

import { describe, it, expect } from 'vitest';
import {
  POLY_CHANNEL_PAIRS,
  POLY_CHANNELS,
  CHORD_QUALITIES,
  nextChordQuality,
  chordVoicing,
  voicingToVOct,
  resolveConnection,
} from './poly';
import { MAX_MIDI, MIN_MIDI, midiToVOct, noteNameForMidi } from './note-entry';

describe('poly: constants', () => {
  it('5 voice pairs = 10 channels', () => {
    expect(POLY_CHANNEL_PAIRS).toBe(5);
    expect(POLY_CHANNELS).toBe(10);
  });
});

describe('poly: nextChordQuality cycles mono -> maj -> min -> mono', () => {
  it('mono -> maj', () => {
    expect(nextChordQuality('mono')).toBe('maj');
  });
  it('maj -> min', () => {
    expect(nextChordQuality('maj')).toBe('min');
  });
  it('min -> mono', () => {
    expect(nextChordQuality('min')).toBe('mono');
  });
  it('undefined -> maj (treat as mono and cycle)', () => {
    expect(nextChordQuality(undefined)).toBe('maj');
  });
  it('CHORD_QUALITIES exposes all three', () => {
    expect([...CHORD_QUALITIES].sort()).toEqual(['maj', 'min', 'mono']);
  });
});

describe('poly: chordVoicing handles empty / invalid roots', () => {
  it('null base => all lanes gate=0', () => {
    const v = chordVoicing(null, 'maj');
    expect(v).toHaveLength(POLY_CHANNEL_PAIRS);
    for (const lane of v) {
      expect(lane.gate).toBe(0);
      expect(lane.midi).toBeNull();
    }
  });

  it('NaN base => all lanes gate=0', () => {
    const v = chordVoicing(NaN, 'maj');
    for (const lane of v) expect(lane.gate).toBe(0);
  });

  it('out-of-range base => all lanes gate=0', () => {
    const below = chordVoicing(MIN_MIDI - 1, 'maj');
    const above = chordVoicing(MAX_MIDI + 1, 'maj');
    for (const lane of below) expect(lane.gate).toBe(0);
    for (const lane of above) expect(lane.gate).toBe(0);
  });
});

describe('poly: chordVoicing mono = root only', () => {
  it('lane 0 = root, lanes 1..4 silent', () => {
    const v = chordVoicing(69, 'mono'); // a4
    expect(v[0]).toEqual({ midi: 69, gate: 1 });
    for (let i = 1; i < POLY_CHANNEL_PAIRS; i++) {
      expect(v[i]).toEqual({ midi: null, gate: 0 });
    }
  });

  it('runs across the full MIDI range', () => {
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      const v = chordVoicing(m, 'mono');
      expect(v[0]).toEqual({ midi: m, gate: 1 });
      for (let i = 1; i < POLY_CHANNEL_PAIRS; i++) {
        expect(v[i]?.gate).toBe(0);
      }
    }
  });
});

describe('poly: chordVoicing maj triad = root + M3 + P5 + octave', () => {
  it('a4 maj = a4 / c#5 / e5 / a5', () => {
    // a4 = MIDI 69; +4 = 73 (c#5); +7 = 76 (e5); +12 = 81 (a5).
    const v = chordVoicing(69, 'maj');
    expect(v[0]).toEqual({ midi: 69, gate: 1 });
    expect(v[1]).toEqual({ midi: 73, gate: 1 });
    expect(v[2]).toEqual({ midi: 76, gate: 1 });
    expect(v[3]).toEqual({ midi: 81, gate: 1 });
    expect(v[4]).toEqual({ midi: null, gate: 0 });
    // Sharp-only spelling: noteNameForMidi(73) must be 'c#5', not 'db5'.
    expect(noteNameForMidi(73)).toBe('c#5');
  });

  it('c4 maj = c4 / e4 / g4 / c5', () => {
    const v = chordVoicing(60, 'maj');
    expect(v[0]?.midi).toBe(60);
    expect(v[1]?.midi).toBe(64);
    expect(v[2]?.midi).toBe(67);
    expect(v[3]?.midi).toBe(72);
  });

  it('every base in range emits a valid 3rd / 5th when in range', () => {
    for (let m = MIN_MIDI; m + 7 <= MAX_MIDI; m++) {
      const v = chordVoicing(m, 'maj');
      expect(v[1]?.midi).toBe(m + 4);
      expect(v[2]?.midi).toBe(m + 7);
    }
  });

  it('octave doubling drops to gate=0 when out of range', () => {
    // f#7 = MIDI 102. +12 = 114 = MAX_MIDI (still in range). +12 from 103 = 115 (out).
    const v103 = chordVoicing(103, 'maj');
    expect(v103[3]?.gate).toBe(0);
    expect(v103[3]?.midi).toBeNull();
    // 3rd / 5th still play.
    expect(v103[1]?.midi).toBe(107);
    expect(v103[2]?.midi).toBe(110);
  });

  it('5th drops when out of range; 3rd still plays', () => {
    // m=108: +7 = 115 (out), +4 = 112 (in).
    const v = chordVoicing(108, 'maj');
    expect(v[1]?.midi).toBe(112);
    expect(v[2]?.gate).toBe(0);
    expect(v[3]?.gate).toBe(0); // octave also out
  });
});

describe('poly: chordVoicing min triad = root + m3 + P5 + octave', () => {
  it('a4 min = a4 / c5 / e5 / a5', () => {
    const v = chordVoicing(69, 'min');
    expect(v[0]?.midi).toBe(69);
    expect(v[1]?.midi).toBe(72); // c5 (m3)
    expect(v[2]?.midi).toBe(76); // e5
    expect(v[3]?.midi).toBe(81); // a5
    expect(v[4]?.gate).toBe(0);
  });

  it('Bb chord = a# chord (sharp-only spelling); a#3 min = a#3 / c#4 / f4 / a#4', () => {
    // 'a#3' = MIDI 58. min: 58/61(c#4)/65(f4)/70(a#4).
    const v = chordVoicing(58, 'min');
    expect(v[0]?.midi).toBe(58);
    expect(v[1]?.midi).toBe(61);
    expect(v[2]?.midi).toBe(65);
    expect(v[3]?.midi).toBe(70);
    // Confirm the sharp-only spelling still holds for the 3rd:
    expect(noteNameForMidi(61)).toBe('c#4');
  });

  it('every base in range emits root + m3 (3 semitones)', () => {
    for (let m = MIN_MIDI; m + 7 <= MAX_MIDI; m++) {
      const v = chordVoicing(m, 'min');
      expect(v[1]?.midi).toBe(m + 3);
      expect(v[2]?.midi).toBe(m + 7);
    }
  });
});

describe('poly: voicingToVOct converts MIDI -> V/oct (0V = C4)', () => {
  it('a4 maj triad pitches in V/oct', () => {
    const v = chordVoicing(69, 'maj');
    const out = voicingToVOct(v);
    // a4 V/oct = (69-60)/12 = 0.75. c#5 = 13/12. e5 = 16/12. a5 = 21/12.
    expect(out[0]?.pitch).toBeCloseTo(midiToVOct(69), 12);
    expect(out[1]?.pitch).toBeCloseTo(midiToVOct(73), 12);
    expect(out[2]?.pitch).toBeCloseTo(midiToVOct(76), 12);
    expect(out[3]?.pitch).toBeCloseTo(midiToVOct(81), 12);
    expect(out[4]?.gate).toBe(0);
  });

  it('silent lanes emit pitch=0', () => {
    const v = chordVoicing(60, 'mono');
    const out = voicingToVOct(v);
    expect(out[0]).toEqual({ pitch: 0, gate: 1 }); // C4 = 0V
    expect(out[1]).toEqual({ pitch: 0, gate: 0 });
    expect(out[4]).toEqual({ pitch: 0, gate: 0 });
  });
});

describe('poly: resolveConnection backward-compat rules', () => {
  it('poly -> poly: direct passthrough (no splitter/merger)', () => {
    const r = resolveConnection('polyPitchGate', 'polyPitchGate');
    expect(r.needSplitter).toBe(false);
    expect(r.needMerger).toBe(false);
    expect(r.needGateSum).toBe(false);
  });

  it('poly -> mono pitch: lane 0 pitch (channel 0)', () => {
    const r = resolveConnection('polyPitchGate', 'pitch');
    expect(r.needSplitter).toBe(true);
    expect(r.splitChannels).toEqual([0]);
    expect(r.needGateSum).toBe(false);
  });

  it('poly -> mono cv: lane 0 (channel 0)', () => {
    const r = resolveConnection('polyPitchGate', 'cv');
    expect(r.needSplitter).toBe(true);
    expect(r.splitChannels).toEqual([0]);
  });

  it('poly -> mono audio: lane 0 (channel 0)', () => {
    const r = resolveConnection('polyPitchGate', 'audio');
    expect(r.needSplitter).toBe(true);
    expect(r.splitChannels).toEqual([0]);
  });

  it('poly -> mono gate: OR-sum of all 5 lane gate channels', () => {
    const r = resolveConnection('polyPitchGate', 'gate');
    expect(r.needSplitter).toBe(true);
    expect(r.needGateSum).toBe(true);
    // Channels 1, 3, 5, 7, 9 are the gate channels (lane*2+1).
    expect(r.splitChannels).toEqual([1, 3, 5, 7, 9]);
  });

  it('mono pitch -> poly: drive merger input 0 (lane 0 pitch)', () => {
    const r = resolveConnection('pitch', 'polyPitchGate');
    expect(r.needMerger).toBe(true);
    expect(r.mergeInputs).toEqual([0]);
  });

  it('mono gate -> poly: drive merger input 1 (lane 0 gate)', () => {
    const r = resolveConnection('gate', 'polyPitchGate');
    expect(r.needMerger).toBe(true);
    expect(r.mergeInputs).toEqual([1]);
  });

  it('audio -> poly: drive lane 0 pitch (merger input 0)', () => {
    const r = resolveConnection('audio', 'polyPitchGate');
    expect(r.needMerger).toBe(true);
    expect(r.mergeInputs).toEqual([0]);
  });

  it('cv -> poly: drive lane 0 pitch', () => {
    const r = resolveConnection('cv', 'polyPitchGate');
    expect(r.needMerger).toBe(true);
    expect(r.mergeInputs).toEqual([0]);
  });

  it('mono -> mono: direct connect (no special wiring)', () => {
    const r = resolveConnection('pitch', 'pitch');
    expect(r.needSplitter).toBe(false);
    expect(r.needMerger).toBe(false);
    expect(r.needGateSum).toBe(false);
  });

  it('rule strings reference the chosen route (smoke test)', () => {
    expect(resolveConnection('polyPitchGate', 'gate').rule).toContain('OR-sum');
    expect(resolveConnection('polyPitchGate', 'pitch').rule).toContain('lane 0');
    expect(resolveConnection('pitch', 'polyPitchGate').rule).toContain('lane 0');
  });
});
