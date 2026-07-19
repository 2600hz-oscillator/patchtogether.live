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
} from './clipplayer-prob-menu';
import { noteProbCellFill } from './clipplayer-prob-color';
import {
  defaultNoteClip,
  probLevelToValue,
  PROB_LEVELS,
  type NoteClipRecord,
  type NoteEvent,
} from '$lib/audio/modules/clip-types';

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
