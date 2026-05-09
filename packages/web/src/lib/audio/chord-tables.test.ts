// packages/web/src/lib/audio/chord-tables.test.ts
//
// Unit tests for the pure chord-table helpers used by POLYSEQZ.

import { describe, it, expect } from 'vitest';
import {
  CHORD_QUALITY_NAMES,
  CHORD_VOICING_NAMES,
  VOICE_LANES,
  applyInversion,
  chordIntervals,
  chordToVoices,
  nextChordQualityName,
  nextChordVoicingName,
  nextInversion,
  type ChordQualityName,
} from './chord-tables';
import { MAX_MIDI } from './note-entry';

describe('chord-tables: quality interval lookup', () => {
  it('every named quality has at least 3 tones starting at 0 (root)', () => {
    for (const q of CHORD_QUALITY_NAMES) {
      const ivs = chordIntervals(q);
      expect(ivs.length).toBeGreaterThanOrEqual(3);
      expect(ivs[0]).toBe(0);
    }
  });

  it('triad-only qualities have exactly 3 tones; 7th qualities have 4', () => {
    expect(chordIntervals('maj').length).toBe(3);
    expect(chordIntervals('min').length).toBe(3);
    expect(chordIntervals('sus2').length).toBe(3);
    expect(chordIntervals('sus4').length).toBe(3);
    expect(chordIntervals('dim').length).toBe(3);
    expect(chordIntervals('aug').length).toBe(3);
    expect(chordIntervals('maj7').length).toBe(4);
    expect(chordIntervals('min7').length).toBe(4);
    expect(chordIntervals('dom7').length).toBe(4);
  });

  it('maj = 0/4/7, min = 0/3/7, dim = 0/3/6, aug = 0/4/8', () => {
    expect([...chordIntervals('maj')]).toEqual([0, 4, 7]);
    expect([...chordIntervals('min')]).toEqual([0, 3, 7]);
    expect([...chordIntervals('dim')]).toEqual([0, 3, 6]);
    expect([...chordIntervals('aug')]).toEqual([0, 4, 8]);
  });

  it('sus2 = 0/2/7, sus4 = 0/5/7', () => {
    expect([...chordIntervals('sus2')]).toEqual([0, 2, 7]);
    expect([...chordIntervals('sus4')]).toEqual([0, 5, 7]);
  });

  it('maj7/min7/dom7 share root+5th but differ on 3rd + 7th', () => {
    expect([...chordIntervals('maj7')]).toEqual([0, 4, 7, 11]);
    expect([...chordIntervals('min7')]).toEqual([0, 3, 7, 10]);
    expect([...chordIntervals('dom7')]).toEqual([0, 4, 7, 10]);
  });
});

describe('chord-tables: applyInversion', () => {
  it('inversion=0 returns the same intervals', () => {
    expect(applyInversion([0, 4, 7], 0)).toEqual([0, 4, 7]);
  });

  it('inversion=1 lifts the root by an octave', () => {
    // maj triad first inversion: 4, 7, 12 (was 0, 4, 7).
    expect(applyInversion([0, 4, 7], 1)).toEqual([4, 7, 12]);
  });

  it('inversion=2 lifts root + 3rd by an octave', () => {
    // 7, 12, 16
    expect(applyInversion([0, 4, 7], 2)).toEqual([7, 12, 16]);
  });

  it('works on 4-note chords', () => {
    // dom7 inv1: 4, 7, 10, 12
    expect(applyInversion([0, 4, 7, 10], 1)).toEqual([4, 7, 10, 12]);
  });

  it('clamps inversion >= length-1', () => {
    // Triad 2nd inv (max meaningful) — anything higher should still produce
    // a valid 3-element array.
    const out = applyInversion([0, 4, 7], 2);
    expect(out.length).toBe(3);
  });
});

describe('chord-tables: chordToVoices — empty / null root', () => {
  it('null root => 5 silent lanes', () => {
    const v = chordToVoices(null, 'maj', 0, 'closed');
    expect(v.length).toBe(VOICE_LANES);
    for (const lane of v) {
      expect(lane.gate).toBe(0);
      expect(lane.midi).toBeNull();
    }
  });

  it('NaN root => 5 silent lanes', () => {
    const v = chordToVoices(NaN, 'maj', 0, 'closed');
    for (const lane of v) expect(lane.gate).toBe(0);
  });
});

