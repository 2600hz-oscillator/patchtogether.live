// packages/web/src/lib/audio/note-entry.test.ts
//
// Unit tests for the note-name parser, canonicalizer, and v1->v2 migration
// helpers used by the Sequencer + Cartesian text-entry pitch input.

import { describe, it, expect } from 'vitest';
import {
  parseNoteName,
  noteNameForMidi,
  midiToVOct,
  vOctToMidi,
  midiToHz,
  coerceToNoteStep,
  migrateStepArrayV1ToV2,
  MIN_MIDI,
  MAX_MIDI,
  C4_MIDI,
  C3_MIDI,
} from './note-entry';
import { defaultSteps } from './modules/sequencer';
import { defaultCells } from './modules/cartesian';

describe('parseNoteName: round-trip across the full a1..f#8 range', () => {
  it('parses every MIDI int from MIN..MAX through its canonical name', () => {
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      const name = noteNameForMidi(m);
      const parsed = parseNoteName(name);
      expect(parsed, `${name} should parse back to ${m}`).toBe(m);
    }
  });

  it('parses critical reference pitches', () => {
    expect(parseNoteName('a1')).toBe(33);
    expect(parseNoteName('c3')).toBe(48);
    expect(parseNoteName('a4')).toBe(69);
    expect(parseNoteName('e6')).toBe(88);
    expect(parseNoteName('f#8')).toBe(114);
    expect(parseNoteName('c4')).toBe(60);
  });
});

describe('parseNoteName: case + whitespace tolerance', () => {
  it('lowercases input', () => {
    expect(parseNoteName('A4')).toBe(69);
    expect(parseNoteName('C#3')).toBe(49);
    expect(parseNoteName('F#8')).toBe(114);
  });

  it('strips whitespace', () => {
    expect(parseNoteName(' a4 ')).toBe(69);
    expect(parseNoteName('a 4')).toBe(69);
    expect(parseNoteName('  c # 3 ')).toBe(49);
  });

  it('accepts flats and converts to the same MIDI int as the sharp form', () => {
    expect(parseNoteName('db4')).toBe(parseNoteName('c#4'));
    expect(parseNoteName('eb4')).toBe(parseNoteName('d#4'));
    expect(parseNoteName('gb4')).toBe(parseNoteName('f#4'));
    expect(parseNoteName('ab4')).toBe(parseNoteName('g#4'));
    expect(parseNoteName('bb4')).toBe(parseNoteName('a#4'));
  });
});

describe('parseNoteName: invalid input returns null', () => {
  it('rejects empty / whitespace-only', () => {
    expect(parseNoteName('')).toBeNull();
    expect(parseNoteName(' ')).toBeNull();
    expect(parseNoteName('\t\n')).toBeNull();
  });

  it('rejects nonsense characters', () => {
    expect(parseNoteName('c$')).toBeNull();
    expect(parseNoteName('q7')).toBeNull();
    expect(parseNoteName('h4')).toBeNull();
    expect(parseNoteName('@a4')).toBeNull();
    expect(parseNoteName('a4!')).toBeNull();
  });

  it('rejects missing octave', () => {
    expect(parseNoteName('a')).toBeNull();
    expect(parseNoteName('c#')).toBeNull();
    expect(parseNoteName('eb')).toBeNull();
  });

  it('rejects out-of-range octaves (parsed but out of [a1, f#8])', () => {
    expect(parseNoteName('c1')).toBeNull(); // below a1 (MIDI 24 < 33)
    expect(parseNoteName('g#0')).toBeNull();
    expect(parseNoteName('g8')).toBeNull(); // above f#8
    expect(parseNoteName('c9')).toBeNull();
    expect(parseNoteName('c15')).toBeNull();
    expect(parseNoteName('c-1')).toBeNull();
  });

  it('rejects double-accidentals + non-numeric octave', () => {
    expect(parseNoteName('a##4')).toBeNull();
    expect(parseNoteName('cbb4')).toBeNull();
    expect(parseNoteName('a#x')).toBeNull();
    expect(parseNoteName('a4.5')).toBeNull();
  });

  it('rejects non-string input gracefully', () => {
    // @ts-expect-error testing runtime guard
    expect(parseNoteName(undefined)).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(parseNoteName(null)).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(parseNoteName(42)).toBeNull();
  });
});

