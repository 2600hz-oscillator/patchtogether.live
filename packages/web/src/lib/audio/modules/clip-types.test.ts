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
  sceneQueue,
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
  laneMuted,
  coerceLaneColor,
  coerceLaneColors,
  laneColor,
  VEL_DEFAULT,
  VEL_LEVELS,
  MAX_CLIP_STEPS,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
  doubleNoteClip,
  reverseClipSteps,
  copyClip,
  lengthEndBlock,
  lengthEndStep,
  lengthFromBlockTap,
  lengthFromStepTap,
  readNoteRec,
  SCALE_NAMES,
  SCALE_CYCLE,
  coerceScaleName,
  laneSwing,
  clampSwing,
  isSwingCentered,
  swingStepOffset,
  MAX_SWING,
  type NoteClipRecord,
  type NoteEvent,
  type ClipPlayerData,
} from './clip-types';

describe('sceneQueue: launch a whole ROW (slot) across every lane', () => {
  it('queues the slot on lanes that have a clip there, stops the rest', () => {
    const data = {
      clips: {
        [String(clipIndex(2, 0))]: defaultNoteClip(), // slot 2, lane 0
        [String(clipIndex(2, 3))]: defaultNoteClip(), // slot 2, lane 3
        [String(clipIndex(5, 1))]: defaultNoteClip(), // a DIFFERENT slot — must be ignored
      },
    } as unknown as ClipPlayerData;
    const q = sceneQueue(data, 2);
    expect(q).toHaveLength(CLIP_LANES);
    expect(q[0], 'lane 0 has a slot-2 clip → queue it').toBe(2);
    expect(q[3], 'lane 3 has a slot-2 clip → queue it').toBe(2);
    expect(q[1], 'lane 1 has no slot-2 clip → stop').toBe('stop');
    expect(q[2]).toBe('stop');
    expect(q[7]).toBe('stop');
  });
  it('an empty row queues stop on every lane', () => {
    expect(sceneQueue({ clips: {} } as unknown as ClipPlayerData, 0)).toEqual(
      new Array(CLIP_LANES).fill('stop'),
    );
  });
  it('undefined data → all stop (no crash)', () => {
    expect(sceneQueue(undefined, 3)).toEqual(new Array(CLIP_LANES).fill('stop'));
  });
});

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
  it('clamps to [1, MAX_CLIP_STEPS=128] and defaults bad input', () => {
    expect(MAX_CLIP_STEPS).toBe(128);
    expect(clampStepCount(0)).toBe(1);
    expect(clampStepCount(16)).toBe(16);
    expect(clampStepCount(128)).toBe(128);
    expect(clampStepCount(999)).toBe(MAX_CLIP_STEPS);
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

describe('laneMuted (P3 — advance-but-silent)', () => {
  it('reads the per-lane mute flag; a missing/short array is back-compat all-live', () => {
    expect(laneMuted(undefined, 0)).toBe(false); // no field → live
    expect(laneMuted({}, 0)).toBe(false);
    expect(laneMuted({ muted: [true, false] }, 0)).toBe(true);
    expect(laneMuted({ muted: [true, false] }, 1)).toBe(false);
    expect(laneMuted({ muted: [true] }, 5)).toBe(false); // short array → live
  });
});

describe('per-lane CLIP COLOR helpers', () => {
  it('coerceLaneColor keeps a valid hex, lowercasing + expanding #rgb → #rrggbb', () => {
    expect(coerceLaneColor('#aabbcc')).toBe('#aabbcc');
    expect(coerceLaneColor('#AABBCC')).toBe('#aabbcc'); // lowercased
    expect(coerceLaneColor('#F0A')).toBe('#ff00aa'); // #rgb expanded
    expect(coerceLaneColor('  #FfEe00  ')).toBe('#ffee00'); // trimmed + lowercased
  });
  it('coerceLaneColor rejects non-hex / null / wrong-length ⇒ null', () => {
    expect(coerceLaneColor(null)).toBeNull();
    expect(coerceLaneColor(undefined)).toBeNull();
    expect(coerceLaneColor(0xff00aa)).toBeNull(); // a number, not a string
    expect(coerceLaneColor('red')).toBeNull(); // named colors not accepted
    expect(coerceLaneColor('#12')).toBeNull(); // too short (2 digits)
    expect(coerceLaneColor('#12345')).toBeNull(); // 5 digits
    expect(coerceLaneColor('#1234567')).toBeNull(); // 7 digits
    expect(coerceLaneColor('#gggggg')).toBeNull(); // non-hex digits
    expect(coerceLaneColor('aabbcc')).toBeNull(); // missing '#'
    expect(coerceLaneColor('')).toBeNull();
  });
  it('coerceLaneColors normalizes to exactly CLIP_LANES entries (missing/short ⇒ null)', () => {
    const out = coerceLaneColors(['#f00', 'nope', '#00FF00']);
    expect(out).toHaveLength(CLIP_LANES);
    expect(out[0]).toBe('#ff0000'); // #rgb expanded + kept
    expect(out[1]).toBeNull(); // invalid entry ⇒ null
    expect(out[2]).toBe('#00ff00'); // lowercased
    for (let i = 3; i < CLIP_LANES; i++) expect(out[i]).toBeNull(); // short ⇒ padded null
  });
  it('coerceLaneColors on a non-array (absent/corrupt) ⇒ all nulls, still length CLIP_LANES', () => {
    for (const raw of [undefined, null, 'nope', 42]) {
      const out = coerceLaneColors(raw);
      expect(out).toHaveLength(CLIP_LANES);
      expect(out.every((c) => c === null)).toBe(true);
    }
  });
  it('laneColor reads a per-lane entry, null when absent/short/corrupt', () => {
    expect(laneColor({ laneColor: ['#abcdef', '#123'] }, 0)).toBe('#abcdef');
    expect(laneColor({ laneColor: ['#abcdef', '#123'] }, 1)).toBe('#112233'); // #rgb expanded
    expect(laneColor({ laneColor: ['#abcdef'] }, 3)).toBeNull(); // short array
    expect(laneColor(undefined, 0)).toBeNull();
    expect(laneColor({}, 0)).toBeNull();
    expect(laneColor({ laneColor: 'nope' } as unknown as ClipPlayerData, 0)).toBeNull();
    expect(laneColor({ laneColor: ['bad'] }, 0)).toBeNull(); // corrupt entry ⇒ null
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
  it('cycles through all six named scales then chromatic, wrapping to major', () => {
    expect(nextScale('major')).toBe('minor');
    expect(nextScale('minor')).toBe('pentatonic');
    expect(nextScale('pentatonic')).toBe('dorian');
    expect(nextScale('dorian')).toBe('phrygian');
    expect(nextScale('phrygian')).toBe('mixolydian');
    expect(nextScale('mixolydian')).toBeUndefined(); // chromatic
    expect(nextScale(undefined)).toBe('major'); // wraps from chromatic
  });
  it('SCALE_CYCLE = the six named scales followed by undefined (chromatic)', () => {
    expect(SCALE_CYCLE).toEqual([
      'major', 'minor', 'pentatonic', 'dorian', 'phrygian', 'mixolydian', undefined,
    ]);
    expect(SCALE_NAMES).toEqual([
      'major', 'minor', 'pentatonic', 'dorian', 'phrygian', 'mixolydian',
    ]);
  });
});

describe('scaleSteps for the added modes', () => {
  it('returns the canonical semitone set for each new mode', () => {
    expect(scaleSteps('dorian')).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(scaleSteps('phrygian')).toEqual([0, 1, 3, 5, 7, 8, 10]);
    expect(scaleSteps('mixolydian')).toEqual([0, 2, 4, 5, 7, 9, 10]);
  });
  it('in-key rows walk the mode degrees (dorian from C3=48)', () => {
    // C dorian: C D E♭ F G A B♭ C → 48 50 51 53 55 57 58 60
    expect(rowToMidi(0, 48, 'dorian')).toBe(48);
    expect(rowToMidi(2, 48, 'dorian')).toBe(51); // E♭ (the minor 3rd)
    expect(rowToMidi(5, 48, 'dorian')).toBe(57); // A (the raised 6th)
    expect(rowToMidi(7, 48, 'dorian')).toBe(60); // next octave's root
  });
});

describe('coerceScaleName + scale round-trip on load', () => {
  it('accepts every named scale (incl. the 3 new ones)', () => {
    for (const s of SCALE_NAMES) expect(coerceScaleName(s)).toBe(s);
  });
  it('unknown / legacy / absent ⇒ undefined (chromatic)', () => {
    expect(coerceScaleName('ionian')).toBeUndefined(); // dropped alias
    expect(coerceScaleName('aeolian')).toBeUndefined();
    expect(coerceScaleName('chromatic')).toBeUndefined(); // chromatic = absence
    expect(coerceScaleName('bogus')).toBeUndefined();
    expect(coerceScaleName(undefined)).toBeUndefined();
    expect(coerceScaleName(3)).toBeUndefined();
  });
  it('coerceClipRecord round-trips each new mode', () => {
    for (const scale of ['dorian', 'phrygian', 'mixolydian'] as const) {
      const c = coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, scale });
      expect((c as NoteClipRecord).scale).toBe(scale);
    }
  });
  it('coerceClipRecord drops an unknown scale (legacy → chromatic)', () => {
    const c = coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, scale: 'ionian' });
    expect('scale' in (c as NoteClipRecord)).toBe(false);
  });
});

