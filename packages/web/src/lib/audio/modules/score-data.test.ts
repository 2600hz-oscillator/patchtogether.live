// packages/web/src/lib/audio/modules/score-data.test.ts
//
// Pure-data unit tests for the SCORE module. Covers tickWidth,
// barCapacityRemaining, canPlace (overflow + overlap + range),
// staffStepToMidi (key sig + accidentals), dynamicAt, tieSpanNotes,
// triplet packing.

import { describe, expect, it } from 'vitest';
import {
  TICKS_PER_BAR,
  TOTAL_BARS,
  SCORE_MIN_MIDI,
  SCORE_MAX_MIDI,
  barCapacityRemaining,
  canPlace,
  dynamicAt,
  staffStepToMidi,
  tickWidth,
  tieSpanNotes,
  type ScoreNote,
  type DynamicMarker,
} from './score-data';

function note(opts: Partial<ScoreNote> & Pick<ScoreNote, 'bar' | 'tick' | 'duration' | 'midi' | 'staffStep'>): ScoreNote {
  return {
    id: opts.id ?? `${opts.bar}-${opts.tick}`,
    accidental: opts.accidental ?? null,
    ...opts,
  } as ScoreNote;
}

describe('tickWidth', () => {
  it('maps each duration to its tick count', () => {
    expect(tickWidth('whole')).toBe(48);
    expect(tickWidth('half')).toBe(24);
    expect(tickWidth('quarter')).toBe(12);
    expect(tickWidth('eighth')).toBe(6);
    expect(tickWidth('16th')).toBe(3);
    expect(tickWidth('triplet8th')).toBe(4);
  });
});

describe('barCapacityRemaining', () => {
  it('returns full bar capacity when empty', () => {
    expect(barCapacityRemaining(0, [])).toBe(TICKS_PER_BAR);
  });
  it('subtracts placed note widths', () => {
    const notes: ScoreNote[] = [
      note({ bar: 0, tick: 0, duration: 'half', midi: 60, staffStep: 5 }),
      note({ bar: 0, tick: 24, duration: 'quarter', midi: 60, staffStep: 5 }),
    ];
    expect(barCapacityRemaining(0, notes)).toBe(48 - 24 - 12);
  });
  it('ignores notes in other bars', () => {
    const notes: ScoreNote[] = [
      note({ bar: 1, tick: 0, duration: 'whole', midi: 60, staffStep: 5 }),
    ];
    expect(barCapacityRemaining(0, notes)).toBe(TICKS_PER_BAR);
  });
});

describe('canPlace', () => {
  const middleC = 60;
  it('rejects bar overflow', () => {
    const notes: ScoreNote[] = [];
    // Placing a half (24 ticks) at tick 36 -> end = 60 > 48 = overflow.
    expect(canPlace(0, 36, 'half', middleC, notes)).toBe(false);
  });
  it('rejects overlap', () => {
    const notes: ScoreNote[] = [
      note({ bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5 }),
    ];
    // Placing an eighth at tick 6 (overlaps the existing quarter ending at 12).
    expect(canPlace(0, 6, 'eighth', middleC, notes)).toBe(false);
  });
  it('allows abutting notes', () => {
    const notes: ScoreNote[] = [
      note({ bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5 }),
    ];
    // Quarter ends at tick 12; placing an eighth starting at 12 is valid.
    expect(canPlace(0, 12, 'eighth', middleC, notes)).toBe(true);
  });
  it('rejects out-of-range pitch', () => {
    expect(canPlace(0, 0, 'quarter', SCORE_MIN_MIDI - 1, [])).toBe(false);
    expect(canPlace(0, 0, 'quarter', SCORE_MAX_MIDI + 1, [])).toBe(false);
  });
  it('rejects out-of-range bar', () => {
    expect(canPlace(-1, 0, 'quarter', middleC, [])).toBe(false);
    expect(canPlace(TOTAL_BARS, 0, 'quarter', middleC, [])).toBe(false);
  });
  it('respects ignoreNoteId for drag-move scenarios', () => {
    const existing = note({ bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5, id: 'A' });
    // Re-placing the same note at the same spot should pass when its own id
    // is excluded from the overlap check.
    expect(canPlace(0, 0, 'quarter', 60, [existing], 'A')).toBe(true);
  });
});

