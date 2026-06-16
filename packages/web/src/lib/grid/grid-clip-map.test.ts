// packages/web/src/lib/grid/grid-clip-map.test.ts
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
  computeSessionLeds,
  computeEditLeds,
  CTRL_STOP_COL,
  CTRL_SCENE_COL,
  EDIT_PAD,
  STOPALL_PAD,
  TRANSPORT_PAD,
  EDIT_EXIT_PAD,
  VEL_PAD,
  OCT_DOWN_PAD,
  OCT_UP_PAD,
  ROW_DOWN_PAD,
  ROW_UP_PAD,
  SCALE_PAD,
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
} from './grid-clip-map';
import { GRID_WIDTH } from './mext';
import {
  defaultNoteClip,
  clipIndex,
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
