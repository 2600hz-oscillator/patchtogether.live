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
  customScaleRowsFor,
  clampRowOffsetFor,
  logicalRowInRange,
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
  clipIndex,
  VEL_DEFAULT,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
  CLIP_LANES,
  visibleNoteRows,
  type NoteClipRecord,
  type ClipPlayerData,
} from '$lib/audio/modules/clip-types';

const clip = (over: Partial<NoteClipRecord> = {}): NoteClipRecord => ({
  ...defaultNoteClip(),
  ...over,
});

describe('clip-index math (placement-free)', () => {
  it('maps (slot, lane) → flat index (lane*SCENE_STRIDE + slot)', () => {
    expect(clipIndexForSlotLane(0, 0)).toBe(clipIndex(0, 0)); // 0
    expect(clipIndexForSlotLane(7, 0)).toBe(clipIndex(7, 0)); // 7
    expect(clipIndexForSlotLane(0, 1)).toBe(clipIndex(0, 1)); // lane 1 slot 0 = 64
    expect(clipIndexForSlotLane(7, 7)).toBe(clipIndex(7, 7)); // lane 7 slot 7 = 455
  });
  it('returns null outside the VISIBLE 8×8 card matrix (slot ≥ CLIP_SLOTS or lane ≥ CLIP_LANES)', () => {
    expect(clipIndexForSlotLane(8, 0)).toBeNull(); // slot 8 is off the visible card grid
    expect(clipIndexForSlotLane(0, 8)).toBeNull();
    expect(clipIndexForSlotLane(-1, 0)).toBeNull();
  });
  it('slotLaneForClipIndex inverts it over the visible 8×8 quadrant', () => {
    for (const i of [clipIndex(0, 0), clipIndex(7, 0), clipIndex(0, 1), clipIndex(1, 4), clipIndex(7, 7)]) {
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

describe('CUSTOM SCALE on a hardware surface (the shared brain honours the filter)', () => {
  // The owner's rig: 4 drum notes on lane 2, MIDI ch 10 → drum triggers.
  const DRUMS = [36, 38, 42, 46];
  const dataOn = (lane: number, notes = DRUMS): ClipPlayerData => {
    const customScale: (number[] | null)[] = new Array(CLIP_LANES).fill(null);
    const customScaleOn: boolean[] = new Array(CLIP_LANES).fill(false);
    customScale[lane] = notes;
    customScaleOn[lane] = true;
    return { customScale, customScaleOn };
  };
  const c = clip({ lengthSteps: 32, root: 60 });

  it('customScaleRowsFor is UNDEFINED when the lane filter is off — the unchanged path', () => {
    expect(customScaleRowsFor(c, undefined, 2)).toBeUndefined();
    expect(customScaleRowsFor(c, {}, 2)).toBeUndefined();
    // Membership without the applied flag is still OFF.
    expect(customScaleRowsFor(c, { customScale: [DRUMS] }, 0)).toBeUndefined();
    // …and a DIFFERENT lane's filter does not leak onto this one.
    expect(customScaleRowsFor(c, dataOn(2), 3)).toBeUndefined();
  });

  it('customScaleRowsFor returns the SAME list the card renders (one source of truth)', () => {
    const rows = customScaleRowsFor(c, dataOn(2), 2);
    expect(rows).toEqual(visibleNoteRows(c, dataOn(2), 2));
    expect(rows).toEqual([46, 42, 38, 36]); // high → low
  });

  it('ROW ORDER — logical row 0 is the BOTTOM = the LOWEST member (the inversion, by example)', () => {
    // `rows` is the CARD's high→low list [46,42,38,36]; a surface's logical row
    // is bottom-up. Named example so the inversion can't silently flip:
    const rows = [46, 42, 38, 36];
    expect(editLogicalRowToMidi(c, 0, rows)).toBe(36); // bottom pad  = lowest
    expect(editLogicalRowToMidi(c, 1, rows)).toBe(38);
    expect(editLogicalRowToMidi(c, 2, rows)).toBe(42);
    expect(editLogicalRowToMidi(c, 3, rows)).toBe(46); // top of the 4 = highest
  });

  it('BACK-COMPAT — omitting `rows` (or passing an empty list) is byte-identical to before', () => {
    for (const r of [0, 1, 6, 7, -3]) {
      expect(editLogicalRowToMidi(c, r)).toBe(rowToMidi(r, c.root, c.scale));
      expect(editLogicalRowToMidi(c, r, [])).toBe(rowToMidi(r, c.root, c.scale));
      expect(logicalRowInRange(r)).toBe(true); // the full key has no end
    }
    expect(noteForCell(c, 3, 0, 0, 0)).toEqual(noteForCell(c, 3, 0, 0, 0, undefined));
  });

  it('a pad PAST the end of a 4-row scale is DEAD (null), not a duplicate of the top row', () => {
    const rows = [46, 42, 38, 36];
    // An 8-pad grid over a 4-row scale: rows 0..3 edit, rows 4..7 are inert.
    expect(noteForCell(c, 0, 0, 0, 0, rows)).toEqual({ step: 0, midi: 36 });
    expect(noteForCell(c, 0, 3, 0, 0, rows)).toEqual({ step: 0, midi: 46 });
    for (const y of [4, 5, 6, 7]) expect(noteForCell(c, 0, y, 0, 0, rows)).toBeNull();
    expect(noteForCell(c, 0, -1, 0, 0, rows)).toBeNull();
    expect(logicalRowInRange(4, rows)).toBe(false);
  });

  it('a 10-row scale PAGES: rowOffset indexes the FILTERED list, first 8 then rows 9–10', () => {
    // rows high→low; logical row 0 = the lowest (last element).
    const ten = [72, 70, 68, 67, 65, 63, 62, 60, 58, 56]; // 10 members
    expect(clampRowOffsetFor(0, ten, 8)).toBe(0);
    // Offset 0 shows the LOWEST 8 members (56 … 68 bottom-up); 70 and 72 are
    // off the top of the window until it scrolls.
    expect(noteForCell(c, 0, 0, 0, 0, ten)?.midi).toBe(56);
    expect(noteForCell(c, 0, 7, 0, 0, ten)?.midi).toBe(68);
    // Scroll up by 2 → the window reaches the top two (68 … 72).
    expect(noteForCell(c, 0, 6, 2, 0, ten)?.midi).toBe(70);
    expect(noteForCell(c, 0, 7, 2, 0, ten)?.midi).toBe(72);
    // …and it CANNOT scroll past the end: max offset = 10 - 8 = 2.
    expect(clampRowOffsetFor(5, ten, 8)).toBe(2);
    expect(clampRowOffsetFor(-3, ten, 8)).toBe(0);
    // A 4-row scale on an 8-pad grid never scrolls at all (owner: "shows them all together").
    expect(clampRowOffsetFor(4, [46, 42, 38, 36], 8)).toBe(0);
    // With the filter OFF the offset is untouched (the full key is unbounded).
    expect(clampRowOffsetFor(-3, undefined, 8)).toBe(-3);
    expect(clampRowOffsetFor(99, undefined, 8)).toBe(99);
  });

  it('NEGATIVE CONTROL — the surface pitch axis actually MOVES when the filter engages', () => {
    // If `rows` were ignored, every assertion above could pass off the full key.
    const rows = [46, 42, 38, 36];
    expect(noteForCell(c, 0, 0, 0, 0, rows)?.midi).not.toBe(noteForCell(c, 0, 0, 0, 0)?.midi);
    expect(noteForCell(c, 0, 0, 0, 0)?.midi).toBe(rowToMidi(0, 60, c.scale)); // 60, the root
  });

  it('SCOPE — this covers the surfaces that HAVE a clip note grid (Launchpad + monome)', () => {
    // Stated in the gate per the repo rule: the Push 2 has no clip note-editor
    // (its 8×8 is clip-launch + KEYS and it never calls noteForCell), so it has
    // no pitch-row axis to filter. If one is added it must route through here.
    // The two adapters that DO have one are pinned in their own specs:
    // launchpad-map.test.ts and monome-map.test.ts.
    expect(typeof customScaleRowsFor).toBe('function');
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