describe('noteNameForMidi: canonical sharp form, lowercase', () => {
  it('returns sharps not flats', () => {
    expect(noteNameForMidi(49)).toBe('c#3');
    expect(noteNameForMidi(70)).toBe('a#4');
    expect(noteNameForMidi(114)).toBe('f#8');
  });

  it('returns naturals untouched', () => {
    expect(noteNameForMidi(33)).toBe('a1');
    expect(noteNameForMidi(48)).toBe('c3');
    expect(noteNameForMidi(60)).toBe('c4');
    expect(noteNameForMidi(69)).toBe('a4');
  });

  it('returns empty string outside the supported range', () => {
    expect(noteNameForMidi(0)).toBe('');
    expect(noteNameForMidi(32)).toBe('');
    expect(noteNameForMidi(115)).toBe('');
    expect(noteNameForMidi(127)).toBe('');
    expect(noteNameForMidi(NaN)).toBe('');
  });
});

describe('midiToVOct / vOctToMidi: codebase convention (0V = C4 = MIDI 60)', () => {
  it('places C4 at 0V', () => {
    expect(midiToVOct(60)).toBe(0);
  });

  it('1 octave up = +1V', () => {
    expect(midiToVOct(72)).toBeCloseTo(1.0, 12);
    expect(midiToVOct(48)).toBeCloseTo(-1.0, 12);
  });

  it('round-trips MIDI -> V/oct -> MIDI', () => {
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      expect(vOctToMidi(midiToVOct(m))).toBe(m);
    }
  });
});

describe('midiToHz: equal-tempered (A4 = 440Hz)', () => {
  it('matches the spec reference frequencies', () => {
    expect(midiToHz(33)).toBeCloseTo(55.0, 3);       // a1
    expect(midiToHz(48)).toBeCloseTo(130.813, 2);    // c3
    expect(midiToHz(69)).toBe(440);                  // a4 (exact)
    expect(midiToHz(88)).toBeCloseTo(1318.510, 2);   // e6
    expect(midiToHz(114)).toBeCloseTo(5919.911, 2);  // f#8
  });

  it('matches the analog-vco DSP convention (0V = C4 = 261.626 Hz)', () => {
    expect(midiToHz(60)).toBeCloseTo(261.626, 2);
  });
});

describe('coerceToNoteStep: legacy + new shape interop', () => {
  it('passes through new shape with valid midi', () => {
    expect(coerceToNoteStep({ on: true, midi: 69 })).toEqual({ on: true, midi: 69 });
    expect(coerceToNoteStep({ on: false, midi: 33 })).toEqual({ on: false, midi: 33 });
  });

  it('preserves explicit null midi', () => {
    expect(coerceToNoteStep({ on: true, midi: null })).toEqual({ on: true, midi: null });
  });

  it('clamps out-of-range midi to null', () => {
    expect(coerceToNoteStep({ on: true, midi: 0 })).toEqual({ on: true, midi: null });
    expect(coerceToNoteStep({ on: true, midi: 200 })).toEqual({ on: true, midi: null });
  });

  it('migrates legacy {pitch: <semitones from C4>} to midi', () => {
    expect(coerceToNoteStep({ on: true, pitch: 0 })).toEqual({ on: true, midi: C4_MIDI });
    expect(coerceToNoteStep({ on: true, pitch: 7 })).toEqual({ on: true, midi: C4_MIDI + 7 });
    expect(coerceToNoteStep({ on: false, pitch: -12 })).toEqual({ on: false, midi: C4_MIDI - 12 });
  });

  it('clamps legacy pitches that fall outside the new range to null', () => {
    // pitch -36 from C4 = MIDI 24, below MIN_MIDI=33
    expect(coerceToNoteStep({ on: true, pitch: -36 })).toEqual({ on: true, midi: null });
    // pitch +60 from C4 = MIDI 120, above MAX_MIDI=114
    expect(coerceToNoteStep({ on: true, pitch: 60 })).toEqual({ on: true, midi: null });
  });

  it('handles missing fields safely', () => {
    expect(coerceToNoteStep({})).toEqual({ on: false, midi: null });
    expect(coerceToNoteStep(null)).toEqual({ on: false, midi: null });
    expect(coerceToNoteStep(undefined)).toEqual({ on: false, midi: null });
    expect(coerceToNoteStep('not-an-object')).toEqual({ on: false, midi: null });
  });
});

