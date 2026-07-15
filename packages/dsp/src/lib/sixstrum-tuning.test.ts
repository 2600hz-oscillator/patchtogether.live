// packages/dsp/src/lib/sixstrum-tuning.test.ts
import { describe, it, expect } from 'vitest';
import {
  SIXSTRUM_STRINGS,
  SIXSTRUM_TUNINGS,
  SIXSTRUM_QUALITIES,
  TUNING_OPEN_MIDI,
  SIXSTRUM_CHORD_INTERVALS,
  chordPitchClasses,
  voiceChord,
  openStrings,
  tuningForIndex,
  qualityForIndex,
} from './sixstrum-tuning';

const pc = (m: number) => ((m % 12) + 12) % 12;

describe('sixstrum-tuning: tables', () => {
  it('is a 6-string instrument in every tuning', () => {
    expect(SIXSTRUM_STRINGS).toBe(6);
    for (const t of SIXSTRUM_TUNINGS) {
      expect(TUNING_OPEN_MIDI[t]).toHaveLength(SIXSTRUM_STRINGS);
    }
  });

  it('guitar tuning is standard EADGBE (E2..E4)', () => {
    expect(TUNING_OPEN_MIDI.guitar).toEqual([40, 45, 50, 55, 59, 64]);
  });

  it('open strings ascend (low → high) in every tuning', () => {
    for (const t of SIXSTRUM_TUNINGS) {
      const open = TUNING_OPEN_MIDI[t];
      for (let i = 1; i < open.length; i++) expect(open[i]!).toBeGreaterThan(open[i - 1]!);
    }
  });

  it('bass sits well below guitar; harp above bass', () => {
    expect(TUNING_OPEN_MIDI.bass[0]!).toBeLessThan(TUNING_OPEN_MIDI.guitar[0]!);
    expect(TUNING_OPEN_MIDI.harp[5]!).toBeGreaterThanOrEqual(TUNING_OPEN_MIDI.bass[5]!);
  });

  it('every quality interval set starts on the root (0)', () => {
    for (const q of SIXSTRUM_QUALITIES) {
      expect(SIXSTRUM_CHORD_INTERVALS[q][0]).toBe(0);
    }
  });
});

describe('sixstrum-tuning: chordPitchClasses', () => {
  it('C major = {0,4,7}', () => {
    expect(new Set(chordPitchClasses(60, 'maj'))).toEqual(new Set([0, 4, 7]));
  });
  it('A minor = {9,0,4}', () => {
    expect(new Set(chordPitchClasses(69, 'min'))).toEqual(new Set([9, 0, 4]));
  });
  it('power5 = root + fifth only', () => {
    expect(new Set(chordPitchClasses(60, 'power5'))).toEqual(new Set([0, 7]));
  });
  it('octave = root pitch-class only', () => {
    expect(new Set(chordPitchClasses(62, 'octave'))).toEqual(new Set([2]));
  });
  it('is invariant to the root octave (pitch-class based)', () => {
    expect(new Set(chordPitchClasses(48, 'maj'))).toEqual(new Set(chordPitchClasses(72, 'maj')));
  });
});

describe('sixstrum-tuning: voiceChord (nearest chord-tone at/above each open string)', () => {
  it('returns 6 notes, each at/above its open string and within an octave', () => {
    for (const t of SIXSTRUM_TUNINGS) {
      for (const q of SIXSTRUM_QUALITIES) {
        for (const root of [60, 62, 65, 67, 69]) {
          const voiced = voiceChord(root, q, t);
          expect(voiced).toHaveLength(6);
          const open = TUNING_OPEN_MIDI[t];
          const pcs = new Set(chordPitchClasses(root, q));
          for (let i = 0; i < 6; i++) {
            expect(voiced[i]!).toBeGreaterThanOrEqual(open[i]!);
            expect(voiced[i]!).toBeLessThan(open[i]! + 12);
            // Every voiced note is an actual chord tone.
            expect(pcs.has(pc(voiced[i]!))).toBe(true);
          }
        }
      }
    }
  });

  it('C major on guitar voices real chord tones per string', () => {
    // open EADGBE = [40,45,50,55,59,64]; C-maj pcs {0,4,7} = {C,E,G}.
    // nearest at/above each: E2(40,E) A2→B?(no) → C3(48,C)? wait: A2=45(A,no),
    // 46=Bb,47=B,48=C(yes)→48; D3=50(D,no)→E3(52,E); G3=55(G,yes)→55;
    // B3=59(B,no)→C4(60,C); E4=64(E,yes)→64.
    const voiced = voiceChord(60, 'maj', 'guitar');
    expect(voiced).toEqual([40, 48, 52, 55, 60, 64]);
  });

  it('is deterministic', () => {
    expect(voiceChord(67, 'dom7', 'harp')).toEqual(voiceChord(67, 'dom7', 'harp'));
  });

  it('openStrings returns the tuning table', () => {
    expect(openStrings('guitar')).toEqual(TUNING_OPEN_MIDI.guitar);
  });
});

describe('sixstrum-tuning: discrete-index resolvers clamp', () => {
  it('tuningForIndex clamps to range', () => {
    expect(tuningForIndex(0)).toBe('guitar');
    expect(tuningForIndex(2)).toBe('harp');
    expect(tuningForIndex(-5)).toBe('guitar');
    expect(tuningForIndex(99)).toBe('harp');
    expect(tuningForIndex(1.4)).toBe('bass'); // rounds
  });
  it('qualityForIndex clamps to range', () => {
    expect(qualityForIndex(0)).toBe('maj');
    expect(qualityForIndex(7)).toBe('octave');
    expect(qualityForIndex(99)).toBe('octave');
  });
});
