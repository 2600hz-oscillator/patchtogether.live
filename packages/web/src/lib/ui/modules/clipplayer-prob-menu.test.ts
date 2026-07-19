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
} from './clipplayer-prob-menu';
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

describe('clipplayer probability menu — checked level (default = 100%)', () => {
  it('a note with NO prob key checks 100% (level 40) by default', () => {
    const clip = clipWith([{ step: 0, midi: 60, velocity: 100, lengthSteps: 1 }]);
    expect(probMenuCheckedLevel(clip, 0, 60)).toBe(PROB_LEVELS);
  });
  it('an empty cell also reports 100% (probEff defaults to 1)', () => {
    const clip = clipWith([]);
    expect(probMenuCheckedLevel(clip, 3, 64)).toBe(PROB_LEVELS);
    expect(probMenuCheckedLevel(null, 0, 60)).toBe(PROB_LEVELS);
  });
  it('a note with a sub-100% prob checks its level', () => {
    const clip = clipWith([{ step: 0, midi: 60, lengthSteps: 1, prob: 0.5 }]);
    expect(probMenuCheckedLevel(clip, 0, 60)).toBe(20); // 50% → level 20
    const covering = clipWith([{ step: 2, midi: 60, lengthSteps: 3, prob: 0.025 }]);
    expect(probMenuCheckedLevel(covering, 4, 60), 'held tail resolves the covering note').toBe(1);
  });
});

describe('clipplayer probability menu — applying a pick writes via setNoteProb', () => {
  it('picking 2.5% sets prob = 0.025 on the covering note', () => {
    const clip = clipWith([{ step: 0, midi: 60, velocity: 100, lengthSteps: 1 }]);
    const next = applyProbMenuPick(clip, 0, 60, 1); // level 1 = 2.5%
    expect(next.steps[0]!.prob).toBeCloseTo(0.025, 10);
    expect(clip.steps[0]!.prob, 'immutable — original untouched').toBeUndefined();
  });
  it('picking 100% DELETES the prob key (back to the default)', () => {
    const clip = clipWith([{ step: 0, midi: 60, lengthSteps: 1, prob: 0.4 }]);
    const next = applyProbMenuPick(clip, 0, 60, PROB_LEVELS); // level 40 = 100%
    expect('prob' in (next.steps[0] as object)).toBe(false);
  });
  it('picking on an empty cell is a no-op (same reference — never creates a note)', () => {
    const clip = clipWith([{ step: 0, midi: 60, lengthSteps: 1 }]);
    expect(applyProbMenuPick(clip, 5, 72, 10)).toBe(clip);
  });
});
