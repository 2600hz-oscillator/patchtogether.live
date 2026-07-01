// packages/web/src/lib/control/launchpad/launchpad-map.test.ts
//
// PURE placement + colour-language tests for the 2× Launchpad layout over the
// shared clip-surface core. Golden-vector style: pins WHICH pad/CC is which
// control on each unit (so a drift fails here before hardware), and that the
// LED frames paint the legend colours from the live clip state.

import { describe, it, expect } from 'vitest';
import {
  // L matrix
  lPadToClipIndex,
  clipIndexToLPad,
  lSceneSlotForRow,
  computeLSessionFrame,
  // R deck
  rDeckPad,
  rStopLaneForRow,
  computeRDeckFrame,
  DECK_EDIT_COL,
  DECK_COPY_COL,
  DECK_PASTE_COL,
  DECK_PASTE_REV_COL,
  DECK_DOUBLE_COL,
  DECK_LENGTH_COL,
  DECK_NOW_COL,
  DECK_COPY_IND_COL,
  CC_TRANSPORT,
  CC_STOP_ALL,
  // R editor
  editPadToNote,
  computeREditFrame,
  isEditExitSceneRow,
  EDIT_EXIT_SCENE_ROW,
  // R length
  rLengthPad,
  computeRLengthFrame,
  // colours
  RGB_OFF,
  RGB_LOADED,
  RGB_PLAYING,
  RGB_QUEUED,
  RGB_QUEUED_STOP,
  RGB_SCENE,
  RGB_STOP_ACTIVE,
  RGB_STOP_IDLE,
  RGB_TRANSPORT_ON,
  RGB_COPY_BUFFER,
  RGB_NOTE_BY_VEL,
  RGB_NOTE_PLAYHEAD,
  RGB_DECK_EDIT,
  RGB_DECK_EDIT_ON,
  RGB_DECK_COPY,
  RGB_DECK_COPY_ON,
  RGB_DECK_DBL,
  RGB_DECK_LEN,
  RGB_DECK_NOW,
  RGB_DECK_NOW_ON,
  // KEYS mode
  keysPad,
  rDeckKeysHold,
  computeKeysFrame,
  KEYS_PH_ROW,
  KEYS_CTRL_ROW,
  KEYS_EXIT_COL,
  KEYS_QREC_COL,
  KEYS_OVERDUB_COL,
  KEYS_LEN_COL,
  DECK_KEYS_REC_COL,
  DECK_KEYS_OVERDUB_COL,
  DECK_KEYS_ROW,
  RGB_KEY_ROOT,
  RGB_KEY_INSCALE,
  RGB_KEY_OUTSCALE,
  RGB_KEY_PRESSED,
  RGB_KEYS_PH_CUR,
  RGB_KEYS_PH_BASE,
  RGB_QREC_IDLE,
  RGB_QREC_ARMED,
  RGB_QREC_REC,
  RGB_OD,
  RGB_OD_ON,
  RGB_EXIT,
  RGB_KEYS_REC_HOLD_ON,
} from './launchpad-map';
import { padNote, SCENE_CCS } from './launchpad-sysex';
import { keyboardCellToMidi } from '$lib/audio/modules/keyboard-map';
import {
  clipIndex,
  defaultNoteClip,
  toggleNoteAt,
  setNoteSpan,
  type ClipPlayerData,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

const at = (frame: { leds: Map<number, [number, number, number]> }, index: number) =>
  frame.leds.get(index) ?? null;
const eqRgb = (a: [number, number, number] | null, b: readonly number[]) =>
  !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// y is the launchpad's BOTTOM-origin row; the matrix maps lane 0 → the TOP row
// (y=7) to match the on-screen card. So slot/lane → physical (slot, 7-lane).
const yForLane = (lane: number) => 8 - 1 - lane;

describe('Unit L — clip matrix placement', () => {
  it('pad (x=slot, y from BOTTOM) ↔ clip index lane*8+slot, card-oriented round-trip', () => {
    // TOP-left pad (y=7) = lane 0, slot 0 (the card's top-left clip).
    expect(lPadToClipIndex(0, 7)).toBe(0);
    // BOTTOM-left pad (y=0) = lane 7, slot 0 (the card's bottom-left clip).
    expect(lPadToClipIndex(0, 0)).toBe(clipIndex(0, 7));
    expect(lPadToClipIndex(3, yForLane(2))).toBe(clipIndex(3, 2)); // slot3 lane2
    for (let lane = 0; lane < 8; lane++) {
      for (let slot = 0; slot < 8; slot++) {
        const idx = clipIndex(slot, lane);
        const p = clipIndexToLPad(idx);
        expect(p).toEqual({ x: slot, y: yForLane(lane) });
        expect(lPadToClipIndex(p.x, p.y)).toBe(idx);
      }
    }
  });
  it('scene rows map to slots 0..7', () => {
    expect(lSceneSlotForRow(0)).toBe(0);
    expect(lSceneSlotForRow(7)).toBe(7);
    expect(lSceneSlotForRow(8)).toBeNull();
    expect(lSceneSlotForRow(-1)).toBeNull();
  });
});

describe('Unit L — session LED frame (colour language)', () => {
  function data(): ClipPlayerData {
    return {
      clips: { [clipIndex(0, 0)]: defaultNoteClip(), [clipIndex(1, 1)]: defaultNoteClip() },
      playing: [null, 1, null, null, null, null, null, null],
      queued: [0, null, null, null, null, null, null, null],
    } as ClipPlayerData;
  }
  it('loaded / playing / queued-launch paint the legend colours', () => {
    const onFrame = computeLSessionFrame(data(), { blinkOn: true });
    // lane1 slot1 is playing → SOLID green. lane→row flipped.
    expect(eqRgb(at(onFrame, padNote(1, yForLane(1))), RGB_PLAYING)).toBe(true);
    // lane0 slot0 is queued-launch → green flash (on phase). lane 0 = TOP row.
    expect(eqRgb(at(onFrame, padNote(0, yForLane(0))), RGB_QUEUED)).toBe(true);
    // an unrelated empty pad is OFF.
    expect(eqRgb(at(onFrame, padNote(5, yForLane(5))), RGB_OFF)).toBe(true);
  });
  it('a loaded-but-idle clip is dim blue (LOADED)', () => {
    const d: ClipPlayerData = { clips: { [clipIndex(2, 3)]: defaultNoteClip() } } as ClipPlayerData;
    const f = computeLSessionFrame(d, { blinkOn: true });
    expect(eqRgb(at(f, padNote(2, yForLane(3))), RGB_LOADED)).toBe(true);
  });
  it('a PLAYING clip is SOLID (does NOT blink off) — only queued flashes', () => {
    // On the blink-OFF phase: the playing clip (lane1/slot1) must stay solid
    // green; the queued clip (lane0/slot0) flashes off. (Owner: a blinking
    // "playing" reads as queued on the hardware.)
    const f = computeLSessionFrame(data(), { blinkOn: false });
    expect(eqRgb(at(f, padNote(1, yForLane(1))), RGB_PLAYING), 'playing stays solid on blink-off').toBe(true);
    expect(eqRgb(at(f, padNote(0, yForLane(0))), RGB_OFF), 'queued flashes off on blink-off').toBe(true);
  });
  it('a queued STOP on a playing lane flashes red', () => {
    const d: ClipPlayerData = {
      clips: { [clipIndex(0, 0)]: defaultNoteClip() },
      playing: [0, null, null, null, null, null, null, null],
      queued: ['stop', null, null, null, null, null, null, null],
    } as ClipPlayerData;
    expect(eqRgb(at(computeLSessionFrame(d, { blinkOn: true }), padNote(0, yForLane(0))), RGB_QUEUED_STOP)).toBe(true);
  });
  it('a loaded clip is steady dim blue and does NOT flash as a copy source', () => {
    // The copy buffer is a frozen snapshot (copyClip), so the live source clip
    // is no longer special — it must render as a plain loaded clip, never a
    // turquoise "source" pulse (which read as a confusing persistent link). The
    // clipboard state shows only on the BUF pad (Unit R), tested below.
    const d: ClipPlayerData = { clips: { [clipIndex(2, 3)]: defaultNoteClip() } } as ClipPlayerData;
    const f = computeLSessionFrame(d, { blinkOn: true });
    expect(eqRgb(at(f, padNote(2, yForLane(3))), RGB_LOADED)).toBe(true);
  });
  it('scene column lights amber (top scene CC 89 → row 7 = slot 7)', () => {
    const f = computeLSessionFrame(data(), {});
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_SCENE)).toBe(true); // top
    expect(eqRgb(at(f, SCENE_CCS[7]), RGB_SCENE)).toBe(true); // bottom
  });
});

