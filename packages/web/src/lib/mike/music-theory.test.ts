// packages/web/src/lib/mike/music-theory.test.ts
//
// Mike's music-theory unit. Tiny + pure — easy to test exhaustively.

import { describe, expect, it } from 'vitest';
import {
  generateChordToneMelody,
  generateInKeyNotes,
  isInKey,
  pickKey,
  findClockSource,
  isSequencerType,
  MAJOR_SCALE_STEPS,
  MINOR_SCALE_STEPS,
  PENTATONIC_SCALE_STEPS,
  DORIAN_SCALE_STEPS,
  PHRYGIAN_SCALE_STEPS,
  MIXOLYDIAN_SCALE_STEPS,
} from './music-theory';

const determRand = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 0x100000000;
    return s / 0x100000000;
  };
};

describe('music-theory: scale + key picker', () => {
  it('major scale steps are the canonical [0,2,4,5,7,9,11]', () => {
    expect(MAJOR_SCALE_STEPS).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it('pentatonic has 5 notes', () => {
    expect(PENTATONIC_SCALE_STEPS.length).toBe(5);
  });

  it('the three added modes are the canonical semitone sets', () => {
    expect(DORIAN_SCALE_STEPS).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(PHRYGIAN_SCALE_STEPS).toEqual([0, 1, 3, 5, 7, 8, 10]);
    expect(MIXOLYDIAN_SCALE_STEPS).toEqual([0, 2, 4, 5, 7, 9, 10]);
  });

  it('the modes are 7-note scales that differ from major/minor by one degree', () => {
    // Dorian = minor with a raised 6th (9 vs 8); Mixolydian = major with a
    // lowered 7th (10 vs 11); Phrygian = minor with a lowered 2nd (1 vs 2).
    for (const s of [DORIAN_SCALE_STEPS, PHRYGIAN_SCALE_STEPS, MIXOLYDIAN_SCALE_STEPS]) {
      expect(s).toHaveLength(7);
      expect(s[0]).toBe(0); // rooted
      expect(new Set(s).size).toBe(7); // no duplicate degrees
    }
    expect(DORIAN_SCALE_STEPS).not.toEqual(MINOR_SCALE_STEPS);
    expect(MIXOLYDIAN_SCALE_STEPS).not.toEqual(MAJOR_SCALE_STEPS);
  });

  it('isInKey honours the new modes (dorian C: A natural in, A♭ out)', () => {
    const cDorian = { root: 0, scale: 'dorian' as const };
    expect(isInKey(9, cDorian)).toBe(true); // A — the raised 6th
    expect(isInKey(8, cDorian)).toBe(false); // A♭ — the natural-minor 6th, out
  });

  it('pickKey returns a valid root + scale', () => {
    const key = pickKey(determRand(1));
    expect(key.root).toBeGreaterThanOrEqual(0);
    expect(key.root).toBeLessThan(12);
    expect(['major', 'minor', 'pentatonic']).toContain(key.scale);
  });

  it('pickKey is deterministic for the same rng', () => {
    const a = pickKey(determRand(42));
    const b = pickKey(determRand(42));
    expect(a).toEqual(b);
  });
});

describe('music-theory: generateInKeyNotes', () => {
  it('every emitted note is in the chosen key', () => {
    const key = { root: 0, scale: 'major' as const }; // C major
    const notes = generateInKeyNotes(key, 50, 60, determRand(7));
    expect(notes).toHaveLength(50);
    for (const n of notes) {
      expect(isInKey(n, key)).toBe(true);
    }
  });

  it('works for non-C keys too', () => {
    const key = { root: 7, scale: 'minor' as const }; // G minor
    const notes = generateInKeyNotes(key, 30, 60, determRand(99));
    for (const n of notes) {
      expect(isInKey(n, key)).toBe(true);
    }
  });

  it('chord-tone melody is a strict subset (root/3rd/5th)', () => {
    const key = { root: 0, scale: 'major' as const };
    const notes = generateChordToneMelody(key, 40, 60, determRand(13));
    const expectedPcs = new Set([0, 4, 7]); // C major triad pitch classes
    for (const n of notes) {
      const pc = ((n - key.root) % 12 + 12) % 12;
      expect(expectedPcs.has(pc)).toBe(true);
    }
  });
});

describe('music-theory: findClockSource', () => {
  it('returns null on an empty rack', () => {
    expect(findClockSource([], [])).toBeNull();
  });

  it('prefers TIMELORDE when present', () => {
    const nodes = [
      { id: 'foo-1', type: 'sequencer' },
      { id: 'lord-1', type: 'timelorde' },
    ];
    const found = findClockSource(nodes, []);
    expect(found?.nodeId).toBe('lord-1');
    expect(found?.portId).toBe('1x');
  });

  it('falls back to an upstream of a sequencer clock when no TIMELORDE', () => {
    const nodes = [
      { id: 'lfo-1', type: 'lfo' },
      { id: 'seq-1', type: 'sequencer' },
    ];
    const edges = [
      {
        id: 'e1',
        source: { nodeId: 'lfo-1', portId: 'out' },
        target: { nodeId: 'seq-1', portId: 'clock' },
      },
    ];
    const found = findClockSource(nodes, edges);
    expect(found?.nodeId).toBe('lfo-1');
    expect(found?.portId).toBe('out');
  });

  it('isSequencerType identifies known sequencer types', () => {
    expect(isSequencerType('sequencer')).toBe(true);
    expect(isSequencerType('polyseqz')).toBe(true);
    expect(isSequencerType('drumseqz')).toBe(true);
    expect(isSequencerType('analogVco')).toBe(false);
    expect(isSequencerType('reverb')).toBe(false);
  });
});
