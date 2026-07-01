// Tests for the pure note-RECORD write helpers (design P1). Covers the owner-
// locked semantics: TRUE-REPLACE punch (clearStep), mono first-note-priority,
// poly cap + dedupe, note-off span capture with loop-wrap CLAMP, and the
// 16-light playhead scaling (floor, sparse for short clips, wrap).

import { describe, it, expect } from 'vitest';
import { playheadCell, clearStep, recordNoteAt, extendRecordedNote } from './clip-record';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import type { NoteClipRecord, NoteEvent } from './clip-types';

function clip(steps: NoteEvent[], lengthSteps = 16): NoteClipRecord {
  return { kind: 'note', steps, lengthSteps, root: 48, loop: true };
}

describe('playheadCell — 16-light strip scaling', () => {
  it('len 16 → one cell per step (1:1)', () => {
    for (let s = 0; s < 16; s++) expect(playheadCell(s, 16)).toBe(s);
  });
  it('len 32 → advances every 2 steps', () => {
    expect(playheadCell(0, 32)).toBe(0);
    expect(playheadCell(1, 32)).toBe(0);
    expect(playheadCell(2, 32)).toBe(1);
    expect(playheadCell(31, 32)).toBe(15);
  });
  it('len 8 → 2 cells per step (sparse — even cells only)', () => {
    expect(playheadCell(0, 8)).toBe(0);
    expect(playheadCell(1, 8)).toBe(2);
    expect(playheadCell(4, 8)).toBe(8);
    expect(playheadCell(7, 8)).toBe(14);
  });
  it('non-power-of-2 lengths (6, 44) floor-scale monotonically', () => {
    expect(playheadCell(0, 6)).toBe(0);
    expect(playheadCell(3, 6)).toBe(8); // floor(3/6*16)=8
    expect(playheadCell(5, 6)).toBe(13); // floor(5/6*16)=13
    expect(playheadCell(0, 44)).toBe(0);
    expect(playheadCell(43, 44)).toBe(15);
    // monotonic non-decreasing across a 44-step clip
    let prev = -1;
    for (let s = 0; s < 44; s++) {
      const c = playheadCell(s, 44);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
  it('wraps by step mod len and clamps out-of-range / bad input', () => {
    expect(playheadCell(16, 16)).toBe(0); // wrap
    expect(playheadCell(33, 16)).toBe(1); // 33 mod 16 = 1
    expect(playheadCell(-1, 16)).toBe(15); // negative wraps
    expect(playheadCell(5, 0)).toBe(0); // zero length guard
    expect(playheadCell(NaN, 16)).toBe(0);
  });
});

describe('clearStep — TRUE-REPLACE punch', () => {
  it('removes only notes starting on the step', () => {
    const c = clip([
      { step: 3, midi: 60 },
      { step: 3, midi: 64 },
      { step: 5, midi: 67 },
    ]);
    const out = clearStep(c, 3);
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]!.step).toBe(5);
  });
  it('returns the SAME reference when nothing starts on the step (skip the write)', () => {
    const c = clip([{ step: 5, midi: 67 }]);
    expect(clearStep(c, 3)).toBe(c);
  });
});

describe('recordNoteAt — MONO first-note-priority', () => {
  it('adds onto an empty step', () => {
    const out = recordNoteAt(clip([]), 4, 60, { mono: true, velocity: 100 });
    expect(out.steps).toEqual([{ step: 4, midi: 60, velocity: 100, lengthSteps: 1 }]);
  });
  it('drops a second note on the same step (first wins), unchanged ref', () => {
    const c = recordNoteAt(clip([]), 4, 60, { mono: true });
    const c2 = recordNoteAt(c, 4, 67, { mono: true });
    expect(c2).toBe(c); // dropped
    expect(c2.steps).toHaveLength(1);
    expect(c2.steps[0]!.midi).toBe(60);
  });
});

describe('recordNoteAt — POLY cap + dedupe', () => {
  it('captures a chord up to POLY_CHANNEL_PAIRS then drops overflow', () => {
    let c = clip([]);
    for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) c = recordNoteAt(c, 2, 60 + i);
    expect(c.steps).toHaveLength(POLY_CHANNEL_PAIRS);
    const over = recordNoteAt(c, 2, 99);
    expect(over).toBe(c); // capped
  });
  it('drops a duplicate pitch already on the step', () => {
    const c = recordNoteAt(clip([]), 2, 60);
    expect(recordNoteAt(c, 2, 60)).toBe(c);
  });
  it('defaults velocity to VEL_DEFAULT (76) when unspecified + clamps', () => {
    expect(recordNoteAt(clip([]), 1, 60).steps[0]!.velocity).toBe(76);
    expect(recordNoteAt(clip([]), 1, 60, { velocity: 999 }).steps[0]!.velocity).toBe(127);
  });
});

describe('extendRecordedNote — note-off span, loop-wrap clamp', () => {
  it('sets a forward span', () => {
    const c = recordNoteAt(clip([]), 2, 60);
    const out = extendRecordedNote(c, 2, 60, 5); // steps 2..5 = 4 steps
    expect(out.steps[0]!.lengthSteps).toBe(4);
  });
  it('clamps a release that wrapped past the loop to the clip end', () => {
    const c = recordNoteAt(clip([], 16), 14, 60);
    const out = extendRecordedNote(c, 14, 60, 2); // off wrapped (2 < 14)
    expect(out.steps[0]!.lengthSteps).toBe(2); // 16 - 14, not a backwards span
  });
  it('clamps an over-long span to the clip end + never < 1', () => {
    const c = recordNoteAt(clip([], 16), 10, 60);
    expect(extendRecordedNote(c, 10, 60, 99).steps[0]!.lengthSteps).toBe(6); // 16-10
    expect(extendRecordedNote(c, 10, 60, 10).steps[0]!.lengthSteps).toBe(1); // same step
  });
  it('no-op (same ref) when the onset is missing or span unchanged', () => {
    const c = recordNoteAt(clip([]), 2, 60); // lengthSteps already 1
    expect(extendRecordedNote(c, 2, 60, 2)).toBe(c);
    expect(extendRecordedNote(c, 9, 99, 12)).toBe(c);
  });
});