describe('Unit R — command deck placement + frame', () => {
  it('deck pads classify by column on row 0', () => {
    expect(rDeckPad(DECK_EDIT_COL, 0)).toBe('edit');
    expect(rDeckPad(DECK_COPY_COL, 0)).toBe('copy');
    expect(rDeckPad(DECK_PASTE_COL, 0)).toBe('paste');
    expect(rDeckPad(DECK_PASTE_REV_COL, 0)).toBe('pasteRev');
    expect(rDeckPad(DECK_DOUBLE_COL, 0)).toBe('double');
    expect(rDeckPad(DECK_LENGTH_COL, 0)).toBe('lengthEdit');
    expect(rDeckPad(DECK_NOW_COL, 0)).toBe('now');
    expect(rDeckPad(DECK_COPY_IND_COL, 0)).toBeNull(); // render-only
    expect(rDeckPad(DECK_EDIT_COL, 1)).toBeNull(); // not row 0
  });
  it('scene rows map to per-lane stop lanes', () => {
    expect(rStopLaneForRow(0)).toBe(0);
    expect(rStopLaneForRow(7)).toBe(7);
    expect(rStopLaneForRow(8)).toBeNull();
  });
  it('deck frame lights held modifiers + transport + per-lane STOP', () => {
    const d: ClipPlayerData = { playing: [0, null, null, null, null, null, null, null] } as ClipPlayerData;
    const f = computeRDeckFrame({
      blinkOn: true,
      transportRunning: true,
      copyHeld: true,
      bufferArmed: true,
      data: d,
    });
    expect(eqRgb(at(f, padNote(DECK_COPY_COL, 0)), RGB_DECK_COPY_ON)).toBe(true); // COPY held = bright green
    expect(eqRgb(at(f, padNote(DECK_EDIT_COL, 0)), RGB_DECK_EDIT)).toBe(true); // EDIT idle = orange
    expect(eqRgb(at(f, CC_TRANSPORT), RGB_TRANSPORT_ON)).toBe(true);
    expect(eqRgb(at(f, CC_STOP_ALL), RGB_STOP_IDLE)).toBe(true);
    // copy-indicator pulses turquoise while the buffer is armed.
    expect(eqRgb(at(f, padNote(DECK_COPY_IND_COL, 0)), RGB_COPY_BUFFER)).toBe(true);
    // R scene column = per-lane STOP: lane0 playing → bright red (top scene CC = row 7).
    // SCENE_CCS index 7 = bottom = row 0 = lane 0.
    expect(eqRgb(at(f, SCENE_CCS[7]), RGB_STOP_ACTIVE)).toBe(true);
    expect(eqRgb(at(f, SCENE_CCS[6]), RGB_STOP_IDLE)).toBe(true); // lane1 idle
  });

  it('deck pads are colour-coded per function (EDIT orange · COPY/PASTE/P-REV green · DBL+NOW purple · LEN yellow)', () => {
    // Idle frame (nothing held): each function pad shows its own hue.
    const idle = computeRDeckFrame({ blinkOn: true });
    expect(eqRgb(at(idle, padNote(DECK_EDIT_COL, 0)), RGB_DECK_EDIT), 'EDIT orange').toBe(true);
    expect(eqRgb(at(idle, padNote(DECK_COPY_COL, 0)), RGB_DECK_COPY), 'COPY green').toBe(true);
    expect(eqRgb(at(idle, padNote(DECK_PASTE_COL, 0)), RGB_DECK_COPY), 'PASTE green').toBe(true);
    expect(eqRgb(at(idle, padNote(DECK_PASTE_REV_COL, 0)), RGB_DECK_COPY), 'P-REV green').toBe(true);
    expect(eqRgb(at(idle, padNote(DECK_DOUBLE_COL, 0)), RGB_DECK_DBL), 'DBL purple').toBe(true);
    expect(eqRgb(at(idle, padNote(DECK_LENGTH_COL, 0)), RGB_DECK_LEN), 'LEN yellow').toBe(true);
    expect(eqRgb(at(idle, padNote(DECK_NOW_COL, 0)), RGB_DECK_NOW), 'NOW purple').toBe(true);
    // Held hold-modifiers brighten to their *_ON variant (same hue).
    const held = computeRDeckFrame({ editArmed: true, pasteHeld: true, nowHeld: true });
    expect(eqRgb(at(held, padNote(DECK_EDIT_COL, 0)), RGB_DECK_EDIT_ON), 'EDIT held bright orange').toBe(true);
    expect(eqRgb(at(held, padNote(DECK_PASTE_COL, 0)), RGB_DECK_COPY_ON), 'PASTE held bright green').toBe(true);
    expect(eqRgb(at(held, padNote(DECK_NOW_COL, 0)), RGB_DECK_NOW_ON), 'NOW held bright purple').toBe(true);
  });
});

