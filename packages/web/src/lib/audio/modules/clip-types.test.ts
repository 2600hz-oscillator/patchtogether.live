// packages/web/src/lib/audio/modules/clip-types.test.ts
import { describe, it, expect } from 'vitest';
import { midiToVOct, C3_MIDI } from '$lib/audio/note-entry';
import {
  CLIP_COUNT,
  CLIP_LANES,
  CLIP_TRACKS,
  DEFAULT_CLIP_STEPS,
  clipIndex,
  laneOf,
  slotOf,
  lanePlaying,
  laneQueued,
  playingSet,
  defaultNoteClip,
  coerceNoteEvent,
  coerceClipRecord,
  clampStepCount,
  readClip,
  notesStartingAt,
  lanesForStep,
  scaleSteps,
  rowToMidi,
  midiToRow,
  toggleNoteAt,
  cycleVelocity,
  noteAt,
  noteCovering,
  setNoteSpan,
  nextScale,
  velLevelIndex,
  velBucket,
  laneMono,
  VEL_DEFAULT,
  VEL_LEVELS,
  type NoteClipRecord,
} from './clip-types';

describe('dimensions', () => {
  it('is an 8×8 = 64 clip bank', () => {
    expect(CLIP_COUNT).toBe(64);
    expect(clipIndex(0, 0)).toBe(0);
    expect(clipIndex(7, 0)).toBe(7);
    expect(clipIndex(0, 1)).toBe(CLIP_TRACKS);
    expect(clipIndex(7, 7)).toBe(63);
  });
});

describe('defaultNoteClip', () => {
  it('is an empty in-key major clip rooted at C3', () => {
    const c = defaultNoteClip();
    expect(c.kind).toBe('note');
    expect(c.steps).toEqual([]);
    expect(c.lengthSteps).toBe(DEFAULT_CLIP_STEPS);
    expect(c.root).toBe(C3_MIDI);
    expect(c.scale).toBe('major');
    expect(c.loop).toBe(true);
  });
});

describe('coerceNoteEvent', () => {
  it('accepts a valid event and clamps optional fields', () => {
    expect(coerceNoteEvent({ step: 2, midi: 60 })).toEqual({ step: 2, midi: 60 });
    expect(coerceNoteEvent({ step: 0, midi: 60, velocity: 200, lengthSteps: 0, prob: 2 })).toEqual({
      step: 0,
      midi: 60,
      velocity: 127,
      lengthSteps: 1,
      prob: 1,
    });
  });
  it('rejects garbage / out-of-range', () => {
    expect(coerceNoteEvent(null)).toBeNull();
    expect(coerceNoteEvent({ step: -1, midi: 60 })).toBeNull();
    expect(coerceNoteEvent({ step: 0, midi: 9999 })).toBeNull();
    expect(coerceNoteEvent({ step: 0 })).toBeNull();
  });
});

describe('coerceClipRecord', () => {
  it('normalizes a note clip and drops bad events', () => {
    const c = coerceClipRecord({
      kind: 'note',
      steps: [{ step: 0, midi: 60 }, { step: 1, midi: 'x' }],
      lengthSteps: 8,
      root: 48,
      scale: 'minor',
    });
    expect(c?.kind).toBe('note');
    expect((c as NoteClipRecord).steps).toEqual([{ step: 0, midi: 60 }]);
    expect((c as NoteClipRecord).lengthSteps).toBe(8);
    expect((c as NoteClipRecord).scale).toBe('minor');
  });
  it('returns null for unknown / empty', () => {
    expect(coerceClipRecord(null)).toBeNull();
    expect(coerceClipRecord({ kind: 'bogus' })).toBeNull();
  });
});

describe('clampStepCount', () => {
  it('clamps to [1, 64] and defaults bad input', () => {
    expect(clampStepCount(0)).toBe(1);
    expect(clampStepCount(16)).toBe(16);
    expect(clampStepCount(999)).toBe(64);
    expect(clampStepCount(NaN)).toBe(DEFAULT_CLIP_STEPS);
  });
});

describe('readClip', () => {
  it('reads + coerces a slot, null when empty/absent', () => {
    const data = { clips: { '5': { kind: 'note', steps: [], lengthSteps: 16, root: 48 } } };
    expect(readClip(data, 5)?.kind).toBe('note');
    expect(readClip(data, 6)).toBeNull();
    expect(readClip(undefined, 0)).toBeNull();
  });
});

