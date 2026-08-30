// packages/web/src/lib/ui/modules/clipplayer-prob-menu.test.ts
//
// The clipplayer card's PER-NOTE PROBABILITY right-click menu — PURE logic
// (extracted from ClipplayerCard.svelte, cf. clipplayer-keyboard.ts): the level
// list HIGH→LOW, the percent labels, the default-checked 100%, and the write via
// setNoteProb. The DOM open/close is exercised by the app; the purple cell by VRT.

import { describe, it, expect } from 'vitest';
import {
  probMenuLevels,
  probPctLabel,
  probMenuCheckedLevel,
  applyProbMenuPick,
  clipProbMenuCheckedLevel,
  applyClipProbMenuPick,
  pitchProbMenuLevels,
  pitchProbMenuCheckedLevel,
  applyPitchProbMenuPick,
  clipPitchProbMenuCheckedLevel,
  applyClipPitchProbPick,
  clipPlayEveryMenuCheckedLevel,
  applyClipPlayEveryPick,
} from './clipplayer-prob-menu';
import {
  noteProbCellFill,
  noteCellFill,
  noteCellPitchUnstable,
  noteCellPitchProb,
} from './clipplayer-prob-color';
import {
  defaultNoteClip,
  probLevelToValue,
  PROB_LEVELS,
  setNotePlayEvery,
  PLAY_EVERY_MAX,
  clipHasPitchProb,
  coerceClipRecord,
  type NoteClipRecord,
  type NoteEvent,
} from '$lib/audio/modules/clip-types';
import { PITCH_PROB_LEVELS } from '$lib/audio/pitch-probability';

const clipWith = (steps: NoteEvent[]): NoteClipRecord => ({ ...defaultNoteClip(), steps });

describe('clipplayer probability menu — level list + labels', () => {
  it('lists all 40 levels HIGH→LOW (100% first = the default-checked item, 2.5% last)', () => {
    const levels = probMenuLevels();
    expect(levels).toHaveLength(PROB_LEVELS);
    expect(levels[0]).toBe(40); // 100% first
    expect(levels[levels.length - 1]).toBe(1); // 2.5% last
  });
  it('probPctLabel: integer percents show no decimal, half-steps keep one', () => {
    expect(probPctLabel(probLevelToValue(40))).toBe('100%');
    expect(probPctLabel(probLevelToValue(1))).toBe('2.5%');
    expect(probPctLabel(probLevelToValue(2))).toBe('5%');
    expect(probPctLabel(probLevelToValue(39))).toBe('97.5%');
    expect(probPctLabel(probLevelToValue(20))).toBe('50%');
  });
});

describe('clipplayer probability menu — checked level (EFFECTIVE prob)', () => {
  it('a note with no own prob in a clip with no default checks 100% (level 40)', () => {
    const clip = clipWith([{ step: 0, midi: 60, velocity: 100, lengthSteps: 1 }]);
    expect(probMenuCheckedLevel(clip, 0, 60)).toBe(PROB_LEVELS);
  });
  it('an unset note in a 95% clip checks the CLIP-DEFAULT level (its effective prob), not 100%', () => {
    const clip: NoteClipRecord = { ...defaultNoteClip(), defaultProb: 0.95, steps: [{ step: 0, midi: 60, lengthSteps: 1 }] };
    expect(probMenuCheckedLevel(clip, 0, 60)).toBe(38); // 95% → level 38 (the clip default)
  });
  it('an empty cell / no clip reports 100% (effective defaults to 1)', () => {
    const clip = clipWith([]);
    expect(probMenuCheckedLevel(clip, 3, 64)).toBe(PROB_LEVELS);
    expect(probMenuCheckedLevel(null, 0, 60)).toBe(PROB_LEVELS);
  });
  it('a note with its OWN sub-100% prob checks that level (independent of the clip default)', () => {
    const clip = clipWith([{ step: 0, midi: 60, lengthSteps: 1, prob: 0.5 }]);
    expect(probMenuCheckedLevel(clip, 0, 60)).toBe(20); // 50% → level 20
    const covering = clipWith([{ step: 2, midi: 60, lengthSteps: 3, prob: 0.025 }]);
    expect(probMenuCheckedLevel(covering, 4, 60), 'held tail resolves the covering note').toBe(1);
  });
  it('a note SET to 100% in a 50% clip checks 100% (its own stored 1.0 wins)', () => {
    const clip: NoteClipRecord = { ...defaultNoteClip(), defaultProb: 0.5, steps: [{ step: 0, midi: 60, lengthSteps: 1, prob: 1 }] };
    expect(probMenuCheckedLevel(clip, 0, 60)).toBe(PROB_LEVELS);
  });
});