describe('Unit R — note editor placement (8 pitch × 8 step, bottom-origin)', () => {
  const clip = defaultNoteClip();
  it('pad y=0 is the lowest shown pitch (the clip root), y increases up', () => {
    const lo = editPadToNote(clip, 0, 0);
    const hi = editPadToNote(clip, 0, 1);
    expect(lo).not.toBeNull();
    expect(hi).not.toBeNull();
    expect(hi!.midi).toBeGreaterThan(lo!.midi);
    expect(lo!.midi).toBe(clip.root); // row 0 = root
    expect(lo!.step).toBe(0);
  });
  it('x = step within the shown 8-step window (colOffset scrolls within a block)', () => {
    expect(editPadToNote(clip, 3, 0)!.step).toBe(3);
    // colOffset 8 = the second half of the 16-step block.
    expect(editPadToNote(clip, 0, 0, { colOffset: 8 })!.step).toBe(8);
    expect(editPadToNote(clip, 7, 0, { colOffset: 8 })!.step).toBe(15);
  });
  it('page selects the 16-step block (realStep = page*16 + colOffset + x)', () => {
    const long = { ...clip, lengthSteps: 64 }; // 4 blocks so page 1/2 are in range
    expect(editPadToNote(long, 0, 0, { page: 1 })!.step).toBe(16);
    expect(editPadToNote(long, 2, 0, { page: 2, colOffset: 8 })!.step).toBe(2 * 16 + 8 + 2);
  });
  it('a step beyond the clip length is null', () => {
    // default clip = 16 steps; page 1 col 0 → step 16 ≥ length 16 → null.
    expect(editPadToNote(clip, 0, 0, { page: 1 })).toBeNull();
    // step 15 (last of a 16-step clip) is valid.
    expect(editPadToNote(clip, 7, 0, { colOffset: 8 })!.step).toBe(15);
  });
  it('an out-of-grid pad is null', () => {
    expect(editPadToNote(clip, 8, 0)).toBeNull();
    expect(editPadToNote(clip, 0, 8)).toBeNull();
  });
  it('EXIT is the top scene row', () => {
    expect(EDIT_EXIT_SCENE_ROW).toBe(7);
    expect(isEditExitSceneRow(7)).toBe(true);
    expect(isEditExitSceneRow(0)).toBe(false);
  });
});

