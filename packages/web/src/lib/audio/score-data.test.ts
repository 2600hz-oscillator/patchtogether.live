// Unit tests for the SCORE pure-data layer. No AudioContext, no DOM.

import { describe, it, expect } from 'vitest';
import {
  TICKS_PER_BAR,
  TOTAL_BARS,
  C4_MIDI,
  C6_MIDI,
  tickWidth,
  quantizeTick,
  barCapacityRemaining,
  canPlace,
  staffStepToMidi,
  midiToStaffStep,
  dynamicAt,
  notesUnderTie,
  cycleKeySharper,
  cycleKeyFlatter,
  keyAccidentals,
  type ScoreNote,
  type DynamicMarker,
  type Tie,
} from './score-data';

describe('tickWidth', () => {
  it('returns standard tick widths for each duration', () => {
    expect(tickWidth('whole')).toBe(48);
    expect(tickWidth('half')).toBe(24);
    expect(tickWidth('quarter')).toBe(12);
    expect(tickWidth('eighth')).toBe(6);
    expect(tickWidth('triplet8th')).toBe(4);
    expect(tickWidth('16th')).toBe(3);
  });

  it('three triplet-8ths fit exactly into one quarter beat (12 ticks)', () => {
    expect(tickWidth('triplet8th') * 3).toBe(tickWidth('quarter'));
  });
});

describe('quantizeTick', () => {
  it('snaps to the active duration grid', () => {
    expect(quantizeTick(7, '16th')).toBe(6);
    expect(quantizeTick(5, '16th')).toBe(6);
    expect(quantizeTick(13, 'quarter')).toBe(12);
    expect(quantizeTick(5, 'triplet8th')).toBe(4);
  });

  it('clamps to inside the bar', () => {
    expect(quantizeTick(48, 'whole')).toBe(0);
    expect(quantizeTick(60, 'quarter')).toBe(36);
  });
});

describe('barCapacityRemaining', () => {
  function n(bar: number, tick: number, dur: ScoreNote['duration']): ScoreNote {
    return { id: `n-${bar}-${tick}-${dur}`, bar, tick, duration: dur, midi: 60, staffStep: 10, accidental: null };
  }

  it('full bar = 0 remaining', () => {
    const notes = [n(0, 0, 'whole')];
    expect(barCapacityRemaining(0, notes)).toBe(0);
  });

  it('two halves fill a bar', () => {
    const notes = [n(0, 0, 'half'), n(0, 24, 'half')];
    expect(barCapacityRemaining(0, notes)).toBe(0);
  });

  it('partial fill leaves the remaining ticks', () => {
    const notes = [n(0, 0, 'quarter'), n(0, 12, 'eighth')];
    expect(barCapacityRemaining(0, notes)).toBe(TICKS_PER_BAR - 12 - 6);
  });

  it('does not count notes from other bars', () => {
    const notes = [n(0, 0, 'whole'), n(1, 0, 'quarter')];
    expect(barCapacityRemaining(1, notes)).toBe(TICKS_PER_BAR - 12);
  });
});

describe('canPlace', () => {
  function n(bar: number, tick: number, dur: ScoreNote['duration'], midi = 60): ScoreNote {
    return { id: `n-${bar}-${tick}-${dur}`, bar, tick, duration: dur, midi, staffStep: 10, accidental: null };
  }

  it('rejects bar overflow', () => {
    expect(canPlace(0, 36, 'whole', 60, [])).toBe(false);
    expect(canPlace(0, 0, 'whole', 60, [])).toBe(true);
  });

  it('rejects overlap with an existing note', () => {
    const notes = [n(0, 0, 'half')];
    expect(canPlace(0, 12, 'quarter', 60, notes)).toBe(false);
    expect(canPlace(0, 24, 'quarter', 60, notes)).toBe(true);
  });

  it('rejects out-of-range pitch (below C4 or above C6)', () => {
    expect(canPlace(0, 0, 'quarter', C4_MIDI - 1, [])).toBe(false);
    expect(canPlace(0, 0, 'quarter', C6_MIDI + 1, [])).toBe(false);
    expect(canPlace(0, 0, 'quarter', C4_MIDI, [])).toBe(true);
    expect(canPlace(0, 0, 'quarter', C6_MIDI, [])).toBe(true);
  });

  it('rejects out-of-bound bar', () => {
    expect(canPlace(-1, 0, 'quarter', 60, [])).toBe(false);
    expect(canPlace(TOTAL_BARS, 0, 'quarter', 60, [])).toBe(false);
  });

  it('excludeId allows a moving note to skip self-collision', () => {
    const notes = [n(0, 0, 'half'), n(0, 24, 'half')];
    expect(canPlace(0, 0, 'half', 60, notes, notes[0]!.id)).toBe(true);
    expect(canPlace(0, 0, 'half', 60, notes)).toBe(false);
  });
});

describe('staffStepToMidi', () => {
  it('top staff line is F5 in C major', () => {
    // step 0 = top line = F5 (MIDI 77) by default
    expect(staffStepToMidi(0, 0, null)).toBe(77);
  });

  it('top staff line is F#5 in G major (1 sharp)', () => {
    expect(staffStepToMidi(0, 1, null)).toBe(78);
  });

  it('per-note natural override on F line in G major plays F natural', () => {
    expect(staffStepToMidi(0, 1, 'natural')).toBe(77);
  });

  it('per-note sharp on a step adds +1 over natural', () => {
    // step 5 = A4 (69); +sharp = A#4 (70)
    expect(staffStepToMidi(5, 0, 'sharp')).toBe(70);
  });

  it('flat key signatures take effect on B/E/A/...', () => {
    // step 4 = B4 (71); in F major (-1) B is flat → 70
    expect(staffStepToMidi(4, -1, null)).toBe(70);
    // E5 (step 1) in B-flat major (-2) → 75 (Eb5)
    expect(staffStepToMidi(1, -2, null)).toBe(75);
  });

  it('clamping outside C4..C6 is the caller\'s responsibility — but C4 maps correctly', () => {
    // step 10 = C4 (60)
    expect(staffStepToMidi(10, 0, null)).toBe(60);
  });
});