describe('clipplayer probability menu — applying a pick writes via setNoteProb', () => {
  it('picking 2.5% sets prob = 0.025 on the covering note', () => {
    const clip = clipWith([{ step: 0, midi: 60, velocity: 100, lengthSteps: 1 }]);
    const next = applyProbMenuPick(clip, 0, 60, 1); // level 1 = 2.5%
    expect(next.steps[0]!.prob).toBeCloseTo(0.025, 10);
    expect(clip.steps[0]!.prob, 'immutable — original untouched').toBeUndefined();
  });
  it('picking 100% STORES prob = 1 (no delete — the note pins at 100%)', () => {
    const clip = clipWith([{ step: 0, midi: 60, lengthSteps: 1, prob: 0.4 }]);
    const next = applyProbMenuPick(clip, 0, 60, PROB_LEVELS); // level 40 = 100%
    expect(next.steps[0]!.prob, 'a 100% pick stores 1.0').toBe(1);
  });
  it('picking on an empty cell is a no-op (same reference — never creates a note)', () => {
    const clip = clipWith([{ step: 0, midi: 60, lengthSteps: 1 }]);
    expect(applyProbMenuPick(clip, 5, 72, 10)).toBe(clip);
  });
});

// ── CLIP-DEFAULT probability menu (right-click a GRID clip pad) ─────────────
describe('clipplayer CLIP-default probability menu — checked level (default = 100%)', () => {
  it('a clip with NO defaultProb checks 100% (level 40)', () => {
    expect(clipProbMenuCheckedLevel(clipWith([]))).toBe(PROB_LEVELS);
    expect(clipProbMenuCheckedLevel(null)).toBe(PROB_LEVELS);
    expect(clipProbMenuCheckedLevel(undefined)).toBe(PROB_LEVELS);
  });
  it('a clip with a sub-100% default checks its level', () => {
    const clip: NoteClipRecord = { ...defaultNoteClip(), defaultProb: 0.5 };
    expect(clipProbMenuCheckedLevel(clip)).toBe(20); // 50% → level 20
    const low: NoteClipRecord = { ...defaultNoteClip(), defaultProb: 0.025 };
    expect(clipProbMenuCheckedLevel(low)).toBe(1); // 2.5% → level 1
  });
});

describe('clipplayer CLIP-default probability menu — applying a pick writes via setClipDefaultProb', () => {
  it('picking 2.5% sets defaultProb = 0.025 (never touches note steps)', () => {
    const clip = clipWith([{ step: 0, midi: 60, prob: 0.4 }]);
    const next = applyClipProbMenuPick(clip, 1); // level 1 = 2.5%
    expect(next.defaultProb).toBeCloseTo(0.025, 10);
    expect(next.steps[0]!.prob, "the note's own prob untouched").toBe(0.4);
    expect(clip.defaultProb, 'immutable — original untouched').toBeUndefined();
  });
  it('picking 100% DELETES the defaultProb key (back to the default)', () => {
    const clip: NoteClipRecord = { ...defaultNoteClip(), defaultProb: 0.3 };
    const next = applyClipProbMenuPick(clip, PROB_LEVELS); // level 40 = 100%
    expect('defaultProb' in (next as object)).toBe(false);
  });
  it('reuses the shared 40-level list + percent labels (parity with the per-note menu)', () => {
    expect(probMenuLevels()[0]).toBe(40); // 100% first (default check)
    expect(probPctLabel(probLevelToValue(1))).toBe('2.5%');
  });
});