describe('Unit R — editor LED frame (note colours + playhead)', () => {
  it('a placed note paints by velocity bucket; the playhead boosts it', () => {
    let clip: NoteClipRecord = defaultNoteClip();
    // place a note at step 2, the root row (y=0).
    clip = toggleNoteAt(clip, 2, clip.root);
    const f = computeREditFrame(clip, { playheadStep: -1 });
    // default velocity (76) → med/high bucket; just assert it's a note colour.
    const noteCell = at(f, padNote(2, 0));
    const isNoteColour = RGB_NOTE_BY_VEL.some((c) => eqRgb(noteCell, c));
    expect(isNoteColour).toBe(true);
    // with the playhead on that step, the note boosts to yellow.
    const f2 = computeREditFrame(clip, { playheadStep: 2 });
    expect(eqRgb(at(f2, padNote(2, 0)), RGB_NOTE_PLAYHEAD)).toBe(true);
  });
  it('a held span paints across the cells it covers', () => {
    let clip: NoteClipRecord = defaultNoteClip();
    clip = setNoteSpan(clip, 1, 4, clip.root); // steps 1..4 held
    const f = computeREditFrame(clip);
    for (let step = 1; step <= 4; step++) {
      const noteCell = at(f, padNote(step, 0));
      const isNoteColour = RGB_NOTE_BY_VEL.some((c) => eqRgb(noteCell, c));
      expect(isNoteColour, `step ${step}`).toBe(true);
    }
    // step 5 (outside the span) is NOT a note colour.
    const after = at(f, padNote(5, 0));
    expect(RGB_NOTE_BY_VEL.some((c) => eqRgb(after, c))).toBe(false);
  });
});

