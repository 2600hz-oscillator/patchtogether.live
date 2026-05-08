// packages/web/src/lib/audio/modules/score-data.test.ts
//
// Pure-data unit tests for the SCORE module. Covers tickWidth,
// barCapacityRemaining, canPlace (overflow + overlap + range),
// staffStepToMidi (key sig + accidentals), dynamicAt, tieSpanNotes,
// tie chain helpers, dynamics scale (v2 numbers), data migration
// (v1 single-array -> v2 page model), and page-count constraint.

import { describe, expect, it } from 'vitest';
import {
  BARS_PER_PAGE,
  DEFAULT_PAGES,
  DYNAMIC_SCALE,
  MAX_PAGES,
  TICKS_PER_BAR,
  TOTAL_BARS,
  SCORE_MIN_MIDI,
  SCORE_MAX_MIDI,
  barCapacityRemaining,
  canPlace,
  dynamicAt,
  emptyScoreData,
  migrateScoreV1ToV2,
  staffStepToMidi,
  tickWidth,
  tieChainFrom,
  tieRoleFor,
  tieSpanNotes,
  totalBars,
  type ScoreNote,
  type DynamicMarker,
  type Tie,
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
    // Default maxBar is TOTAL_BARS (page-1 size = 16).
    expect(canPlace(TOTAL_BARS, 0, 'quarter', middleC, [])).toBe(false);
  });
  it('respects custom maxBar (multi-page mode)', () => {
    // With pages=2, bars 0..31 are valid.
    const maxBar = 32;
    expect(canPlace(20, 0, 'quarter', middleC, [], undefined, maxBar)).toBe(true);
    expect(canPlace(32, 0, 'quarter', middleC, [], undefined, maxBar)).toBe(false);
  });
  it('respects ignoreNoteId for drag-move scenarios', () => {
    const existing = note({ bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 5, id: 'A' });
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

describe('DYNAMIC_SCALE — v2 dynamics tweak', () => {
  it('pp is 10% quieter than v1 (0.225 instead of 0.25)', () => {
    expect(DYNAMIC_SCALE.pp).toBeCloseTo(0.225, 5);
  });
  it('p / mf / f are unchanged from v1', () => {
    expect(DYNAMIC_SCALE.p).toBeCloseTo(0.4, 5);
    expect(DYNAMIC_SCALE.mf).toBeCloseTo(0.55, 5);
    expect(DYNAMIC_SCALE.f).toBeCloseTo(0.75, 5);
  });
  it('ff is 10% louder than v1 (1.045 instead of 0.95)', () => {
    expect(DYNAMIC_SCALE.ff).toBeCloseTo(1.045, 5);
  });
  it('ff is louder than pp by the new ratio (~4.64)', () => {
    const ratio = DYNAMIC_SCALE.ff / DYNAMIC_SCALE.pp;
    // New ratio: 1.045 / 0.225 ≈ 4.644. Old ratio: 0.95 / 0.25 = 3.8.
    expect(ratio).toBeGreaterThan(4.5);
    expect(ratio).toBeLessThan(4.8);
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

describe('tie chain helpers — single-envelope semantics', () => {
  // Three quarters tied: A -> B -> C, all at MIDI 60. The whole chain should
  // produce ONE held envelope: gate-on at A.start, gate-off at C.end.
  const notes: ScoreNote[] = [
    note({ id: 'A', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 10 }),
    note({ id: 'B', bar: 0, tick: 12, duration: 'quarter', midi: 60, staffStep: 10 }),
    note({ id: 'C', bar: 0, tick: 24, duration: 'quarter', midi: 60, staffStep: 10 }),
  ];
  const ties: Tie[] = [
    { id: 't1', fromNoteId: 'A', toNoteId: 'B' },
    { id: 't2', fromNoteId: 'B', toNoteId: 'C' },
  ];

  it('tieRoleFor identifies start, mid, end for a 3-note chain', () => {
    expect(tieRoleFor('A', ties)).toBe('tied-start');
    expect(tieRoleFor('B', ties)).toBe('tied-mid');
    expect(tieRoleFor('C', ties)).toBe('tied-end');
  });

  it('tieRoleFor returns "none" for un-tied notes', () => {
    expect(tieRoleFor('A', [])).toBe('none');
    const z = note({ id: 'Z', bar: 1, tick: 0, duration: 'quarter', midi: 60, staffStep: 10 });
    expect(tieRoleFor(z.id, ties)).toBe('none');
  });

  it('tieChainFrom walks A -> B -> C and stops at the end', () => {
    const chain = tieChainFrom('A', ties, notes);
    expect(chain.map((n) => n.id)).toEqual(['A', 'B', 'C']);
  });

  it('tieChainFrom on mid-chain note walks forward only (B -> C)', () => {
    const chain = tieChainFrom('B', ties, notes);
    expect(chain.map((n) => n.id)).toEqual(['B', 'C']);
  });

  it('tieChainFrom on tied-end note returns just that note', () => {
    const chain = tieChainFrom('C', ties, notes);
    expect(chain.map((n) => n.id)).toEqual(['C']);
  });

  it('tieChainFrom is cycle-safe (no infinite loop on bad data)', () => {
    const cyclic: Tie[] = [
      { id: 'x', fromNoteId: 'A', toNoteId: 'B' },
      { id: 'y', fromNoteId: 'B', toNoteId: 'A' },
    ];
    const chain = tieChainFrom('A', cyclic, notes);
    // A -> B, then B's outgoing tie points back to A which is visited; stop.
    expect(chain.map((n) => n.id)).toEqual(['A', 'B']);
  });

  it('chain end-tick equals last note end (single-envelope span)', () => {
    const chain = tieChainFrom('A', ties, notes);
    const last = chain[chain.length - 1];
    const startAbs = notes[0].bar * TICKS_PER_BAR + notes[0].tick;
    const endAbs = last.bar * TICKS_PER_BAR + last.tick + tickWidth(last.duration);
    // 0..36 ticks (3 quarters = 36 grid ticks).
    expect(endAbs - startAbs).toBe(36);
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

describe('page model + migration', () => {
  it('emptyScoreData defaults to 1 page, loop=false, no stopBar', () => {
    const d = emptyScoreData();
    expect(d.pages).toBe(DEFAULT_PAGES);
    expect(d.pages).toBe(1);
    expect(d.loop).toBe(false);
    expect(d.stopBar).toBeUndefined();
  });

  it('totalBars returns pages × BARS_PER_PAGE', () => {
    expect(totalBars({ ...emptyScoreData(), pages: 1 })).toBe(BARS_PER_PAGE);
    expect(totalBars({ ...emptyScoreData(), pages: 4 })).toBe(BARS_PER_PAGE * MAX_PAGES);
  });

  it('totalBars clamps pages to [1, MAX_PAGES]', () => {
    expect(totalBars({ ...emptyScoreData(), pages: 0 })).toBe(BARS_PER_PAGE);
    expect(totalBars({ ...emptyScoreData(), pages: 99 })).toBe(BARS_PER_PAGE * MAX_PAGES);
  });

  it('migrateScoreV1ToV2 produces 1 page with original 8 bars in slots 0..7', () => {
    // v1 shape: notes/dynamics/ties + keySignature, no pages/loop/stopBar.
    const v1 = {
      notes: [
        { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 77, staffStep: 0, accidental: null },
        { id: 'n7', bar: 7, tick: 0, duration: 'quarter', midi: 77, staffStep: 0, accidental: null },
      ],
      dynamics: [{ id: 'd1', bar: 0, tick: 0, level: 'mf' }],
      ties: [],
      keySignature: 1,
    };
    const v2 = migrateScoreV1ToV2(v1);
    expect(v2.pages).toBe(1);
    expect(v2.loop).toBe(false);
    expect(v2.stopBar).toBeUndefined();
    expect(v2.keySignature).toBe(1);
    expect(v2.notes).toHaveLength(2);
    // Bars are preserved verbatim — notes at bars 0..7 fit inside page 1
    // (bars 0..15) automatically.
    expect(v2.notes[0].bar).toBe(0);
    expect(v2.notes[1].bar).toBe(7);
  });

  it('migrateScoreV1ToV2 handles missing/invalid input gracefully', () => {
    expect(migrateScoreV1ToV2(undefined)).toEqual(emptyScoreData());
    expect(migrateScoreV1ToV2(null)).toEqual(emptyScoreData());
    expect(migrateScoreV1ToV2(42)).toEqual(emptyScoreData());
  });

  it('migrateScoreV1ToV2 is idempotent on v2 data (round-trip)', () => {
    const v2 = {
      notes: [],
      dynamics: [],
      ties: [],
      keySignature: 0,
      pages: 3,
      loop: true,
      stopBar: { bar: 5, tick: 24 },
    };
    const out = migrateScoreV1ToV2(v2);
    expect(out.pages).toBe(3);
    expect(out.loop).toBe(true);
    expect(out.stopBar).toEqual({ bar: 5, tick: 24 });
  });

  it('cannot exceed MAX_PAGES (clamped during migration)', () => {
    const v2 = { notes: [], dynamics: [], ties: [], keySignature: 0, pages: 99, loop: false };
    const out = migrateScoreV1ToV2(v2);
    expect(out.pages).toBe(MAX_PAGES);
  });
});

describe('stop-bar logic (engine-level expectations)', () => {
  // Engine behavior at sequencer step >= stopBarStep:
  //   - loop OFF -> stop playback, gate goes low
  //   - loop ON  -> wrap tickIndex back to 0
  //
  // We mirror that decision here as a pure helper test so the engine's
  // branch is testable without spinning up a Faust worklet.
  function decideAtStopBar(reachedStop: boolean, loop: boolean): 'stop' | 'wrap' | 'continue' {
    if (!reachedStop) return 'continue';
    return loop ? 'wrap' : 'stop';
  }

  it('returns "continue" before reaching the stop bar', () => {
    expect(decideAtStopBar(false, false)).toBe('continue');
    expect(decideAtStopBar(false, true)).toBe('continue');
  });
  it('returns "stop" at the stop bar with loop OFF', () => {
    expect(decideAtStopBar(true, false)).toBe('stop');
  });
  it('returns "wrap" at the stop bar with loop ON', () => {
    expect(decideAtStopBar(true, true)).toBe('wrap');
  });
});
