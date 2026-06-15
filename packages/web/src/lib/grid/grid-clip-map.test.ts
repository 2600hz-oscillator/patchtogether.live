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
  computeSessionLeds,
  computeEditLeds,
  CTRL_STOP_COL,
  CTRL_SCENE_COL,
  EDIT_PAD,
  STOPALL_PAD,
  TRANSPORT_PAD,
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
  LED_NOTE,
  LED_NOTE_PLAYHEAD,
  LED_PLAYHEAD,
  LED_ROOT_GUIDE,
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

describe('edit-mode note grid (X=step, Y=pitch)', () => {
  it('bottom row = clip root; row 0 = top (in-key octave up)', () => {
    const c = clip({ root: 48, scale: 'major' });
    expect(editRowToMidi(c, 7)).toBe(48); // root
    expect(editRowToMidi(c, 0)).toBe(60); // 7 major degrees up = +1 octave
  });
  it('editPadToNote maps step=x; reserves the EDIT pad; clamps to length', () => {
    const c = clip({ lengthSteps: 8 });
    expect(editPadToNote(c, 5, 3)).toEqual({ step: 5, midi: editRowToMidi(c, 3) });
    expect(editPadToNote(c, EDIT_PAD.x, EDIT_PAD.y)).toBeNull(); // reserved
    expect(editPadToNote(c, 10, 0)).toBeNull(); // beyond an 8-step clip
  });
  it('computeEditLeds lights a note (single level), the EDIT pad + a root guide', () => {
    const midi = editRowToMidi(clip(), 4);
    const c = clip({ steps: [{ step: 2, midi, velocity: 100, lengthSteps: 1 }] });
    const f = computeEditLeds(c, -1);
    expect(f[fi(2, 4)]).toBe(LED_NOTE);
    expect(f[fi(EDIT_PAD.x, EDIT_PAD.y)]).toBe(LED_EDIT_PAD);
    expect(f[fi(0, 7)]).toBe(LED_ROOT_GUIDE); // bottom row = root pitch class
  });
  it('a held note lights its WHOLE span (not just the start cell)', () => {
    const midi = editRowToMidi(clip(), 4);
    const c = clip({ steps: [{ step: 2, midi, velocity: 100, lengthSteps: 3 }] });
    const f = computeEditLeds(c, -1);
    expect(f[fi(2, 4)]).toBe(LED_NOTE);
    expect(f[fi(3, 4)]).toBe(LED_NOTE);
    expect(f[fi(4, 4)]).toBe(LED_NOTE);
    expect(f[fi(5, 4)]).toBe(LED_EMPTY); // span ended
  });
  it('the playhead column washes empty cells + brightens the note it crosses', () => {
    const midi = editRowToMidi(clip(), 4);
    const c = clip({ steps: [{ step: 2, midi, velocity: 100, lengthSteps: 1 }] });
    const f = computeEditLeds(c, 2); // playhead at step 2
    expect(f[fi(2, 4)]).toBe(LED_NOTE_PLAYHEAD); // note under the playhead
    expect(f[fi(2, 0)]).toBe(LED_PLAYHEAD); // empty cell in the playhead column
  });
});