describe('lanesForStep', () => {
  const clip: NoteClipRecord = {
    kind: 'note',
    lengthSteps: 16,
    root: C3_MIDI,
    loop: true,
    steps: [
      { step: 0, midi: 60, velocity: 127, lengthSteps: 2 },
      { step: 0, midi: 64 }, // chord with above
      { step: 4, midi: 67, velocity: 64 },
    ],
  };
  it('returns chord lanes + max velocity + max gate width on a step with notes', () => {
    const r = lanesForStep(clip, 0);
    expect(r.any).toBe(true);
    expect(r.lanes).toEqual([
      { pitch: midiToVOct(60), gate: 1 },
      { pitch: midiToVOct(64), gate: 1 },
    ]);
    expect(r.velocity).toBeCloseTo(1, 5); // 127/127
    expect(r.gateSteps).toBe(2);
  });
  it('maps velocity to 0..1', () => {
    const r = lanesForStep(clip, 4);
    expect(r.velocity).toBeCloseTo(64 / 127, 5);
  });
  it('is empty on a silent step', () => {
    const r = lanesForStep(clip, 1);
    expect(r.any).toBe(false);
    expect(r.lanes).toEqual([]);
  });
  it('finds notes starting at a step', () => {
    expect(notesStartingAt(clip, 0)).toHaveLength(2);
    expect(notesStartingAt(clip, 9)).toHaveLength(0);
  });
});

describe('note-editor row math', () => {
  it('chromatic rows are +1 semitone from root', () => {
    expect(scaleSteps(undefined)).toHaveLength(12);
    expect(rowToMidi(0, 48)).toBe(48);
    expect(rowToMidi(1, 48)).toBe(49);
    expect(rowToMidi(12, 48)).toBe(60);
    expect(rowToMidi(-1, 48)).toBe(47);
  });
  it('in-key major rows are scale degrees (7 rows per octave)', () => {
    // C major from C3 (48): C D E F G A B C → 48 50 52 53 55 57 59 60
    expect(rowToMidi(0, 48, 'major')).toBe(48);
    expect(rowToMidi(1, 48, 'major')).toBe(50);
    expect(rowToMidi(2, 48, 'major')).toBe(52);
    expect(rowToMidi(6, 48, 'major')).toBe(59);
    expect(rowToMidi(7, 48, 'major')).toBe(60); // next octave's root
  });
  it('midiToRow inverts rowToMidi and rejects out-of-scale notes', () => {
    for (const row of [0, 1, 2, 6, 7, 13]) {
      const m = rowToMidi(row, 48, 'major');
      expect(midiToRow(m, 48, 'major')).toBe(row);
    }
    // C#3 (49) is not in C major → no row.
    expect(midiToRow(49, 48, 'major')).toBeNull();
    // chromatic accepts everything.
    expect(midiToRow(49, 48)).toBe(1);
  });
});