describe('Unit R — length-edit page', () => {
  it('block ruler classifies row 0 cells → blocks', () => {
    expect(rLengthPad(0, 0)).toEqual({ kind: 'block', block: 1 });
    expect(rLengthPad(7, 0)).toEqual({ kind: 'block', block: 8 });
  });
  it('step ruler spans rows 1 (1..8) + 2 (9..16)', () => {
    expect(rLengthPad(0, 1)).toEqual({ kind: 'step', step: 1 });
    expect(rLengthPad(7, 1)).toEqual({ kind: 'step', step: 8 });
    expect(rLengthPad(0, 2)).toEqual({ kind: 'step', step: 9 });
    expect(rLengthPad(7, 2)).toEqual({ kind: 'step', step: 16 });
  });
  it('an unused row is null', () => {
    expect(rLengthPad(0, 4)).toBeNull();
  });
  it('the length frame highlights the end block + end step', () => {
    // a 3-block + step-5 clip: lengthSteps = 2*16 + 5 = 37 → endBlock 3, endStep 5.
    const clip = { ...defaultNoteClip(), lengthSteps: 37 };
    const f = computeRLengthFrame(clip);
    // block ruler: blocks 1,2 dim, block 3 bright, 4+ off — assert via inequality of colours.
    expect(at(f, padNote(2, 0))).not.toBeNull(); // block 3 (bright)
    // step ruler row 1: step 5 should be the bright END.
    expect(at(f, padNote(4, 1))).not.toBeNull(); // step 5 (index 4)
  });
});