describe('per-clip div coercion', () => {
  it('clamps a finite div to a valid RATE index, rounding', () => {
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 0 }) as NoteClipRecord).div).toBe(0);
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 5 }) as NoteClipRecord).div).toBe(5);
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 2.4 }) as NoteClipRecord).div).toBe(2);
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 99 }) as NoteClipRecord).div).toBe(5); // clamp high
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: -3 }) as NoteClipRecord).div).toBe(0); // clamp low
  });
  it('missing / non-numeric div ⇒ undefined (clip follows the lane rate)', () => {
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48 }) as NoteClipRecord).div).toBeUndefined();
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 'x' }) as NoteClipRecord).div).toBeUndefined();
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: NaN }) as NoteClipRecord).div).toBeUndefined();
  });
  it('copyClip preserves an explicit div (and omits it when absent)', () => {
    const withDiv: NoteClipRecord = { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true, div: 4 };
    expect(copyClip(withDiv).div).toBe(4);
    const noDiv: NoteClipRecord = { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true };
    expect('div' in copyClip(noDiv)).toBe(false);
  });
});

describe('per-lane SWING helpers', () => {
  it('MAX_SWING matches the DRUMSEQZ range (0..0.75)', () => {
    expect(MAX_SWING).toBe(0.75);
  });
  it('clampSwing clamps to [0, MAX_SWING] and defaults garbage to 0', () => {
    expect(clampSwing(0)).toBe(0);
    expect(clampSwing(0.5)).toBe(0.5);
    expect(clampSwing(0.75)).toBe(0.75);
    expect(clampSwing(2)).toBe(0.75); // clamp high
    expect(clampSwing(-1)).toBe(0); // clamp low
    expect(clampSwing(NaN)).toBe(0);
    expect(clampSwing(undefined)).toBe(0);
    expect(clampSwing('nope')).toBe(0);
  });
  it('laneSwing reads a per-lane entry, 0 when absent/short/corrupt', () => {
    expect(laneSwing({ swing: [0.5, 0.25, 0] }, 0)).toBe(0.5);
    expect(laneSwing({ swing: [0.5, 0.25, 0] }, 1)).toBe(0.25);
    expect(laneSwing({ swing: [2] }, 0)).toBe(0.75); // clamped
    expect(laneSwing(undefined, 0)).toBe(0);
    expect(laneSwing({}, 0)).toBe(0);
    expect(laneSwing({ swing: 'nope' }, 0)).toBe(0);
    expect(laneSwing({ swing: [0.5] }, 3)).toBe(0); // short array
  });
  it('swingStepOffset delays ODD steps by swing*stepDur, EVEN steps stay on grid', () => {
    // stepDur 0.25, swing 0.5 → odd steps push late by 0.125, even steps 0.
    expect(swingStepOffset(0, 0.5, 0.25)).toBe(0);
    expect(swingStepOffset(1, 0.5, 0.25)).toBe(0.125);
    expect(swingStepOffset(2, 0.5, 0.25)).toBe(0);
    expect(swingStepOffset(3, 0.5, 0.25)).toBe(0.125);
    // a different amount + a clamp inside the helper
    expect(swingStepOffset(1, 0.25, 0.4)).toBeCloseTo(0.1, 10);
    expect(swingStepOffset(1, 2, 0.25)).toBe(0.1875); // clamped to 0.75 → 0.75*0.25
  });
  it('swing 0 ⇒ every step offset is 0 (the un-swung even grid)', () => {
    for (let i = 0; i < 8; i++) expect(swingStepOffset(i, 0, 0.25)).toBe(0);
  });
  it('isSwingCentered is true only at 0 (within epsilon)', () => {
    expect(isSwingCentered(0)).toBe(true);
    expect(isSwingCentered(1e-12)).toBe(true);
    expect(isSwingCentered(0.02)).toBe(false);
    expect(isSwingCentered(0.75)).toBe(false);
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

describe('doubleNoteClip', () => {
  const c = (lengthSteps: number, steps: NoteEvent[]): NoteClipRecord => ({
    ...defaultNoteClip(),
    lengthSteps,
    steps,
  });
  it('16 → 32 with the first half duplicated into the second', () => {
    const c0 = c(16, [{ step: 0, midi: 60, lengthSteps: 1 }, { step: 4, midi: 64, lengthSteps: 2 }]);
    const d = doubleNoteClip(c0);
    expect(d.lengthSteps).toBe(32);
    // originals kept …
    expect(d.steps).toContainEqual({ step: 0, midi: 60, lengthSteps: 1 });
    expect(d.steps).toContainEqual({ step: 4, midi: 64, lengthSteps: 2 });
    // … plus their mirror at +16.
    expect(d.steps).toContainEqual({ step: 16, midi: 60, lengthSteps: 1 });
    expect(d.steps).toContainEqual({ step: 20, midi: 64, lengthSteps: 2 });
    expect(c0.steps).toHaveLength(2); // immutable
  });
  it('17 → 34, including a copy that lands in the second half (partial tail kept)', () => {
    const c0 = c(17, [{ step: 0, midi: 60, lengthSteps: 1 }, { step: 16, midi: 67, lengthSteps: 1 }]);
    const d = doubleNoteClip(c0);
    expect(d.lengthSteps).toBe(34);
    expect(d.steps).toContainEqual({ step: 0, midi: 60, lengthSteps: 1 });
    expect(d.steps).toContainEqual({ step: 16, midi: 67, lengthSteps: 1 }); // original
    expect(d.steps).toContainEqual({ step: 17, midi: 60, lengthSteps: 1 }); // mirror of step-0
    expect(d.steps).toContainEqual({ step: 33, midi: 67, lengthSteps: 1 }); // mirror of step-16 (33 < 34)
  });
  it('65 → 128 (capped), truncating copies that would start past 128', () => {
    const c0 = c(65, [
      { step: 0, midi: 60, lengthSteps: 1 },   // mirror → 65 (< 128, kept)
      { step: 63, midi: 62, lengthSteps: 1 },  // mirror → 128 (>= 128, DROPPED)
      { step: 64, midi: 64, lengthSteps: 1 },  // mirror → 129 (>= 128, DROPPED)
    ]);
    const d = doubleNoteClip(c0);
    expect(d.lengthSteps).toBe(128);
    expect(d.steps).toContainEqual({ step: 65, midi: 60, lengthSteps: 1 }); // kept
    expect(d.steps.some((e) => e.step === 128)).toBe(false); // dropped (at the cap)
    expect(d.steps.some((e) => e.step === 129)).toBe(false); // dropped (past the cap)
    // originals all survive
    expect(d.steps.filter((e) => e.step < 65)).toHaveLength(3);
  });
  it('at MAX_CLIP_STEPS (128) it is a no-op returning the SAME reference', () => {
    const c0 = c(128, [{ step: 0, midi: 60, lengthSteps: 1 }]);
    expect(doubleNoteClip(c0)).toBe(c0); // identity → caller skips the write
  });
  it('clamps a copied held note so it cannot bleed past the new length', () => {
    // length 65 → 128; a held note near the end whose mirror would overrun 128.
    const c0 = c(65, [{ step: 60, midi: 60, lengthSteps: 4 }]); // mirror at 125, span 4 → 129
    const d = doubleNoteClip(c0);
    const mirror = d.steps.find((e) => e.step === 125);
    expect(mirror).toBeDefined();
    expect(mirror!.step + (mirror!.lengthSteps ?? 1)).toBeLessThanOrEqual(128); // clamped, no bleed
    expect(mirror!.lengthSteps).toBe(3); // 128 - 125
  });
});

describe('reverseClipSteps', () => {
  const c = (lengthSteps: number, steps: NoteEvent[]): NoteClipRecord => ({
    ...defaultNoteClip(),
    lengthSteps,
    steps,
  });
  it('mirrors a single-step note across the clip length', () => {
    const r = reverseClipSteps(c(16, [{ step: 0, midi: 60, lengthSteps: 1 }]));
    // start 0, span 1 → mirroredStart = 16 - (0+1) = 15.
    expect(r.steps).toEqual([{ step: 15, midi: 60, lengthSteps: 1 }]);
  });
  it('re-anchors a MULTI-STEP held span to the mirrored END (not Array.reverse)', () => {
    // a 3-step held note at step 2 (covers 2,3,4) in a 16-step clip.
    const r = reverseClipSteps(c(16, [{ step: 2, midi: 60, lengthSteps: 3 }]));
    // mirroredStart = 16 - (2+3) = 11; still a 3-step note (covers 11,12,13).
    expect(r.steps).toEqual([{ step: 11, midi: 60, lengthSteps: 3 }]);
  });
  it('a span anchored at step 0 mirrors to the clip end', () => {
    const r = reverseClipSteps(c(16, [{ step: 0, midi: 60, lengthSteps: 4 }])); // covers 0..3
    // mirroredStart = 16 - (0+4) = 12; covers 12..15.
    expect(r.steps).toEqual([{ step: 12, midi: 60, lengthSteps: 4 }]);
  });
  it('preserves multiple notes (full forward→reverse symmetry)', () => {
    const fwd = c(8, [
      { step: 0, midi: 60, lengthSteps: 2 }, // → 8-(0+2)=6
      { step: 6, midi: 64, lengthSteps: 1 }, // → 8-(6+1)=1
    ]);
    const r = reverseClipSteps(fwd);
    expect(r.steps).toContainEqual({ step: 6, midi: 60, lengthSteps: 2 });
    expect(r.steps).toContainEqual({ step: 1, midi: 64, lengthSteps: 1 });
    // reversing twice round-trips back to the original positions.
    const back = reverseClipSteps(r);
    expect(back.steps).toContainEqual({ step: 0, midi: 60, lengthSteps: 2 });
    expect(back.steps).toContainEqual({ step: 6, midi: 64, lengthSteps: 1 });
    expect(fwd.steps).toHaveLength(2); // immutable
  });
  it('clamps a span that overran the clip end (mirroredStart < 0)', () => {
    // a note at step 6 with span 4 (covers 6..9) but length only 8 — span > end.
    const r = reverseClipSteps(c(8, [{ step: 6, midi: 60, lengthSteps: 4 }]));
    // mirroredStart = 8 - (6+4) = -2 → clamp to 0, trim len to 4 + (-2) = 2.
    expect(r.steps).toEqual([{ step: 0, midi: 60, lengthSteps: 2 }]);
  });
});

describe('copyClip', () => {
  it('structurally clones steps, length, root, scale (no shared refs)', () => {
    const c0: NoteClipRecord = {
      ...defaultNoteClip(),
      root: 50,
      scale: 'minor',
      lengthSteps: 24,
      steps: [{ step: 1, midi: 62, velocity: 100, lengthSteps: 2 }],
    };
    const c1 = copyClip(c0);
    expect(c1).toEqual({
      kind: 'note',
      root: 50,
      scale: 'minor',
      loop: true,
      lengthSteps: 24,
      steps: [{ step: 1, midi: 62, velocity: 100, lengthSteps: 2 }],
    });
    expect(c1.steps).not.toBe(c0.steps); // array cloned
    expect(c1.steps[0]).not.toBe(c0.steps[0]); // event cloned
    // mutating the copy never touches the original.
    c1.steps[0].midi = 99;
    expect(c0.steps[0].midi).toBe(62);
  });
  it('a chromatic (no-scale) clip clones without a scale key', () => {
    const c0: NoteClipRecord = { ...defaultNoteClip(), steps: [] };
    delete c0.scale;
    expect('scale' in copyClip(c0)).toBe(false);
  });
});

describe('LENGTH-EDIT page math', () => {
  it('STEPS_PER_PAGE = 16, MAX_EDIT_PAGES = 8', () => {
    expect(STEPS_PER_PAGE).toBe(16);
    expect(MAX_EDIT_PAGES).toBe(8);
  });
  // endBlock / endStep for the documented lengths 1 / 16 / 17 / 113 / 128.
  it.each([
    [1, 1, 1],
    [16, 1, 16],
    [17, 2, 1],
    [113, 8, 1],
    [128, 8, 16],
  ])('L=%i → endBlock=%i, endStep=%i', (L, block, step) => {
    expect(lengthEndBlock(L)).toBe(block);
    expect(lengthEndStep(L)).toBe(step);
  });
  it('tap row-0 block C → C*16 (full block)', () => {
    expect(lengthFromBlockTap(1)).toBe(16);
    expect(lengthFromBlockTap(7)).toBe(112);
    expect(lengthFromBlockTap(8)).toBe(128);
    expect(lengthFromBlockTap(99)).toBe(128); // clamp
  });
  it('tap row-1 step N → (endBlock−1)*16 + N (length 113 = block 8 then step 1)', () => {
    // currently in block 8 (e.g. L=128) → tapping row-1 step 1 trims to 113.
    expect(lengthFromStepTap(128, 1)).toBe(113);
    expect(lengthFromStepTap(128, 16)).toBe(128);
    // in block 2 (e.g. L=17) → tapping step 5 → 16 + 5 = 21.
    expect(lengthFromStepTap(17, 5)).toBe(21);
    // in block 1 → tapping step 8 → 8.
    expect(lengthFromStepTap(16, 8)).toBe(8);
  });
});

describe('readNoteRec — KEYS note-record state normalization', () => {
  it('returns null when absent/null/non-object', () => {
    expect(readNoteRec(undefined)).toBeNull();
    expect(readNoteRec({} as ClipPlayerData)).toBeNull();
    expect(readNoteRec({ noteRec: null } as ClipPlayerData)).toBeNull();
  });
  it('coerces + clamps lane/slot and reads the boolean flags', () => {
    const r = readNoteRec({
      noteRec: { lane: 2, slot: 5, armed: true, recording: false, overdub: true },
    } as ClipPlayerData);
    expect(r).toEqual({ lane: 2, slot: 5, armed: true, recording: false, overdub: true });
    // out-of-range lane/slot clamp into the grid.
    const c = readNoteRec({ noteRec: { lane: 99, slot: -3 } } as unknown as ClipPlayerData);
    expect(c!.lane).toBe(7);
    expect(c!.slot).toBe(0);
    expect(c!.armed).toBe(false); // missing flags default false
  });
  it('rejects a non-numeric lane/slot', () => {
    expect(readNoteRec({ noteRec: { lane: 'x', slot: 1 } } as unknown as ClipPlayerData)).toBeNull();
  });
});