// ── SOURCE-AWARE card cell fill (noteProbCellFill) — the card mirror of the
// launchpad noteProbRgb: white / purple / orange by source. ─────────────────
describe('clipplayer card cell fill — source-aware colour', () => {
  const clipDef = (defaultProb: number | undefined, steps: NoteEvent[]): NoteClipRecord => {
    const c: NoteClipRecord = { ...defaultNoteClip(), steps };
    if (defaultProb !== undefined) c.defaultProb = defaultProb;
    return c;
  };
  it('empty cell → "" (CSS handles the dark/beat background)', () => {
    expect(noteProbCellFill(clipDef(undefined, []), 0, 60)).toBe('');
  });
  it("a note's own prob < 1 → PURPLE (hue 280)", () => {
    const fill = noteProbCellFill(clipDef(undefined, [{ step: 0, midi: 60, prob: 0.5 }]), 0, 60);
    expect(fill.startsWith('hsl(280 ')).toBe(true);
  });
  it('clip default < 1 (note has no own prob) → ORANGE (hue 30)', () => {
    const fill = noteProbCellFill(clipDef(0.5, [{ step: 0, midi: 60 }]), 0, 60);
    expect(fill.startsWith('hsl(30 ')).toBe(true);
  });
  it("a note's own prob is used over the clip default → purple even under a set default", () => {
    const fill = noteProbCellFill(clipDef(0.9, [{ step: 0, midi: 60, prob: 0.2 }]), 0, 60);
    expect(fill.startsWith('hsl(280 ')).toBe(true);
  });
  it('effective 100% → WHITE from either source', () => {
    expect(noteProbCellFill(clipDef(1, [{ step: 0, midi: 60 }]), 0, 60)).toBe('hsl(0 0% 96%)');
    expect(noteProbCellFill(clipDef(undefined, [{ step: 0, midi: 60, prob: 1 }]), 0, 60)).toBe('hsl(0 0% 96%)');
    expect(noteProbCellFill(clipDef(undefined, [{ step: 0, midi: 60 }]), 0, 60)).toBe('hsl(0 0% 96%)');
  });
});