describe('midiToStaffStep', () => {
  it('round-trips on naturals in C major', () => {
    for (const m of [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77]) {
      const step = midiToStaffStep(m);
      expect(staffStepToMidi(step, 0, null)).toBe(m);
    }
  });
});

describe('keyAccidentals', () => {
  it('G major (1 sharp) has F#', () => {
    const { sharps, flats } = keyAccidentals(1);
    expect(sharps.has('f')).toBe(true);
    expect(flats.size).toBe(0);
  });

  it('F major (1 flat) has Bb', () => {
    const { sharps, flats } = keyAccidentals(-1);
    expect(flats.has('b')).toBe(true);
    expect(sharps.size).toBe(0);
  });

  it('B-flat major has 2 flats: Bb, Eb', () => {
    const { flats } = keyAccidentals(-2);
    expect(flats.has('b')).toBe(true);
    expect(flats.has('e')).toBe(true);
  });
});

describe('dynamicAt forward-fill', () => {
  function dyn(bar: number, tick: number, level: DynamicMarker['level']): DynamicMarker {
    return { id: `dyn-${bar}-${tick}-${level}`, bar, tick, level };
  }

  it('returns mf when no markers precede the position', () => {
    expect(dynamicAt(0, 0, [])).toBe('mf');
    expect(dynamicAt(0, 0, [dyn(2, 0, 'ff')])).toBe('mf');
  });

  it('uses the most recent marker at-or-before the position', () => {
    const dyns = [dyn(0, 0, 'p'), dyn(2, 0, 'f'), dyn(4, 0, 'pp')];
    expect(dynamicAt(0, 0, dyns)).toBe('p');
    expect(dynamicAt(1, 0, dyns)).toBe('p');
    expect(dynamicAt(2, 0, dyns)).toBe('f');
    expect(dynamicAt(3, 47, dyns)).toBe('f');
    expect(dynamicAt(7, 0, dyns)).toBe('pp');
  });

  it('within-bar tick ordering is honored', () => {
    const dyns = [dyn(0, 0, 'p'), dyn(0, 24, 'ff')];
    expect(dynamicAt(0, 12, dyns)).toBe('p');
    expect(dynamicAt(0, 24, dyns)).toBe('ff');
    expect(dynamicAt(0, 36, dyns)).toBe('ff');
  });
});

describe('notesUnderTie', () => {
  function n(id: string, bar: number, tick: number): ScoreNote {
    return { id, bar, tick, duration: 'quarter', midi: 60, staffStep: 10, accidental: null };
  }

  it('returns just the endpoints when adjacent', () => {
    const a = n('a', 0, 0);
    const b = n('b', 0, 12);
    const tie: Tie = { id: 't', fromNoteId: 'a', toNoteId: 'b' };
    const span = notesUnderTie(tie, [a, b]);
    expect(span.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('returns endpoints + every note between, ordered', () => {
    const a = n('a', 0, 0);
    const m = n('m', 0, 12);
    const c = n('c', 0, 24);
    const tie: Tie = { id: 't', fromNoteId: 'a', toNoteId: 'c' };
    const span = notesUnderTie(tie, [c, m, a]);
    expect(span.map((x) => x.id)).toEqual(['a', 'm', 'c']);
  });

  it('handles tie endpoints in either user-click order', () => {
    const a = n('a', 0, 0);
    const c = n('c', 1, 0);
    const tie: Tie = { id: 't', fromNoteId: 'c', toNoteId: 'a' };
    const span = notesUnderTie(tie, [a, c]);
    expect(span.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('returns empty if either endpoint is missing', () => {
    const a = n('a', 0, 0);
    const tie: Tie = { id: 't', fromNoteId: 'a', toNoteId: 'missing' };
    expect(notesUnderTie(tie, [a])).toEqual([]);
  });
});

describe('triplet group fits in beat', () => {
  it('three triplet-8ths at ticks 0, 4, 8 fit into a single quarter (12 ticks)', () => {
    const notes: ScoreNote[] = [];
    function add(tick: number) {
      // canPlace must return true for each in turn.
      const ok = canPlace(0, tick, 'triplet8th', 60, notes);
      expect(ok).toBe(true);
      notes.push({ id: `t-${tick}`, bar: 0, tick, duration: 'triplet8th', midi: 60, staffStep: 5, accidental: null });
    }
    add(0); add(4); add(8);
    // With three triplet-8ths in place (12 ticks used), capacity remaining is 36.
    expect(barCapacityRemaining(0, notes)).toBe(36);
    // A 4th triplet at tick 12 should still fit (it's the *next* beat).
    const ok = canPlace(0, 12, 'triplet8th', 60, notes);
    expect(ok).toBe(true);
  });
});

describe('cycle key signature', () => {
  it('sharp tool advances one step toward sharps', () => {
    expect(cycleKeySharper(0)).toBe(1);
    expect(cycleKeySharper(6)).toBe(7);
    expect(cycleKeySharper(7)).toBe(7);
    expect(cycleKeySharper(-1)).toBe(0);
  });

  it('flat tool advances one step toward flats', () => {
    expect(cycleKeyFlatter(0)).toBe(-1);
    expect(cycleKeyFlatter(-7)).toBe(-7);
    expect(cycleKeyFlatter(2)).toBe(1);
  });
});