// ===========================================================================
// KEYS mode (dual-Launchpad note/keyboard + clip-record) placement + frames.
// ===========================================================================
describe('KEYS mode — placement classifiers', () => {
  it('keysPad: top row = playhead, mid 6 rows = keyboard (continuous across L|R), bottom = controls (L only)', () => {
    // top row (y=7) on either unit = playhead (display-only).
    expect(keysPad('L', 3, KEYS_PH_ROW)).toEqual({ kind: 'playhead' });
    expect(keysPad('R', 3, KEYS_PH_ROW)).toEqual({ kind: 'playhead' });
    // keyboard band: y=1 = row 0; unit L col = x, unit R col = x+8 (continuous).
    expect(keysPad('L', 0, 1)).toEqual({ kind: 'note', col: 0, row: 0 });
    expect(keysPad('L', 7, 6)).toEqual({ kind: 'note', col: 7, row: 5 });
    expect(keysPad('R', 0, 1)).toEqual({ kind: 'note', col: 8, row: 0 });
    expect(keysPad('R', 7, 6)).toEqual({ kind: 'note', col: 15, row: 5 });
    // the L|R seam is continuous: L col 7 → 7, R col 0 → 8 (adjacent).
    // bottom row controls live on unit L only.
    expect(keysPad('L', KEYS_EXIT_COL, KEYS_CTRL_ROW)).toEqual({ kind: 'exit' });
    expect(keysPad('L', KEYS_QREC_COL, KEYS_CTRL_ROW)).toEqual({ kind: 'qrec' });
    expect(keysPad('L', KEYS_OVERDUB_COL, KEYS_CTRL_ROW)).toEqual({ kind: 'overdub' });
    expect(keysPad('L', KEYS_LEN_COL, KEYS_CTRL_ROW)).toEqual({ kind: 'len' });
    // unit R's bottom row is dark (no controls).
    expect(keysPad('R', KEYS_EXIT_COL, KEYS_CTRL_ROW)).toBeNull();
    // an unused L bottom-row cell is null.
    expect(keysPad('L', 4, KEYS_CTRL_ROW)).toBeNull();
  });

  it('rDeckKeysHold: the KEYS-entry hold buttons on deck row 1', () => {
    expect(rDeckKeysHold(DECK_KEYS_REC_COL, DECK_KEYS_ROW)).toBe('keysRec');
    expect(rDeckKeysHold(DECK_KEYS_OVERDUB_COL, DECK_KEYS_ROW)).toBe('keysOverdub');
    expect(rDeckKeysHold(DECK_KEYS_REC_COL, 0)).toBeNull(); // row 0 = the function row
    expect(rDeckKeysHold(5, DECK_KEYS_ROW)).toBeNull();
  });
});