// ---------------------------------------------------------------------------
// PER-NOTE PITCH PROBABILITY — the THIRD row of the same note menu. The MODEL
// (weights, distribution, determinism) is tested in
// $lib/audio/pitch-probability.test.ts; this covers the menu + storage seam
// only: the level list, the default check, the write, and the delete-at-off
// round trip that keeps a legacy clip byte-identical.
// ---------------------------------------------------------------------------
describe('clipplayer PITCH probability menu', () => {
  const noteAt60 = (extra: Partial<NoteEvent> = {}): NoteEvent => ({ step: 0, midi: 60, ...extra });

  it('lists OFF first then the 40 increments ascending (41 items)', () => {
    const levels = pitchProbMenuLevels();
    expect(levels).toHaveLength(PITCH_PROB_LEVELS + 1);
    expect(levels[0]).toBe(0); // OFF — the default check, and the bottom of the range
    expect(levels[levels.length - 1]).toBe(PITCH_PROB_LEVELS);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it('an untouched note reads OFF — there is NO clip-level default to inherit', () => {
    // Unlike firing probability, which falls back to the clip default: an unset
    // note here means "leave this pitch alone", the only safe legacy reading.
    const clip = clipWith([noteAt60()]);
    expect(pitchProbMenuCheckedLevel(clip, 0, 60)).toBe(0);
    expect(pitchProbMenuCheckedLevel(clip, 0, 61)).toBe(0); // empty cell
    expect(pitchProbMenuCheckedLevel(null, 0, 60)).toBe(0);
  });

  it('a set note reads its own level back', () => {
    for (const level of [1, 10, 20, 39, 40]) {
      const clip = applyPitchProbMenuPick(clipWith([noteAt60()]), 0, 60, level);
      expect(pitchProbMenuCheckedLevel(clip, 0, 60)).toBe(level);
    }
  });

  it('picking OFF DELETES the key — a reset note round-trips byte-identical', () => {
    const plain = clipWith([noteAt60({ velocity: 100 })]);
    const set = applyPitchProbMenuPick(plain, 0, 60, 20);
    expect(set.steps[0]).toHaveProperty('pitchProb');
    const cleared = applyPitchProbMenuPick(set, 0, 60, 0);
    expect(cleared.steps[0]).not.toHaveProperty('pitchProb');
    expect(JSON.stringify(cleared.steps)).toBe(JSON.stringify(plain.steps));
  });

  it('reads through a HELD note the same way the other two controls do', () => {
    const clip = applyPitchProbMenuPick(clipWith([noteAt60({ lengthSteps: 4 })]), 2, 60, 16);
    expect(pitchProbMenuCheckedLevel(clip, 0, 60)).toBe(16);
    expect(pitchProbMenuCheckedLevel(clip, 3, 60)).toBe(16);
    expect(clip.steps).toHaveLength(1); // set through the span, not a new note
  });

  it('an EMPTY cell is a no-op — never creates a note, same reference back', () => {
    const clip = clipWith([noteAt60()]);
    expect(applyPitchProbMenuPick(clip, 5, 72, 20)).toBe(clip);
  });

  it('is ORTHOGONAL to probability and play-every — all three coexist on one note', () => {
    let clip = clipWith([noteAt60()]);
    clip = applyProbMenuPick(clip, 0, 60, 20); // 50% firing chance
    clip = setNotePlayEvery(clip, 0, 60, 3); // every 3rd loop
    clip = applyPitchProbMenuPick(clip, 0, 60, 24); // 60% pitch instability
    expect(clip.steps[0]).toMatchObject({ prob: 0.5, playEvery: 3, pitchProb: 0.6 });
    expect(probMenuCheckedLevel(clip, 0, 60)).toBe(20);
    expect(pitchProbMenuCheckedLevel(clip, 0, 60)).toBe(24);
  });

  it('survives the load boundary: clamped, and 0 is never stored', () => {
    const round = (raw: unknown) =>
      (coerceClipRecord({ ...defaultNoteClip(), steps: [{ step: 0, midi: 60, pitchProb: raw }] }) as NoteClipRecord)
        .steps[0];
    expect(round(0.6)).toMatchObject({ pitchProb: 0.6 });
    expect(round(5)).toMatchObject({ pitchProb: 1 });
    expect(round(-1)).not.toHaveProperty('pitchProb');
    expect(round(0)).not.toHaveProperty('pitchProb');
    expect(round('nope')).not.toHaveProperty('pitchProb');
    expect(round(Number.NaN)).not.toHaveProperty('pitchProb');
  });

  it('clipHasPitchProb is the cheap scheduler guard', () => {
    expect(clipHasPitchProb(clipWith([noteAt60()]))).toBe(false);
    expect(clipHasPitchProb(applyPitchProbMenuPick(clipWith([noteAt60()]), 0, 60, 1))).toBe(true);
    expect(clipHasPitchProb(null)).toBe(false);
  });
});

describe('clipplayer PITCH probability cell marker (NOT a third colour axis)', () => {
  const clipWithNote = (extra: Partial<NoteEvent>) => clipWith([{ step: 0, midi: 60, ...extra }]);

  it('marks only a note that carries instability', () => {
    expect(noteCellPitchUnstable(clipWithNote({}), 0, 60)).toBe(false);
    expect(noteCellPitchUnstable(clipWithNote({ pitchProb: 0.5 }), 0, 60)).toBe(true);
    expect(noteCellPitchUnstable(clipWithNote({ pitchProb: 0.5 }), 0, 61)).toBe(false); // empty cell
    expect(noteCellPitchProb(clipWithNote({ pitchProb: 0.5 }), 0, 60)).toBe(0.5);
    expect(noteCellPitchProb(clipWithNote({}), 0, 60)).toBe(0);
  });

  it('does NOT touch the cell FILL — the existing two colour axes are untouched', () => {
    // The whole design decision, asserted: adding pitch instability to a note
    // must leave its probability/play-every colour byte-identical, so the pinned
    // colour permutations (and the VRT baseline) cannot move.
    for (const base of [{}, { prob: 0.5 }, { playEvery: 3 }, { prob: 0.25, playEvery: 4 }]) {
      const plain = clipWithNote(base);
      const unstable = clipWithNote({ ...base, pitchProb: 0.75 });
      expect(noteCellFill(unstable, 0, 60)).toBe(noteCellFill(plain, 0, 60));
      expect(noteProbCellFill(unstable, 0, 60)).toBe(noteProbCellFill(plain, 0, 60));
    }
  });
});

// ===========================================================================
// THE CLIP-LEVEL PICKS for the other two categories (2026-08-24). Only
// `defaultProb` has a clip-level DATA field; pitch probability and skip every
// are per-note keys, so the clip-level pick is a BULK WRITE over the notes the
// clip already holds. These tests pin both halves of that decision: the write
// reaches EVERY note, and the CHECK is honest about a clip whose notes disagree.
// ===========================================================================
describe('clipplayer CLIP-level pitch probability / skip every (the launcher-pad menu)', () => {
  // Derived from the model, never typed: the menu's skip-every domain IS
  // 1..PLAY_EVERY_MAX, so a change to the model changes this test's coverage.
  const skipCounts = Array.from({ length: PLAY_EVERY_MAX }, (_v, i) => i + 1);
  const two = (a: Partial<NoteEvent> = {}, b: Partial<NoteEvent> = {}) =>
    clipWith([
      { step: 0, midi: 60, ...a },
      { step: 4, midi: 64, ...b },
    ]);

  it('a pitch pick writes EVERY note, and level 0 removes the key from every note', () => {
    const set = applyClipPitchProbPick(two(), 20);
    expect(set.steps.map((s) => s.pitchProb)).toEqual([0.5, 0.5]);
    // Back to OFF must DELETE the key, not store 0 — a clip reset to off has to
    // round-trip byte-identical to one that never had instability.
    const off = applyClipPitchProbPick(set, 0);
    for (const s of off.steps) expect(s).not.toHaveProperty('pitchProb');
    expect(off.steps.map((s) => s.step)).toEqual([0, 4]); // notes themselves untouched
  });

  it('a skip pick writes EVERY note, and 1 removes the key from every note', () => {
    const set = applyClipPlayEveryPick(two(), 3);
    expect(set.steps.map((s) => s.playEvery)).toEqual([3, 3]);
    const back = applyClipPlayEveryPick(set, 1);
    for (const s of back.steps) expect(s).not.toHaveProperty('playEvery');
  });

  it('the CHECK is the value the notes AGREE on — and NOTHING when they disagree', () => {
    // Agreeing (including the vacuous default on a fresh clip).
    expect(clipPitchProbMenuCheckedLevel(two())).toBe(0);
    expect(clipPlayEveryMenuCheckedLevel(two())).toBe(1);
    expect(clipPitchProbMenuCheckedLevel(applyClipPitchProbPick(two(), 20))).toBe(20);
    expect(clipPlayEveryMenuCheckedLevel(applyClipPlayEveryPick(two(), 4))).toBe(4);

    // DISAGREEING → null. Showing the first note's value would be a lie about
    // the second, and a lie is worse than an unchecked list.
    expect(clipPitchProbMenuCheckedLevel(two({ pitchProb: 0.5 }, {}))).toBeNull();
    expect(clipPlayEveryMenuCheckedLevel(two({ playEvery: 3 }, { playEvery: 5 }))).toBeNull();

    // A clip with no notes agrees vacuously on the default; no clip at all is
    // null (there is nothing to check).
    expect(clipPitchProbMenuCheckedLevel(clipWith([]))).toBe(0);
    expect(clipPlayEveryMenuCheckedLevel(clipWith([]))).toBe(1);
    expect(clipPitchProbMenuCheckedLevel(null)).toBeNull();
    expect(clipPlayEveryMenuCheckedLevel(undefined)).toBeNull();
  });

  it('ROUND-TRIP: a pick then its CHECK agree at every level, both categories', () => {
    // The property that makes the menu honest: whatever you pick is what shows
    // checked next time you open it. Asserted across the whole domain rather
    // than at one sampled level.
    for (const lv of pitchProbMenuLevels()) {
      expect(clipPitchProbMenuCheckedLevel(applyClipPitchProbPick(two(), lv))).toBe(lv);
    }
    for (const n of skipCounts) {
      expect(clipPlayEveryMenuCheckedLevel(applyClipPlayEveryPick(two(), n))).toBe(n);
    }
  });

  it('the clip-level pick does NOT touch the clip DEFAULT probability, and vice versa', () => {
    // The three categories are orthogonal at clip scope exactly as they are at
    // note scope — a "skip every" pick that quietly reset the clip's firing
    // default would be the same class of bug as the copy that dropped it.
    const withDefault = applyClipProbMenuPick(two(), 20);
    expect(applyClipPitchProbPick(withDefault, 8).defaultProb).toBe(0.5);
    expect(applyClipPlayEveryPick(withDefault, 3).defaultProb).toBe(0.5);
    expect(clipProbMenuCheckedLevel(applyClipPlayEveryPick(withDefault, 3))).toBe(20);
  });
});