describe('staffStepToMidi', () => {
  it('C major: top staff line (step 0) -> F5 (MIDI 77)', () => {
    expect(staffStepToMidi(0, 0, null)).toBe(77);
  });
  it('C major: top space (step 1) -> E5 (MIDI 76)', () => {
    expect(staffStepToMidi(1, 0, null)).toBe(76);
  });
  it('C major: bottom staff line (step 8) -> E4 (MIDI 64)', () => {
    expect(staffStepToMidi(8, 0, null)).toBe(64);
  });
  it('G major (1 sharp) raises F-line to F#5', () => {
    expect(staffStepToMidi(0, 1, null)).toBe(78); // F#5
  });
  it('explicit natural in G major returns F5', () => {
    expect(staffStepToMidi(0, 1, 'natural')).toBe(77);
  });
  it('per-note sharp in C major: F-line -> F#5', () => {
    expect(staffStepToMidi(0, 0, 'sharp')).toBe(78);
  });
  it('per-note flat in C major: B-line -> Bb4', () => {
    // step 4 = B4 (line 3 from top = B4); flat -> Bb4 (MIDI 70)
    expect(staffStepToMidi(4, 0, null)).toBe(71); // B4
    expect(staffStepToMidi(4, 0, 'flat')).toBe(70); // Bb4
  });
  it('F major (1 flat): B-line plays as Bb4', () => {
    expect(staffStepToMidi(4, -1, null)).toBe(70); // Bb4 from key-sig
  });
});

describe('dynamicAt forward-fill', () => {
  it('returns mf default when no markers', () => {
    expect(dynamicAt(0, 0, [])).toBe('mf');
  });
  it('returns the latest marker at-or-before (bar, tick)', () => {
    const dyns: DynamicMarker[] = [
      { id: 'a', bar: 0, tick: 0, level: 'p' },
      { id: 'b', bar: 1, tick: 0, level: 'f' },
      { id: 'c', bar: 2, tick: 12, level: 'ff' },
    ];
    expect(dynamicAt(0, 5, dyns)).toBe('p');
    expect(dynamicAt(1, 0, dyns)).toBe('f');
    expect(dynamicAt(1, 30, dyns)).toBe('f');
    expect(dynamicAt(2, 11, dyns)).toBe('f');
    expect(dynamicAt(2, 12, dyns)).toBe('ff');
    expect(dynamicAt(7, 47, dyns)).toBe('ff');
  });
  it('mf when only future markers exist', () => {
    const dyns: DynamicMarker[] = [{ id: 'a', bar: 3, tick: 0, level: 'pp' }];
    expect(dynamicAt(0, 0, dyns)).toBe('mf');
  });
});

describe('tieSpanNotes', () => {
  it('returns notes between fromNoteId and toNoteId in absolute order', () => {
    const notes: ScoreNote[] = [
      note({ id: 'a', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5 }),
      note({ id: 'b', bar: 0, tick: 12, duration: 'quarter', midi: 62, staffStep: 4 }),
      note({ id: 'c', bar: 0, tick: 24, duration: 'quarter', midi: 64, staffStep: 3 }),
      note({ id: 'd', bar: 1, tick: 0, duration: 'quarter', midi: 65, staffStep: 2 }),
    ];
    const span = tieSpanNotes('a', 'c', notes);
    expect(span.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
  it('handles reversed argument order', () => {
    const notes: ScoreNote[] = [
      note({ id: 'a', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5 }),
      note({ id: 'b', bar: 0, tick: 12, duration: 'quarter', midi: 62, staffStep: 4 }),
    ];
    const span = tieSpanNotes('b', 'a', notes);
    expect(span.map((n) => n.id)).toEqual(['a', 'b']);
  });
  it('returns [] for unknown ids', () => {
    expect(tieSpanNotes('x', 'y', [])).toEqual([]);
  });
});

describe('triplet packing', () => {
  it('three triplet-8th notes at 0, 4, 8 fit inside one beat (12 ticks)', () => {
    const notes: ScoreNote[] = [
      note({ id: 'a', bar: 0, tick: 0, duration: 'triplet8th', midi: 60, staffStep: 5 }),
      note({ id: 'b', bar: 0, tick: 4, duration: 'triplet8th', midi: 62, staffStep: 4 }),
    ];
    expect(canPlace(0, 8, 'triplet8th', 64, notes)).toBe(true);
    expect(barCapacityRemaining(0, [
      ...notes,
      note({ id: 'c', bar: 0, tick: 8, duration: 'triplet8th', midi: 64, staffStep: 3 }),
    ])).toBe(TICKS_PER_BAR - 12);
  });
});