describe('default seed pitch is C3 for new modules', () => {
  it('exposes C3_MIDI = 48 = parsed("c3")', () => {
    expect(C3_MIDI).toBe(48);
    expect(parseNoteName('c3')).toBe(C3_MIDI);
    expect(noteNameForMidi(C3_MIDI)).toBe('c3');
  });

  it('Sequencer defaultSteps seeds every step with midi=C3_MIDI', () => {
    // Pre-pages PR this was 32; the sequencer now allocates 128 cells across
    // 8 visible pages. Defaults still seed every cell with C3 + off.
    const steps = defaultSteps();
    expect(steps).toHaveLength(128);
    for (const s of steps) {
      expect(s.midi).toBe(C3_MIDI);
      expect(s.on).toBe(false);
    }
  });

  it('Cartesian defaultCells seeds every cell with midi=C3_MIDI', () => {
    const cells = defaultCells();
    expect(cells).toHaveLength(16);
    for (const c of cells) {
      expect(c.midi).toBe(C3_MIDI);
      expect(c.on).toBe(false);
    }
  });

  it('coerceToNoteStep preserves explicit C3 (48) on legacy reads', () => {
    expect(coerceToNoteStep({ on: true, midi: C3_MIDI })).toEqual({ on: true, midi: 48 });
    expect(coerceToNoteStep({ on: false, pitch: -12 })).toEqual({ on: false, midi: 48 });
  });
});

describe('migrateStepArrayV1ToV2', () => {
  it('migrates a sequencer steps array', () => {
    const v1 = {
      steps: [
        { on: true, pitch: 0 },
        { on: true, pitch: 7 },
        { on: false, pitch: 0 },
        { on: true, pitch: 12 },
      ],
    };
    const v2 = migrateStepArrayV1ToV2(v1, 'steps') as { steps: Array<{ on: boolean; midi: number | null }> };
    expect(v2.steps[0]).toEqual({ on: true, midi: 60 });
    expect(v2.steps[1]).toEqual({ on: true, midi: 67 });
    expect(v2.steps[2]).toEqual({ on: false, midi: 60 });
    expect(v2.steps[3]).toEqual({ on: true, midi: 72 });
  });

  it('migrates a cartesian cells array', () => {
    const v1 = { cells: [{ on: true, pitch: -12 }, { on: false, pitch: 5 }] };
    const v2 = migrateStepArrayV1ToV2(v1, 'cells') as { cells: Array<{ on: boolean; midi: number | null }> };
    expect(v2.cells[0]).toEqual({ on: true, midi: 48 });
    expect(v2.cells[1]).toEqual({ on: false, midi: 65 });
  });

  it('preserves other top-level fields', () => {
    const v1 = { steps: [], extra: 'keep' };
    const v2 = migrateStepArrayV1ToV2(v1, 'steps') as Record<string, unknown>;
    expect(v2.extra).toBe('keep');
  });

  it('handles missing array safely', () => {
    expect(migrateStepArrayV1ToV2({}, 'steps')).toEqual({});
    expect(migrateStepArrayV1ToV2(undefined, 'steps')).toEqual({});
  });
});