describe('toggleNoteAt', () => {
  it('adds then removes a note immutably (default velocity)', () => {
    const c0 = defaultNoteClip();
    const c1 = toggleNoteAt(c0, 3, 60);
    expect(c1.steps).toEqual([{ step: 3, midi: 60, velocity: VEL_DEFAULT, lengthSteps: 1 }]);
    expect(c0.steps).toEqual([]); // original untouched
    const c2 = toggleNoteAt(c1, 3, 60);
    expect(c2.steps).toEqual([]);
  });

  it('MONO: adding a note in a column REPLACES the note already there', () => {
    // A note at (step 3, midi 60); placing a different pitch in column 3 replaces it.
    const c0 = { ...defaultNoteClip(), steps: [{ step: 3, midi: 60, velocity: 100, lengthSteps: 1 }] };
    const c1 = toggleNoteAt(c0, 3, 64, { mono: true });
    expect(c1.steps).toHaveLength(1);
    expect(c1.steps[0]).toMatchObject({ step: 3, midi: 64 });
  });

  it('MONO: replaces even a HELD note covering the column', () => {
    const c0 = { ...defaultNoteClip(), steps: [{ step: 2, midi: 60, velocity: 100, lengthSteps: 4 }] };
    const c1 = toggleNoteAt(c0, 4, 67, { mono: true }); // step 4 is inside the held span
    expect(c1.steps).toHaveLength(1);
    expect(c1.steps[0]).toMatchObject({ step: 4, midi: 67, lengthSteps: 1 });
  });

  it('POLY caps a column at maxVoices, re-using the OLDEST voice', () => {
    // Fill column 0 with 5 voices (the poly width), then add a 6th.
    let c: NoteClipRecord = defaultNoteClip();
    for (const m of [60, 62, 64, 65, 67]) c = toggleNoteAt(c, 0, m);
    expect(c.steps.filter((e) => e.step === 0)).toHaveLength(5);
    const c6 = toggleNoteAt(c, 0, 69); // 6th → drop the oldest (midi 60)
    const col = c6.steps.filter((e) => e.step === 0);
    expect(col).toHaveLength(5);
    expect(col.some((e) => e.midi === 60)).toBe(false); // oldest re-used
    expect(col.some((e) => e.midi === 69)).toBe(true); // newest present
  });

  it('POLY cap leaves OTHER columns untouched', () => {
    let c: NoteClipRecord = defaultNoteClip();
    for (const m of [60, 62, 64, 65, 67]) c = toggleNoteAt(c, 0, m);
    c = toggleNoteAt(c, 1, 72); // a different column
    expect(c.steps.filter((e) => e.step === 1)).toHaveLength(1);
    expect(c.steps.filter((e) => e.step === 0)).toHaveLength(5);
  });
});

describe('laneMono', () => {
  it('reads the per-lane mono flag (default poly)', () => {
    expect(laneMono(undefined, 0)).toBe(false);
    expect(laneMono({ mono: [true, false] }, 0)).toBe(true);
    expect(laneMono({ mono: [true, false] }, 1)).toBe(false);
    expect(laneMono({ mono: [true] }, 5)).toBe(false);
  });
});

describe('per-lane index + state helpers', () => {
  it('laneOf / slotOf split a flat index (row-major, lane*8+slot)', () => {
    expect([laneOf(0), slotOf(0)]).toEqual([0, 0]);
    expect([laneOf(9), slotOf(9)]).toEqual([1, 1]);
    expect([laneOf(63), slotOf(63)]).toEqual([7, 7]);
  });
  it('lanePlaying / laneQueued read the per-lane arrays', () => {
    const data = {
      playing: [null, 3, null, null, null, null, null, null],
      queued: ['stop', 2, null, null, null, null, null, null] as (number | 'stop' | null)[],
    };
    expect(lanePlaying(data, 1)).toBe(3);
    expect(lanePlaying(data, 0)).toBeNull();
    expect(lanePlaying(undefined, 0)).toBeNull();
    expect(laneQueued(data, 0)).toBe('stop');
    expect(laneQueued(data, 1)).toBe(2);
    expect(laneQueued(data, 2)).toBeNull();
  });
  it('playingSet normalizes to exactly CLIP_LANES entries', () => {
    expect(playingSet({ playing: [1] })).toHaveLength(CLIP_LANES);
    expect(playingSet(undefined)).toEqual(new Array(CLIP_LANES).fill(null));
    expect(playingSet({ playing: [1] })[0]).toBe(1);
  });
});

