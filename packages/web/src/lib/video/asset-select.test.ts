// packages/web/src/lib/video/asset-select.test.ts
//
// Pure mapping tests for the 7-slot asset selector shared by PICTUREBOX +
// VIDEOVARISPEED. This is the CORE of the feature: note/V-oct → slot. White
// keys (C-major degrees) map across ALL octaves; black keys map to null.

import { describe, expect, it } from 'vitest';
import {
  ASSET_SLOTS,
  ASSET_SLOT_NOTES,
  ASSET_SLOT_LABELS,
  slotForMidi,
  slotForVOct,
} from './asset-select';
import { midiToVOct, vOctToMidi } from '$lib/audio/note-entry';

describe('asset-select — constants', () => {
  it('declares 7 slots', () => {
    expect(ASSET_SLOTS).toBe(7);
    expect(ASSET_SLOT_NOTES).toHaveLength(7);
    expect(ASSET_SLOT_LABELS).toHaveLength(7);
  });

  it('slot notes are the C-major degrees C3..B3 (48,50,52,53,55,57,59)', () => {
    expect([...ASSET_SLOT_NOTES]).toEqual([48, 50, 52, 53, 55, 57, 59]);
  });

  it('slot labels are C D E F G A B', () => {
    expect([...ASSET_SLOT_LABELS]).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B']);
  });
});

describe('slotForMidi — default-clip rows map one-to-one', () => {
  it('the 7 default-clip rows (C3..B3) drive slots 1..7 in order', () => {
    ASSET_SLOT_NOTES.forEach((midi, i) => {
      expect(slotForMidi(midi), `midi ${midi} → slot ${i}`).toBe(i);
    });
  });
});

describe('slotForMidi — white keys map by pitch class across ALL octaves', () => {
  // For each white-key pitch class, sweep every octave in range and assert
  // the same slot comes back (octave-independent matching).
  const cases: Array<{ pc: number; slot: number; label: string }> = [
    { pc: 0, slot: 0, label: 'C' },
    { pc: 2, slot: 1, label: 'D' },
    { pc: 4, slot: 2, label: 'E' },
    { pc: 5, slot: 3, label: 'F' },
    { pc: 7, slot: 4, label: 'G' },
    { pc: 9, slot: 5, label: 'A' },
    { pc: 11, slot: 6, label: 'B' },
  ];
  for (const { pc, slot, label } of cases) {
    it(`${label} (pc ${pc}) → slot ${slot} in every octave`, () => {
      for (let octBase = 0; octBase <= 120; octBase += 12) {
        const midi = octBase + pc;
        expect(slotForMidi(midi), `${label} at midi ${midi}`).toBe(slot);
      }
    });
  }
});

describe('slotForMidi — black keys map to null (no slot)', () => {
  // C# D# F# G# A# = pitch classes 1, 3, 6, 8, 10.
  const blackPcs = [1, 3, 6, 8, 10];
  for (const pc of blackPcs) {
    it(`pitch class ${pc} (a black key) → null in every octave`, () => {
      for (let octBase = 0; octBase <= 120; octBase += 12) {
        expect(slotForMidi(octBase + pc), `pc ${pc} at midi ${octBase + pc}`).toBeNull();
      }
    });
  }
});

describe('slotForMidi — rounding + edge cases', () => {
  it('rounds a near-integer MIDI to the nearest semitone (48.4 → C → slot 0)', () => {
    expect(slotForMidi(48.4)).toBe(0);
  });
  it('rounds 47.6 up to 48 (C → slot 0)', () => {
    expect(slotForMidi(47.6)).toBe(0);
  });
  it('returns null for NaN / non-finite input', () => {
    expect(slotForMidi(NaN)).toBeNull();
    expect(slotForMidi(Infinity)).toBeNull();
  });
});

describe('slotForVOct — V/oct conversion (0V = C4 = MIDI 60)', () => {
  it('round-trips through the note-entry util for every slot note', () => {
    ASSET_SLOT_NOTES.forEach((midi, i) => {
      const voct = midiToVOct(midi);
      expect(vOctToMidi(voct), `midi ${midi} round-trip`).toBe(midi);
      expect(slotForVOct(voct), `voct ${voct} → slot ${i}`).toBe(i);
    });
  });

  it('0V (C4) selects slot 0 (C, octave-independent)', () => {
    expect(slotForVOct(0)).toBe(0);
  });

  it('+1V (C5) still selects slot 0 (octave-independent)', () => {
    expect(slotForVOct(1)).toBe(0);
  });

  it('-1V (C3) still selects slot 0', () => {
    expect(slotForVOct(-1)).toBe(0);
  });

  it('a black key in V/oct returns null (C#4 = 1/12 V)', () => {
    expect(slotForVOct(1 / 12)).toBeNull();
  });

  it('returns null for NaN / non-finite V/oct', () => {
    expect(slotForVOct(NaN)).toBeNull();
    expect(slotForVOct(-Infinity)).toBeNull();
  });
});