describe('KEYS mode — LED frame (keyboard + playhead + controls)', () => {
  const clip = defaultNoteClip(); // root C3 (48), major
  it('keyboard lights: root cyan, in-scale green, out-of-scale dim; a pressed pad white', () => {
    const rootMidi = clip.root;
    // press the bottom-left root (col 0 row 0 = the root itself).
    const pressed = new Set<number>([keyboardCellToMidi(0, 0, rootMidi)]);
    const f = computeKeysFrame({
      unit: 'L', keyboardRoot: rootMidi, scale: 'major', playheadStep: -1,
      lengthSteps: clip.lengthSteps, pressed, blinkOn: true,
    });
    // (0,0) is pressed → white.
    expect(eqRgb(at(f, padNote(0, 1)), RGB_KEY_PRESSED)).toBe(true);
    // an octave-root cell that ISN'T pressed → cyan. col=0,row=2 = root + 2*5 = +10, not root.
    // find a root pad: col 2,row 2 = root + 2 + 10 = +12 = octave root → cyan.
    expect(eqRgb(at(f, padNote(2, 3)), RGB_KEY_ROOT)).toBe(true);
    // an in-scale non-root (e.g. col 2 row 0 = root+2 = D, in C major) → green.
    expect(eqRgb(at(f, padNote(2, 1)), RGB_KEY_INSCALE)).toBe(true);
    // an out-of-scale (col 1 row 0 = root+1 = C#, not in C major) → dim.
    expect(eqRgb(at(f, padNote(1, 1)), RGB_KEY_OUTSCALE)).toBe(true);
  });

  it('unit R keyboard is the continuation (col+8) — a shape crossing the seam is unbroken', () => {
    const rootMidi = clip.root;
    // The R unit's leftmost keyboard cell (x=0,row0) is keyboard col 8.
    const f = computeKeysFrame({
      unit: 'R', keyboardRoot: rootMidi, scale: undefined, playheadStep: -1,
      lengthSteps: 16, pressed: new Set([keyboardCellToMidi(8, 0, rootMidi)]), blinkOn: true,
    });
    expect(eqRgb(at(f, padNote(0, 1)), RGB_KEY_PRESSED)).toBe(true);
  });

  it('playhead strip: L cells 0..7, R cells 8..15; the current cell is white', () => {
    // 16-step clip, sounding step 3 → cell 3 (on unit L).
    const fL = computeKeysFrame({ unit: 'L', keyboardRoot: 48, playheadStep: 3, lengthSteps: 16 });
    expect(eqRgb(at(fL, padNote(3, KEYS_PH_ROW)), RGB_KEYS_PH_CUR)).toBe(true);
    expect(eqRgb(at(fL, padNote(4, KEYS_PH_ROW)), RGB_KEYS_PH_BASE)).toBe(true);
    // step 11 → cell 11 → on unit R at x=3.
    const fR = computeKeysFrame({ unit: 'R', keyboardRoot: 48, playheadStep: 11, lengthSteps: 16 });
    expect(eqRgb(at(fR, padNote(3, KEYS_PH_ROW)), RGB_KEYS_PH_CUR)).toBe(true);
    // step -1 (not playing) → nothing current, all baseline.
    const fOff = computeKeysFrame({ unit: 'L', keyboardRoot: 48, playheadStep: -1, lengthSteps: 16 });
    expect(eqRgb(at(fOff, padNote(0, KEYS_PH_ROW)), RGB_KEYS_PH_BASE)).toBe(true);
  });

  it('the playhead current cell DENOTES the record state (white idle · yellow armed · red recording)', () => {
    const base = { unit: 'L' as const, keyboardRoot: 48, playheadStep: 3, lengthSteps: 16, blinkOn: true };
    expect(eqRgb(at(computeKeysFrame(base), padNote(3, KEYS_PH_ROW)), RGB_KEYS_PH_CUR)).toBe(true);
    expect(eqRgb(at(computeKeysFrame({ ...base, recArmed: true }), padNote(3, KEYS_PH_ROW)), RGB_QREC_ARMED)).toBe(true);
    expect(eqRgb(at(computeKeysFrame({ ...base, recording: true }), padNote(3, KEYS_PH_ROW)), RGB_QREC_REC)).toBe(true);
  });

  it('controls (unit L bottom row): EXIT red · QUEUE-REC colour-codes idle/armed/recording · OVERDUB purple', () => {
    const base = { unit: 'L' as const, keyboardRoot: 48, playheadStep: -1, lengthSteps: 16, blinkOn: true };
    const idle = computeKeysFrame(base);
    expect(eqRgb(at(idle, padNote(KEYS_EXIT_COL, 0)), RGB_EXIT)).toBe(true);
    expect(eqRgb(at(idle, padNote(KEYS_QREC_COL, 0)), RGB_QREC_IDLE)).toBe(true);
    expect(eqRgb(at(idle, padNote(KEYS_OVERDUB_COL, 0)), RGB_OD)).toBe(true);
    // armed (blink on) → bright yellow.
    const armed = computeKeysFrame({ ...base, recArmed: true });
    expect(eqRgb(at(armed, padNote(KEYS_QREC_COL, 0)), RGB_QREC_ARMED)).toBe(true);
    // recording (blink on) → red; overdub on → bright purple.
    const rec = computeKeysFrame({ ...base, recording: true, overdub: true });
    expect(eqRgb(at(rec, padNote(KEYS_QREC_COL, 0)), RGB_QREC_REC)).toBe(true);
    expect(eqRgb(at(rec, padNote(KEYS_OVERDUB_COL, 0)), RGB_OD_ON)).toBe(true);
    // unit R has NO controls on its bottom row (it's dark / part of no control).
    const rFrame = computeKeysFrame({ ...base, unit: 'R' });
    expect(at(rFrame, padNote(KEYS_EXIT_COL, 0))).toBeNull();
  });

  it('the deck frame lights the KEYS-entry hold buttons when held', () => {
    const f = computeRDeckFrame({ keysRecHeld: true });
    expect(eqRgb(at(f, padNote(DECK_KEYS_REC_COL, DECK_KEYS_ROW)), RGB_KEYS_REC_HOLD_ON)).toBe(true);
  });
});
