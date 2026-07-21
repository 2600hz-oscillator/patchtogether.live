// packages/web/src/lib/ui/modules/clipplayer-play-every-color.test.ts
//
// The card cell fill combines PROBABILITY with PLAY EVERY (mirroring the
// Launchpad `noteRgb`): a play-every-1 note keeps the EXACT prob-only hsl (so the
// probability permutation table stays pinned); play-every>1 tints red (dimmer
// the higher N); both → an rgb() average. PURE.

import { describe, it, expect } from 'vitest';
import { defaultNoteClip, type NoteClipRecord, type NoteEvent } from '$lib/audio/modules/clip-types';
import { noteCellFill, noteProbCellFill } from './clipplayer-prob-color';

function clip(ev: Partial<NoteEvent>): NoteClipRecord {
  return { ...defaultNoteClip(), steps: [{ step: 0, midi: 60, velocity: 100, lengthSteps: 1, ...ev }] };
}

describe('noteCellFill (probability ⊕ play-every)', () => {
  it('empty cell → ""', () => {
    expect(noteCellFill(clip({}), 5, 40)).toBe('');
  });

  it('play-every 1 (default) → the EXACT prob-only hsl (unchanged)', () => {
    const c = clip({ prob: 0.5 });
    expect(noteCellFill(c, 0, 60)).toBe(noteProbCellFill(c, 0, 60)); // byte-identical
    const white = clip({}); // effProb 1, playEvery 1
    expect(noteCellFill(white, 0, 60)).toBe(noteProbCellFill(white, 0, 60));
  });

  it('play-every>1 at 100% prob → an rgb() RED, dimmer the higher N', () => {
    const two = noteCellFill(clip({ playEvery: 2 }), 0, 60);
    const eight = noteCellFill(clip({ playEvery: 8 }), 0, 60);
    expect(two).toMatch(/^rgb\(/); // not the prob-only hsl
    expect(eight).toMatch(/^rgb\(/);
    const red = (s: string) => Number(s.match(/rgb\((\d+)/)![1]);
    expect(red(two), 'play-every-2 brighter red than play-every-8').toBeGreaterThan(red(eight));
  });

  it('play-every>1 AND prob<1 → an rgb() average (distinct from the pure red)', () => {
    const both = noteCellFill(clip({ prob: 0.25, playEvery: 3 }), 0, 60);
    const redOnly = noteCellFill(clip({ playEvery: 3 }), 0, 60);
    expect(both).toMatch(/^rgb\(/);
    expect(both).not.toBe(redOnly); // the probability colour pulls it away from pure red
  });
});
