// packages/web/src/lib/control/clip-surface-map.test.ts
//
// Unit tests for the CONTROLLER-AGNOSTIC clip-surface core — the placement-free
// brain the monome + Launchpad adapters share. These assert the pure clip/note/
// length logic directly (no coordinates), so a future Launchpad adapter can rely
// on it. The monome's surface behaviour is separately pinned by monome-map.test.

import { describe, it, expect } from 'vitest';
import {
  clipIndexForSlotLane,
  slotLaneForClipIndex,
  editLogicalRowToMidi,
  editPageCount,
  noteForCell,
  noteCellLevel,
  lengthEditAction,
  lengthRulers,
  shownEditPageFor,
  copyIndicatorLevel,
  LED_EMPTY,
  LED_ROOT_GUIDE,
  LED_PLAYHEAD,
  LED_NOTE_PLAYHEAD,
  LED_NOTE_BRIGHTNESS,
  LED_COPY_IND_PULSE,
} from './clip-surface-map';
import {
  defaultNoteClip,
  toggleNoteAt,
  rowToMidi,
  velBucket,
  VEL_DEFAULT,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

const clip = (over: Partial<NoteClipRecord> = {}): NoteClipRecord => ({
  ...defaultNoteClip(),
  ...over,
});

describe('clip-index math (placement-free)', () => {
  it('maps (slot, lane) → flat index row-major (lane*8+slot)', () => {
    expect(clipIndexForSlotLane(0, 0)).toBe(0);
    expect(clipIndexForSlotLane(7, 0)).toBe(7);
    expect(clipIndexForSlotLane(0, 1)).toBe(8);
    expect(clipIndexForSlotLane(7, 7)).toBe(63);
  });
  it('returns null outside the 8×8 matrix', () => {
    expect(clipIndexForSlotLane(8, 0)).toBeNull();
    expect(clipIndexForSlotLane(0, 8)).toBeNull();
    expect(clipIndexForSlotLane(-1, 0)).toBeNull();
  });
  it('slotLaneForClipIndex inverts it', () => {
    for (const i of [0, 7, 8, 33, 63]) {
      const { slot, lane } = slotLaneForClipIndex(i);
      expect(clipIndexForSlotLane(slot, lane)).toBe(i);
    }
  });
});

describe('edit-mode pitch/step math (placement-free)', () => {
  it('editLogicalRowToMidi matches the clip-types row→MIDI for the clip key', () => {
    const c = clip({ root: 60 });
    for (const r of [0, 1, 6, 7, -3]) {
      expect(editLogicalRowToMidi(c, r)).toBe(rowToMidi(r, c.root, c.scale));
    }
  });
  it('editPageCount = ceil(length/16), clamped 1..MAX_EDIT_PAGES', () => {
    expect(editPageCount(clip({ lengthSteps: 1 }))).toBe(1);
    expect(editPageCount(clip({ lengthSteps: 16 }))).toBe(1);
    expect(editPageCount(clip({ lengthSteps: 17 }))).toBe(2);
    expect(editPageCount(clip({ lengthSteps: 128 }))).toBe(MAX_EDIT_PAGES);
  });
  it('noteForCell maps (col, logicalRow, rowOffset, page) → {step, midi}', () => {
    const c = clip({ lengthSteps: 32, root: 60 });
    // page 0, col 3, row 0 → step 3, the bottom pitch row.
    expect(noteForCell(c, 3, 0, 0, 0)).toEqual({ step: 3, midi: rowToMidi(0, 60, c.scale) });
    // page 1, col 0 → step 16.
    expect(noteForCell(c, 0, 0, 0, 1)).toEqual({ step: 16, midi: rowToMidi(0, 60, c.scale) });
    // rowOffset shifts the pitch.
    expect(noteForCell(c, 0, 1, 2, 0)?.midi).toBe(rowToMidi(3, 60, c.scale));
  });
  it('noteForCell returns null beyond the clip length', () => {
    const c = clip({ lengthSteps: 8 });
    expect(noteForCell(c, 0, 0, 0, 1)).toBeNull(); // step 16 ≥ 8
    expect(noteForCell(c, 7, 0, 0, 0)).not.toBeNull(); // step 7 < 8 → valid
    expect(noteForCell(c, 8, 0, 0, 0)).toBeNull(); // step 8 ≥ 8
    expect(noteForCell(c, -1, 0)).toBeNull();
  });
});

describe('noteCellLevel — shared LED decision', () => {
  it('empty cell off; under playhead it washes', () => {
    const c = clip({ root: 0 }); // root pc 0
    // a non-root, off-playhead empty cell is dark
    expect(noteCellLevel(c, 0, 62, false)).toBe(LED_EMPTY);
    // under the playhead → the wash
    expect(noteCellLevel(c, 0, 62, true)).toBe(LED_PLAYHEAD);
  });
  it('marks root-pitch-class rows with the faint guide', () => {
    const c = clip({ root: 60 }); // pc 0 → midi 60, 72…
    expect(noteCellLevel(c, 0, 60, false)).toBe(LED_ROOT_GUIDE);
  });
  it('a placed note lights by velocity bucket; boosted under the playhead', () => {
    const c0 = clip({ root: 60, lengthSteps: 16 });
    const c = toggleNoteAt(c0, 2, 67); // place a default-velocity note
    expect(noteCellLevel(c, 2, 67, false)).toBe(LED_NOTE_BRIGHTNESS[velBucket(VEL_DEFAULT)]);
    expect(noteCellLevel(c, 2, 67, true)).toBe(LED_NOTE_PLAYHEAD);
  });
});

describe('shownEditPageFor', () => {
  const c = clip({ lengthSteps: 64 }); // 4 pages
  it('follows the playhead page when followOn', () => {
    expect(shownEditPageFor(c, true, 0, 9)).toBe(0);
    expect(shownEditPageFor(c, true, 20, 9)).toBe(1);
    expect(shownEditPageFor(c, true, -1, 9)).toBe(0); // not playing → page 0
  });
  it('uses the clamped frozen page when !followOn', () => {
    expect(shownEditPageFor(c, false, 20, 2)).toBe(2);
    expect(shownEditPageFor(c, false, 20, 99)).toBe(3); // clamp to last page
    expect(shownEditPageFor(c, false, 20, -5)).toBe(0);
  });
});

describe('lengthEditAction + lengthRulers (placement-free)', () => {
  it('classifies block / step / exit cells', () => {
    expect(lengthEditAction(0, 0, false)).toEqual({ kind: 'block', block: 1 });
    expect(lengthEditAction(0, MAX_EDIT_PAGES - 1, false)).toEqual({
      kind: 'block', block: MAX_EDIT_PAGES,
    });
    expect(lengthEditAction(1, 0, false)).toEqual({ kind: 'step', step: 1 });
    expect(lengthEditAction(1, STEPS_PER_PAGE - 1, false)).toEqual({
      kind: 'step', step: STEPS_PER_PAGE,
    });
    expect(lengthEditAction(0, 5, true)).toEqual({ kind: 'exit' });
  });
  it('returns null for unused cells', () => {
    expect(lengthEditAction(0, MAX_EDIT_PAGES, false)).toBeNull();
    expect(lengthEditAction(1, STEPS_PER_PAGE, false)).toBeNull();
    expect(lengthEditAction(5, 0, false)).toBeNull();
  });
  it('lengthRulers reports end block + end step of the clip length', () => {
    expect(lengthRulers(clip({ lengthSteps: 16 }))).toEqual({ endBlock: 1, endStep: 16 });
    expect(lengthRulers(clip({ lengthSteps: 17 }))).toEqual({ endBlock: 2, endStep: 1 });
    expect(lengthRulers(clip({ lengthSteps: 40 }))).toEqual({ endBlock: 3, endStep: 8 });
  });
});

describe('copyIndicatorLevel', () => {
  it('cycles the pulse ramp by blink phase (and handles negatives)', () => {
    for (let p = 0; p < LED_COPY_IND_PULSE.length * 2; p++) {
      expect(copyIndicatorLevel(p)).toBe(LED_COPY_IND_PULSE[p % LED_COPY_IND_PULSE.length]);
    }
    expect(copyIndicatorLevel(-1)).toBe(LED_COPY_IND_PULSE[LED_COPY_IND_PULSE.length - 1]);
  });
});