describe('chord-tables: chordToVoices — closed voicing', () => {
  it('c4 maj closed => c4/e4/g4 + 2 octave doublings (c5, e5)', () => {
    const v = chordToVoices(60, 'maj', 0, 'closed');
    // First three lanes are the triad.
    expect(v[0]?.midi).toBe(60);
    expect(v[1]?.midi).toBe(64);
    expect(v[2]?.midi).toBe(67);
    // Lane 3 + 4 = octave doublings (root+12, then 3rd+12).
    expect(v[3]?.midi).toBe(72);
    expect(v[4]?.midi).toBe(76);
    for (const lane of v) expect(lane.gate).toBe(1);
  });

  it('c4 dom7 closed => c4/e4/g4/bb4 + root octave', () => {
    const v = chordToVoices(60, 'dom7', 0, 'closed');
    expect(v[0]?.midi).toBe(60);
    expect(v[1]?.midi).toBe(64);
    expect(v[2]?.midi).toBe(67);
    expect(v[3]?.midi).toBe(70);
    expect(v[4]?.midi).toBe(72); // root + 12
  });

  it('out-of-range octave doublings drop to gate=0', () => {
    // Root near top of MIDI: octave doubling exceeds MAX_MIDI.
    const v = chordToVoices(MAX_MIDI - 5, 'maj', 0, 'closed');
    // Triad in range.
    expect(v[0]?.gate).toBe(1);
    // Octave doublings out of range.
    let droppedCount = 0;
    for (let i = 3; i < VOICE_LANES; i++) {
      if (v[i]?.gate === 0) droppedCount++;
    }
    expect(droppedCount).toBeGreaterThan(0);
  });
});

describe('chord-tables: chordToVoices — open voicing', () => {
  it('c4 maj open drops the 3rd by an octave', () => {
    const v = chordToVoices(60, 'maj', 0, 'open');
    // Open: contains e3 (52), c4 (60), g4 (67), c5 (72).
    const midis = v.filter((l) => l.gate === 1).map((l) => l.midi);
    expect(midis).toContain(52); // dropped 3rd
    expect(midis).toContain(60);
    expect(midis).toContain(67);
    expect(midis).toContain(72);
    // Open voicing's 5th lane may be silent for triads.
    expect(v.length).toBe(VOICE_LANES);
  });

  it('c4 maj7 open includes the 7th', () => {
    const v = chordToVoices(60, 'maj7', 0, 'open');
    const midis = v.filter((l) => l.gate === 1).map((l) => l.midi);
    expect(midis).toContain(71); // b4 (M7)
  });
});

describe('chord-tables: chordToVoices — spread voicing', () => {
  it('c4 maj spread => triad + root+12 + 5th+12', () => {
    const v = chordToVoices(60, 'maj', 0, 'spread');
    expect(v.length).toBe(VOICE_LANES);
    const midis = v.filter((l) => l.gate === 1).map((l) => l.midi);
    expect(midis).toContain(60);
    expect(midis).toContain(64);
    expect(midis).toContain(67);
    expect(midis).toContain(72); // root octave
    expect(midis).toContain(79); // 5th octave
  });

  it('c4 maj7 spread => 4-note chord + root+12', () => {
    const v = chordToVoices(60, 'maj7', 0, 'spread');
    const midis = v.filter((l) => l.gate === 1).map((l) => l.midi);
    expect(midis).toContain(60);
    expect(midis).toContain(64);
    expect(midis).toContain(67);
    expect(midis).toContain(71); // M7
    expect(midis).toContain(72); // root+12
  });
});

describe('chord-tables: chordToVoices — inversion math', () => {
  it('c4 maj inv1 lifts root by an octave (e4/g4/c5)', () => {
    const v = chordToVoices(60, 'maj', 1, 'closed');
    // After inversion: lowest tone is e4 (64), then g4 (67), then c5 (72).
    expect(v[0]?.midi).toBe(64);
    expect(v[1]?.midi).toBe(67);
    expect(v[2]?.midi).toBe(72);
  });

  it('c4 maj inv2 lifts root + 3rd (g4/c5/e5)', () => {
    const v = chordToVoices(60, 'maj', 2, 'closed');
    expect(v[0]?.midi).toBe(67);
    expect(v[1]?.midi).toBe(72);
    expect(v[2]?.midi).toBe(76);
  });
});

describe('chord-tables: cycle helpers', () => {
  it('nextChordQualityName cycles through CHORD_QUALITY_NAMES', () => {
    let cur: ChordQualityName | undefined = undefined;
    const seen = new Set<ChordQualityName>();
    for (let i = 0; i < CHORD_QUALITY_NAMES.length + 1; i++) {
      const next = nextChordQualityName(cur);
      seen.add(next);
      cur = next;
    }
    expect(seen.size).toBe(CHORD_QUALITY_NAMES.length);
  });

  it('nextChordVoicingName covers closed/open/spread', () => {
    const seen = new Set();
    let cur = nextChordVoicingName(undefined);
    seen.add(cur);
    for (let i = 0; i < CHORD_VOICING_NAMES.length; i++) {
      cur = nextChordVoicingName(cur);
      seen.add(cur);
    }
    expect(seen.size).toBe(CHORD_VOICING_NAMES.length);
  });

  it('nextInversion: 0 → 1 → 2 → 0', () => {
    expect(nextInversion(0)).toBe(1);
    expect(nextInversion(1)).toBe(2);
    expect(nextInversion(2)).toBe(0);
  });
});
