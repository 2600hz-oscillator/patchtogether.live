// packages/web/src/lib/control/monome/monome-map.test.ts
import { describe, it, expect } from 'vitest';
import {
  padToClipIndex,
  clipIndexToPad,
  stopLaneForPad,
  sceneSlotForPad,
  isEditPad,
  isStopAllPad,
  isTransportPad,
  editRowToMidi,
  editPadToNote,
  isEditExitPad,
  isVelPad,
  isOctDownPad,
  isOctUpPad,
  isRowDownPad,
  isRowUpPad,
  isScalePad,
  isFollowPad,
  isPageLeftPad,
  isPageRightPad,
  isDoublePad,
  isLengthEditPad,
  isCopyPad,
  isPastePad,
  isPasteRevPad,
  isLengthEditExitPad,
  lengthEditPad,
  editPageCount,
  computeSessionLeds,
  computeEditLeds,
  computeLengthEditLeds,
  CTRL_STOP_COL,
  CTRL_SCENE_COL,
  EDIT_PAD,
  COPY_PAD,
  COPY_IND_PAD,
  PASTE_PAD,
  PASTE_REV_PAD,
  STOPALL_PAD,
  TRANSPORT_PAD,
  EDIT_EXIT_PAD,
  VEL_PAD,
  OCT_DOWN_PAD,
  OCT_UP_PAD,
  ROW_DOWN_PAD,
  ROW_UP_PAD,
  SCALE_PAD,
  FOLLOW_PAD,
  PAGE_LEFT_PAD,
  PAGE_RIGHT_PAD,
  DOUBLE_PAD,
  LENGTH_EDIT_PAD,
  NOTE_ROWS,
  LED_EMPTY,
  LED_LOADED,
  LED_PLAYING,
  LED_QUEUED_HI,
  LED_QUEUED_LO,
  LED_STOP_IDLE,
  LED_STOP_ACTIVE,
  LED_SCENE_IDLE,
  LED_EDIT_PAD,
  LED_TRANSPORT_ON,
  LED_NOTE_BRIGHTNESS,
  LED_NOTE_PLAYHEAD,
  LED_PLAYHEAD,
  LED_ROOT_GUIDE,
  LED_FUNC,
  LED_FUNC_ON,
  LED_FUNC_DIM,
  LED_FUNC_FLASH,
  LED_MOD_IDLE,
  LED_MOD_ON,
  LED_COPY_IND_PULSE,
  LED_LEN_BLOCK,
  LED_LEN_END,
  LED_LEN_EXIT,
} from './monome-map';
import { GRID_WIDTH } from './mext';
import {
  defaultNoteClip,
  clipIndex,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
  type ClipPlayerData,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

const fi = (x: number, y: number) => y * GRID_WIDTH + x;
const clip = (over: Partial<NoteClipRecord> = {}): NoteClipRecord => ({
  ...defaultNoteClip(),
  ...over,
});

describe('pad ↔ clip mapping (left 8×8 quadrant: x=slot, y=lane)', () => {
  it('maps left-quadrant pads to clip indices row-major (lane*8+slot)', () => {
    expect(padToClipIndex(0, 0)).toBe(0);
    expect(padToClipIndex(7, 0)).toBe(7);
    expect(padToClipIndex(0, 1)).toBe(8); // lane 1, slot 0
    expect(padToClipIndex(7, 7)).toBe(63);
  });
  it('returns null for the control strip + out of range', () => {
    expect(padToClipIndex(8, 0)).toBeNull();
    expect(padToClipIndex(15, 7)).toBeNull();
    expect(padToClipIndex(-1, 0)).toBeNull();
  });
  it('clipIndexToPad inverts padToClipIndex', () => {
    for (const i of [0, 7, 8, 33, 63]) {
      const { x, y } = clipIndexToPad(i);
      expect(padToClipIndex(x, y)).toBe(i);
    }
  });
});

describe('control-strip classifiers', () => {
  it('STOP column → the lane it stops', () => {
    expect(stopLaneForPad(CTRL_STOP_COL, 0)).toBe(0);
    expect(stopLaneForPad(CTRL_STOP_COL, 7)).toBe(7);
    expect(stopLaneForPad(0, 0)).toBeNull();
  });
  it('SCENE column → the slot it launches across lanes', () => {
    expect(sceneSlotForPad(CTRL_SCENE_COL, 0)).toBe(0);
    expect(sceneSlotForPad(CTRL_SCENE_COL, 5)).toBe(5);
    expect(sceneSlotForPad(CTRL_STOP_COL, 5)).toBeNull();
  });
  it('EDIT / STOP-ALL / TRANSPORT pads are distinct corners', () => {
    expect(isEditPad(EDIT_PAD.x, EDIT_PAD.y)).toBe(true);
    expect(isStopAllPad(STOPALL_PAD.x, STOPALL_PAD.y)).toBe(true);
    expect(isTransportPad(TRANSPORT_PAD.x, TRANSPORT_PAD.y)).toBe(true);
    expect(isEditPad(0, 0)).toBe(false);
    // never collide with a clip pad
    expect(padToClipIndex(EDIT_PAD.x, EDIT_PAD.y)).toBeNull();
  });
});

describe('computeSessionLeds (per-lane)', () => {
  it('empty bank → clip pads off; control pads at idle defaults', () => {
    const f = computeSessionLeds({}, false);
    expect(f[fi(0, 0)]).toBe(LED_EMPTY);
    expect(f[fi(7, 7)]).toBe(LED_EMPTY);
    expect(f[fi(CTRL_STOP_COL, 0)]).toBe(LED_STOP_IDLE);
    expect(f[fi(CTRL_SCENE_COL, 0)]).toBe(LED_SCENE_IDLE);
    expect(f[fi(EDIT_PAD.x, EDIT_PAD.y)]).toBe(LED_EDIT_PAD);
    expect(f[fi(TRANSPORT_PAD.x, TRANSPORT_PAD.y)]).toBe(LED_STOP_IDLE);
  });

  it('loaded → medium; per-lane playing → full + that lane STOP active', () => {
    const data: ClipPlayerData = {
      clips: { [String(clipIndex(0, 0))]: clip(), [String(clipIndex(1, 1))]: clip() },
      playing: [null, 1, null, null, null, null, null, null], // lane1 plays slot1
    };
    const f = computeSessionLeds(data, false);
    expect(f[fi(0, 0)]).toBe(LED_LOADED); // lane0 slot0 loaded, idle
    expect(f[fi(1, 1)]).toBe(LED_PLAYING); // lane1 slot1 playing
    expect(f[fi(CTRL_STOP_COL, 1)]).toBe(LED_STOP_ACTIVE);
    expect(f[fi(CTRL_STOP_COL, 0)]).toBe(LED_STOP_IDLE);
  });

  it('queued-to-launch blinks dim↔bright (per lane)', () => {
    const data: ClipPlayerData = {
      clips: { [String(clipIndex(3, 2))]: clip() },
      queued: [null, null, 3, null, null, null, null, null], // lane2 → slot3
    };
    expect(computeSessionLeds(data, true)[fi(3, 2)]).toBe(LED_QUEUED_HI);
    expect(computeSessionLeds(data, false)[fi(3, 2)]).toBe(LED_QUEUED_LO);
  });

  it('queued-to-stop blinks the playing pad down', () => {
    const data: ClipPlayerData = {
      clips: { [String(clipIndex(0, 0))]: clip() },
      playing: [0, null, null, null, null, null, null, null],
      queued: ['stop', null, null, null, null, null, null, null],
    };
    expect(computeSessionLeds(data, false)[fi(0, 0)]).toBe(LED_PLAYING);
    expect(computeSessionLeds(data, true)[fi(0, 0)]).toBe(LED_LOADED);
  });

  it('opts light the EDIT (armed) + TRANSPORT (running) pads', () => {
    const f = computeSessionLeds({}, false, { transportRunning: true, editArmed: true });
    expect(f[fi(TRANSPORT_PAD.x, TRANSPORT_PAD.y)]).toBe(LED_TRANSPORT_ON);
    expect(f[fi(EDIT_PAD.x, EDIT_PAD.y)]).toBe(LED_PLAYING); // armed = bright
  });
});

describe('edit-mode note grid (7 rows × 16 steps) + function row', () => {
  it('bottom NOTE row = clip root; rowOffset scrolls by scale-degree rows', () => {
    const c = clip({ root: 48, scale: 'major' });
    expect(editRowToMidi(c, NOTE_ROWS - 1)).toBe(48); // bottom note row = root
    expect(editRowToMidi(c, NOTE_ROWS - 1, 1)).toBe(50); // +1 ROW = next degree (D)
    expect(editRowToMidi(c, NOTE_ROWS - 1, 7)).toBe(60); // +7 rows (major scaleLen) = +1 octave
  });
  it('editPadToNote maps step=x; rejects the function row; clamps to length', () => {
    const c = clip({ lengthSteps: 8 });
    expect(editPadToNote(c, 5, 3)).toEqual({ step: 5, midi: editRowToMidi(c, 3) });
    expect(editPadToNote(c, 0, NOTE_ROWS)).toBeNull(); // function row, not a note
    expect(editPadToNote(c, 10, 0)).toBeNull(); // beyond an 8-step clip
  });
  it('function-row pad classifiers (with ROW± + spacer layout)', () => {
    expect(isEditExitPad(EDIT_EXIT_PAD.x, EDIT_EXIT_PAD.y)).toBe(true);
    expect(isVelPad(VEL_PAD.x, VEL_PAD.y)).toBe(true);
    expect(isRowDownPad(ROW_DOWN_PAD.x, ROW_DOWN_PAD.y)).toBe(true);
    expect(isOctDownPad(OCT_DOWN_PAD.x, OCT_DOWN_PAD.y)).toBe(true);
    expect(isRowUpPad(ROW_UP_PAD.x, ROW_UP_PAD.y)).toBe(true);
    expect(isOctUpPad(OCT_UP_PAD.x, OCT_UP_PAD.y)).toBe(true);
    expect(isScalePad(SCALE_PAD.x, SCALE_PAD.y)).toBe(true);
    expect(editPadToNote(clip(), VEL_PAD.x, VEL_PAD.y)).toBeNull(); // never a note cell
    // The decided layout: [EDIT][VEL]_[ROW−][OCT−]_[ROW+][OCT+]_[SCALE].
    expect([EDIT_EXIT_PAD.x, VEL_PAD.x, ROW_DOWN_PAD.x, OCT_DOWN_PAD.x, ROW_UP_PAD.x, OCT_UP_PAD.x, SCALE_PAD.x])
      .toEqual([0, 1, 3, 4, 6, 7, 9]);
  });
  it('computeEditLeds lights a note by velocity colour + the function row + a root guide', () => {
    const midi = editRowToMidi(clip(), 4);
    const c = clip({ steps: [{ step: 2, midi, velocity: 80, lengthSteps: 1 }] }); // level 3 → bucket 1 (med)
    const f = computeEditLeds(c, -1);
    expect(f[fi(2, 4)]).toBe(LED_NOTE_BRIGHTNESS[1]);
    expect(f[fi(0, NOTE_ROWS - 1)]).toBe(LED_ROOT_GUIDE); // bottom note row = root pc
    expect(f[fi(EDIT_EXIT_PAD.x, EDIT_EXIT_PAD.y)]).toBe(LED_FUNC);
    expect(f[fi(ROW_DOWN_PAD.x, ROW_DOWN_PAD.y)]).toBe(LED_FUNC);
    expect(f[fi(ROW_UP_PAD.x, ROW_UP_PAD.y)]).toBe(LED_FUNC);
    expect(f[fi(OCT_UP_PAD.x, OCT_UP_PAD.y)]).toBe(LED_FUNC);
    expect(f[fi(SCALE_PAD.x, SCALE_PAD.y)]).toBe(LED_FUNC);
    expect(f[fi(2, NOTE_ROWS)]).toBe(LED_EMPTY); // a spacer pad stays dark
  });
  it('a 0%-velocity (ghost) note still lights the low colour, never off', () => {
    const midi = editRowToMidi(clip(), 4);
    const c = clip({ steps: [{ step: 2, midi, velocity: 0, lengthSteps: 1 }] });
    const f = computeEditLeds(c, -1);
    expect(f[fi(2, 4)]).toBe(LED_NOTE_BRIGHTNESS[0]); // bucket 0 (low)
    expect(LED_NOTE_BRIGHTNESS[0]).toBeGreaterThan(0); // visible, not empty
  });
  it('the VEL function pad lights bright while armed', () => {
    const f = computeEditLeds(clip(), -1, 0, true);
    expect(f[fi(VEL_PAD.x, VEL_PAD.y)]).toBe(LED_FUNC_ON);
  });
  it('a held note lights its WHOLE span by velocity colour', () => {
    const midi = editRowToMidi(clip(), 4);
    const c = clip({ steps: [{ step: 2, midi, velocity: 80, lengthSteps: 3 }] });
    const f = computeEditLeds(c, -1);
    expect(f[fi(2, 4)]).toBe(LED_NOTE_BRIGHTNESS[1]);
    expect(f[fi(3, 4)]).toBe(LED_NOTE_BRIGHTNESS[1]);
    expect(f[fi(4, 4)]).toBe(LED_NOTE_BRIGHTNESS[1]);
    expect(f[fi(5, 4)]).toBe(LED_EMPTY); // span ended
  });
  it('the playhead column washes empties + brightens the note it crosses', () => {
    const midi = editRowToMidi(clip(), 4);
    const c = clip({ steps: [{ step: 2, midi, velocity: 80, lengthSteps: 1 }] });
    const f = computeEditLeds(c, 2); // playhead at step 2
    expect(f[fi(2, 4)]).toBe(LED_NOTE_PLAYHEAD); // note under the playhead
    expect(f[fi(2, 0)]).toBe(LED_PLAYHEAD); // empty cell in the playhead column
  });
});

describe('multi-page edit grid (128 steps / 8 pages)', () => {
  it('editPageCount = ceil(length/16), capped at MAX_EDIT_PAGES', () => {
    expect(editPageCount(clip({ lengthSteps: 16 }))).toBe(1);
    expect(editPageCount(clip({ lengthSteps: 17 }))).toBe(2);
    expect(editPageCount(clip({ lengthSteps: 128 }))).toBe(8);
    expect(editPageCount(clip({ lengthSteps: 1 }))).toBe(1);
  });
  it('editPadToNote maps realStep = page*16 + x (page 7, x15 → step 127)', () => {
    const c = clip({ lengthSteps: 128 });
    expect(editPadToNote(c, 15, 3, 0, 7)).toEqual({ step: 127, midi: editRowToMidi(c, 3) });
    expect(editPadToNote(c, 0, 3, 0, 1)).toEqual({ step: 16, midi: editRowToMidi(c, 3) });
  });
  it('editPadToNote returns null for a step beyond the clip length on a page', () => {
    const c = clip({ lengthSteps: 20 }); // pages 0 (0..15) + 1 (16..19)
    expect(editPadToNote(c, 3, 0, 0, 1)).toEqual({ step: 19, midi: editRowToMidi(c, 0) });
    expect(editPadToNote(c, 4, 0, 0, 1)).toBeNull(); // step 20 ≥ length
    expect(editPadToNote(c, 0, 0, 0, 8)).toBeNull(); // page 8 → step 128 ≥ length
  });
  it('the playhead column is drawn only on its OWN page', () => {
    const midi = editRowToMidi(clip(), 4);
    const c = clip({ lengthSteps: 32, steps: [{ step: 20, midi, velocity: 80, lengthSteps: 1 }] });
    // playhead at step 20 (page 1, local x=4). Showing page 1 (frozen) → drawn.
    const onPage = computeEditLeds(c, 20, { followOn: false, editPage: 1 });
    expect(onPage[fi(4, 4)]).toBe(LED_NOTE_PLAYHEAD); // note under playhead
    expect(onPage[fi(4, 0)]).toBe(LED_PLAYHEAD); // washed empty in the column
    // Showing page 0 → the playhead (on page 1) is NOT drawn here.
    const offPage = computeEditLeds(c, 20, { followOn: false, editPage: 0 });
    expect(offPage[fi(4, 0)]).toBe(LED_EMPTY); // no playhead wash on the other page
  });
  it('FOLLOW auto-scrolls the shown page to the playhead', () => {
    const c = clip({ lengthSteps: 48 });
    // following + playhead on page 2 → page 2 is shown; the function row's note
    // cells reflect that page. We assert via a note placed on page 2.
    const midi = editRowToMidi(c, 4);
    const c2 = { ...c, steps: [{ step: 34, midi, velocity: 80, lengthSteps: 1 }] }; // page 2, x=2
    const f = computeEditLeds(c2, 34, { followOn: true });
    expect(f[fi(2, 4)]).toBe(LED_NOTE_PLAYHEAD);
  });
});

describe('edit-mode FOLLOW / LEFT / RIGHT / DOUBLE / LENGTH function pads', () => {
  it('classifies the new function-row pads at their columns', () => {
    expect(isFollowPad(FOLLOW_PAD.x, FOLLOW_PAD.y)).toBe(true);
    expect(isPageLeftPad(PAGE_LEFT_PAD.x, PAGE_LEFT_PAD.y)).toBe(true);
    expect(isPageRightPad(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y)).toBe(true);
    expect(isDoublePad(DOUBLE_PAD.x, DOUBLE_PAD.y)).toBe(true);
    expect(isLengthEditPad(LENGTH_EDIT_PAD.x, LENGTH_EDIT_PAD.y)).toBe(true);
    // The decided layout columns: FOLLOW 11, LEFT 12, RIGHT 13, DOUBLE 14, LEN 15.
    expect([FOLLOW_PAD.x, PAGE_LEFT_PAD.x, PAGE_RIGHT_PAD.x, DOUBLE_PAD.x, LENGTH_EDIT_PAD.x])
      .toEqual([11, 12, 13, 14, 15]);
    // none of the new pads is ever a note cell.
    for (const p of [FOLLOW_PAD, PAGE_LEFT_PAD, PAGE_RIGHT_PAD, DOUBLE_PAD, LENGTH_EDIT_PAD]) {
      expect(editPadToNote(clip(), p.x, p.y)).toBeNull();
    }
  });
  it('FOLLOW pad is steady-ON while following, FLASHES while frozen', () => {
    const following = computeEditLeds(clip(), -1, { followOn: true });
    expect(following[fi(FOLLOW_PAD.x, FOLLOW_PAD.y)]).toBe(LED_FUNC_ON);
    const frozen = computeEditLeds(clip({ lengthSteps: 48 }), -1, { followOn: false, editPage: 1 });
    expect(frozen[fi(FOLLOW_PAD.x, FOLLOW_PAD.y)]).toBe(LED_FUNC_FLASH);
  });
  it('LEFT/RIGHT are DIM while following (no-op)', () => {
    const f = computeEditLeds(clip({ lengthSteps: 48 }), -1, { followOn: true });
    expect(f[fi(PAGE_LEFT_PAD.x, PAGE_LEFT_PAD.y)]).toBe(LED_FUNC_DIM);
    expect(f[fi(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y)]).toBe(LED_FUNC_DIM);
  });
  it('LEFT is DIM at the leftmost page, RIGHT is DIM at the rightmost (frozen)', () => {
    const c = clip({ lengthSteps: 48 }); // 3 pages: 0,1,2
    const atLeft = computeEditLeds(c, -1, { followOn: false, editPage: 0 });
    expect(atLeft[fi(PAGE_LEFT_PAD.x, PAGE_LEFT_PAD.y)]).toBe(LED_FUNC_DIM); // no-op
    expect(atLeft[fi(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y)]).toBe(LED_FUNC); // can go right
    const atRight = computeEditLeds(c, -1, { followOn: false, editPage: 2 });
    expect(atRight[fi(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y)]).toBe(LED_FUNC_DIM); // no-op
    expect(atRight[fi(PAGE_LEFT_PAD.x, PAGE_LEFT_PAD.y)]).toBe(LED_FUNC); // can go left
  });
  it('DOUBLE + LENGTH-EDIT pads light as plain function pads', () => {
    const f = computeEditLeds(clip(), -1, { followOn: true });
    expect(f[fi(DOUBLE_PAD.x, DOUBLE_PAD.y)]).toBe(LED_FUNC);
    expect(f[fi(LENGTH_EDIT_PAD.x, LENGTH_EDIT_PAD.y)]).toBe(LED_FUNC);
  });
});

describe('LENGTH-EDIT page (2-row length editor)', () => {
  it('classifies row-0 blocks, the EXIT pad, and row-1 steps', () => {
    expect(lengthEditPad(0, 0)).toEqual({ kind: 'block', block: 1 });
    expect(lengthEditPad(MAX_EDIT_PAGES - 1, 0)).toEqual({ kind: 'block', block: MAX_EDIT_PAGES });
    expect(lengthEditPad(GRID_WIDTH - 1, 0)).toEqual({ kind: 'exit' });
    expect(isLengthEditExitPad(GRID_WIDTH - 1, 0)).toBe(true);
    expect(lengthEditPad(0, 1)).toEqual({ kind: 'step', step: 1 });
    expect(lengthEditPad(STEPS_PER_PAGE - 1, 1)).toEqual({ kind: 'step', step: STEPS_PER_PAGE });
    // unused pads (the gap on row 0 between blocks + EXIT, rows 2..7) → null.
    expect(lengthEditPad(MAX_EDIT_PAGES, 0)).toBeNull();
    expect(lengthEditPad(0, 2)).toBeNull();
  });
  it.each([
    // L, endBlock, endStep
    [1, 1, 1],
    [16, 1, 16],
    [17, 2, 1],
    [113, 8, 1],
    [128, 8, 16],
  ])('computeLengthEditLeds for L=%i lights block=%i + step=%i bright', (L, block, step) => {
    const f = computeLengthEditLeds(clip({ lengthSteps: L }));
    // ROW 0: counted blocks LOW, end block BRIGHT, beyond off.
    for (let x = 0; x < MAX_EDIT_PAGES; x++) {
      const cell = x + 1;
      const want = cell < block ? LED_LEN_BLOCK : cell === block ? LED_LEN_END : LED_EMPTY;
      expect(f[fi(x, 0)]).toBe(want);
    }
    expect(f[fi(GRID_WIDTH - 1, 0)]).toBe(LED_LEN_EXIT); // EXIT pad
    // ROW 1: counted steps LOW, end step BRIGHT, beyond off.
    for (let x = 0; x < STEPS_PER_PAGE; x++) {
      const cell = x + 1;
      const want = cell < step ? LED_LEN_BLOCK : cell === step ? LED_LEN_END : LED_EMPTY;
      expect(f[fi(x, 1)]).toBe(want);
    }
    // rows 2..7 reserved (dark).
    expect(f[fi(0, 2)]).toBe(LED_EMPTY);
  });
});

describe('session COPY / PASTE / PASTE-REV controls + indicator', () => {
  it('classifies the right-column copy/paste pads', () => {
    expect(isCopyPad(COPY_PAD.x, COPY_PAD.y)).toBe(true);
    expect(isPastePad(PASTE_PAD.x, PASTE_PAD.y)).toBe(true);
    expect(isPasteRevPad(PASTE_REV_PAD.x, PASTE_REV_PAD.y)).toBe(true);
    // right-column stacking: EDIT(0) COPY(2) IND(3) PASTE(4) PASTE-REV(5) STOPALL(6) XPORT(7).
    expect([EDIT_PAD.y, COPY_PAD.y, COPY_IND_PAD.y, PASTE_PAD.y, PASTE_REV_PAD.y, STOPALL_PAD.y, TRANSPORT_PAD.y])
      .toEqual([0, 2, 3, 4, 5, 6, 7]);
    // never a clip cell.
    for (const p of [COPY_PAD, PASTE_PAD, PASTE_REV_PAD]) {
      expect(padToClipIndex(p.x, p.y)).toBeNull();
    }
  });
  it('computeSessionLeds lights the modifier pads bright while held', () => {
    const f = computeSessionLeds({}, false, { copyHeld: true, pasteHeld: false, pasteRevHeld: true });
    expect(f[fi(COPY_PAD.x, COPY_PAD.y)]).toBe(LED_MOD_ON);
    expect(f[fi(PASTE_PAD.x, PASTE_PAD.y)]).toBe(LED_MOD_IDLE);
    expect(f[fi(PASTE_REV_PAD.x, PASTE_REV_PAD.y)]).toBe(LED_MOD_ON);
  });
  it('COPY-INDICATOR is dark when the buffer is empty, pulses when armed', () => {
    const empty = computeSessionLeds({}, false, { bufferArmed: false });
    expect(empty[fi(COPY_IND_PAD.x, COPY_IND_PAD.y)]).toBe(LED_EMPTY);
    // armed → cycles through the 4-phase pulse ramp indexed off blinkPhase.
    for (let phase = 0; phase < LED_COPY_IND_PULSE.length; phase++) {
      const f = computeSessionLeds({}, false, { bufferArmed: true, blinkPhase: phase });
      expect(f[fi(COPY_IND_PAD.x, COPY_IND_PAD.y)]).toBe(LED_COPY_IND_PULSE[phase]);
    }
    // wraps cleanly past the ramp length.
    const wrapped = computeSessionLeds({}, false, { bufferArmed: true, blinkPhase: LED_COPY_IND_PULSE.length });
    expect(wrapped[fi(COPY_IND_PAD.x, COPY_IND_PAD.y)]).toBe(LED_COPY_IND_PULSE[0]);
  });
});