describe('held notes (the hold-pad + tap-another tie gesture)', () => {
  it('setNoteSpan makes one held note across lo..hi, merging the row', () => {
    const c0 = defaultNoteClip();
    const c1 = setNoteSpan(c0, 2, 5, 60);
    expect(c1.steps).toHaveLength(1);
    expect(c1.steps[0]).toMatchObject({ step: 2, midi: 60, lengthSteps: 4 });
    expect(c0.steps).toEqual([]); // immutable
  });
  it('setNoteSpan normalizes order + removes overlapping notes in the row', () => {
    const c0 = { ...defaultNoteClip(), steps: [{ step: 4, midi: 60, lengthSteps: 1 }] };
    const c1 = setNoteSpan(c0, 5, 2, 60); // hi/lo swapped; covers the existing step-4 note
    expect(c1.steps).toHaveLength(1);
    expect(c1.steps[0]).toMatchObject({ step: 2, midi: 60, lengthSteps: 4 });
  });
  it('noteCovering reports a held note across its whole span (not just the start)', () => {
    const clip = { ...defaultNoteClip(), steps: [{ step: 2, midi: 60, lengthSteps: 3 }] };
    expect(noteCovering(clip, 2, 60)).toBeDefined(); // start
    expect(noteCovering(clip, 4, 60)).toBeDefined(); // held tail
    expect(noteCovering(clip, 5, 60)).toBeUndefined(); // past the span
    expect(noteCovering(clip, 3, 62)).toBeUndefined(); // wrong row
  });
  it('setNoteSpan MONO clears notes in OTHER rows across the span too', () => {
    const c0 = {
      ...defaultNoteClip(),
      steps: [
        { step: 3, midi: 64, lengthSteps: 1 }, // a note inside the span, different row
        { step: 9, midi: 67, lengthSteps: 1 }, // a note OUTSIDE the span — survives
      ],
    };
    const c1 = setNoteSpan(c0, 2, 5, 60, { mono: true });
    // Only the new held note + the out-of-span note remain.
    expect(c1.steps).toHaveLength(2);
    expect(c1.steps.some((e) => e.midi === 64)).toBe(false); // cleared (in span)
    expect(c1.steps.some((e) => e.step === 9 && e.midi === 67)).toBe(true); // kept
    expect(c1.steps.find((e) => e.midi === 60)).toMatchObject({ step: 2, lengthSteps: 4 });
  });
});

describe('nextScale (the grid SCALE pad / card scale cycle)', () => {
  it('cycles major → minor → pentatonic → chromatic → major', () => {
    expect(nextScale('major')).toBe('minor');
    expect(nextScale('minor')).toBe('pentatonic');
    expect(nextScale('pentatonic')).toBeUndefined(); // chromatic
    expect(nextScale(undefined)).toBe('major'); // wraps from chromatic
  });
});

describe('VELOCITY-hold velocity cycle (6 levels)', () => {
  it('six levels span 0..127 in ~20% steps', () => {
    expect(VEL_LEVELS).toEqual([0, 25, 51, 76, 102, 127]);
    expect(VEL_LEVELS[0] / 127).toBeCloseTo(0, 2);
    expect(VEL_LEVELS[5] / 127).toBeCloseTo(1, 2);
  });
  it('cycleVelocity: empty → default, then steps UP through all six, wrapping', () => {
    const c0 = defaultNoteClip();
    let c = cycleVelocity(c0, 3, 60); // places at VEL_DEFAULT
    expect(noteAt(c, 3, 60)?.velocity).toBe(VEL_DEFAULT);
    // From the default, cycling advances through the levels and wraps back to it.
    const startIdx = VEL_LEVELS.indexOf(VEL_DEFAULT);
    for (let i = 1; i <= VEL_LEVELS.length; i++) {
      c = cycleVelocity(c, 3, 60);
      const expected = VEL_LEVELS[(startIdx + i) % VEL_LEVELS.length];
      expect(noteAt(c, 3, 60)?.velocity).toBe(expected);
    }
    expect(noteAt(c, 3, 60)?.velocity).toBe(VEL_DEFAULT); // full wrap
    expect(c0.steps).toEqual([]); // immutable
  });
  it('cycleVelocity changes the COVERING held note (press anywhere in its span)', () => {
    const clip = { ...defaultNoteClip(), steps: [{ step: 2, midi: 60, velocity: VEL_LEVELS[0], lengthSteps: 3 }] };
    const next = cycleVelocity(clip, 4, 60); // press a held-tail cell → level 0 → level 1
    expect(noteAt(next, 2, 60)?.velocity).toBe(VEL_LEVELS[1]);
  });
  it('velLevelIndex snaps a raw velocity to the nearest of the 6 levels', () => {
    expect(velLevelIndex(0)).toBe(0);
    expect(velLevelIndex(127)).toBe(5);
    expect(velLevelIndex(76)).toBe(3);
    expect(velLevelIndex(100)).toBe(4); // nearest 102
    expect(velLevelIndex(undefined)).toBe(velLevelIndex(VEL_DEFAULT));
  });
  it('velBucket folds the 6 levels into 3 display colours (2 per colour)', () => {
    // levels {0,1}→0, {2,3}→1, {4,5}→2
    expect(VEL_LEVELS.map((v) => velBucket(v))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});
