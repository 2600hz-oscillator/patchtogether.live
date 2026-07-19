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
  RGB_SCENE_DIM,
  RGB_STOP_ACTIVE,
  RGB_STOP_IDLE,
  RGB_TRANSPORT_ON,
  RGB_COPY_BUFFER,
  RGB_COPY_BUFFER_SCENE,
  RGB_WHITE,
  probNoteRgb,
  probNoteRgbOrange,
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
  KEYS_OCT_DOWN_COL,
  KEYS_OCT_UP_COL,
  KEYS_PANIC_COL,
  KEYS_LEN_COL,
  DECK_KEYS_REC_COL,
  DECK_KEYS_OVERDUB_COL,
  DECK_KEYS_ROW,
  // performance controls (RESET / MONO / MUTE / RATE / tempo / pair-L MUTE / editor P6)
  clipArmAction,
  rDeckReset,
  rDeckMonoLane,
  rDeckMuteLane,
  rDeckRateLane,
  lTopMuteLane,
  topCcCol,
  colTopCc,
  editSceneAction,
  DECK_RESET_COL,
  DECK_RESET_ROW,
  DECK_MONO_ROW,
  DECK_MUTE_ROW,
  DECK_RATE_ROW,
  CC_TEMPO_DOWN,
  CC_TEMPO_UP,
  RGB_RESET,
  RGB_MONO_ON,
  RGB_MONO_OFF,
  RGB_MUTE_ON,
  RGB_MUTE_OFF,
  RGB_RATE_BY_INDEX,
  RGB_TEMPO_NUDGE,
  RGB_KEYS_REC_HOLD,
  RGB_KEYS_OD_HOLD_ON,
  RGB_PANIC,
  EDIT_OCT_UP_SCENE_ROW,
  EDIT_OCT_DOWN_SCENE_ROW,
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
  RGB_RECORDING,
  RGB_RECORDING_DIM,
} from './launchpad-map';
import {
  // SINGLE-mode (S2a) transpose + classifiers
  gridPadToClipIndex,
  clipIndexToGridPad,
  gridSceneRowToSlot,
  gridPadToClipIndexScrolled,
  gridPadForScrolledSlot,
  slotForScene,
  sceneForWindowIndex,
  highestContentScene,
  maxSceneScrollOffset,
  clampSceneScrollOffset,
  SCENE_WINDOW,
  MAX_SCENES,
  sceneIndexForCc,
  topRowAction,
  gridShiftRight,
  clipRight,
  keysScaleRight,
  keysArpShiftRight,
  controlRight,
  controlRehomePad,
  // SINGLE-mode frame builders
  paintPermanentTopRow,
  computeSingleGridFrame,
  hexToRgb127,
  computeSingleClipFrame,
  computeSingleKeysFrame,
  computeSingleControlFrame,
  computeSingleArrangerFrame,
  // re-home pad constants
  CTRL_TEMPO_ROW,
  CTRL_TEMPO_DOWN_COL,
  CTRL_TEMPO_UP_COL,
  CTRL_STOP_ALL_COL,
  CTRL_ARRANGE_ROW,
  CTRL_REC_COL,
  CTRL_SONG_COL,
  armTopLane,
  ARM_SHIFT_LANE,
  countdownRgb,
  // SINGLE-mode palette
  RGB_VIEW_IDLE,
  RGB_VIEW_ACTIVE,
  RGB_SHIFT_OFF,
  RGB_SHIFT_HELD,
  RGB_TRANSPORT_STOP,
  RGB_SYS,
  RGB_SYS_DIM,
  RGB_PATTERN,
  RGB_PATTERN_ARMED,
  RGB_TIMING,
  RGB_TIMING_ARMED,
  RGB_KEYS_ENTRY,
  RGB_SWING_CENTER,
  RGB_ARRANGER_DIM,
  RGB_SONG_ARRANGE,
  type SingleView,
  type PermanentTopOpts,
} from './launchpad-map';
import { padNote, SCENE_CCS } from './launchpad-sysex';
import { keyboardCellToMidi } from '$lib/audio/modules/keyboard-map';
import {
  clipIndex,
  defaultNoteClip,
  defaultLaneColorHex,
  toggleNoteAt,
  setNoteSpan,
  setNoteProb,
  setClipDefaultProb,
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

describe('Unit R — editor LED frame (note colours = PROBABILITY + playhead)', () => {
  it('a placed note paints by PROBABILITY (white at 100%); the playhead boosts it', () => {
    let clip: NoteClipRecord = defaultNoteClip();
    // place a note at step 2, the root row (y=0). No prob key → 100% → WHITE.
    clip = toggleNoteAt(clip, 2, clip.root);
    const f = computeREditFrame(clip, { playheadStep: -1 });
    const noteCell = at(f, padNote(2, 0));
    expect(eqRgb(noteCell, RGB_WHITE), '100% note is white').toBe(true);
    // a sub-100% note ramps PURPLE (probNoteRgb), no longer velocity-blue.
    clip = setNoteProb(clip, 2, clip.root, 0.5);
    const fp = computeREditFrame(clip, { playheadStep: -1 });
    expect(eqRgb(at(fp, padNote(2, 0)), probNoteRgb(0.5)), '50% note is purple').toBe(true);
    // with the playhead on that step, the note boosts to yellow.
    const f2 = computeREditFrame(clip, { playheadStep: 2 });
    expect(eqRgb(at(f2, padNote(2, 0)), RGB_NOTE_PLAYHEAD)).toBe(true);
  });
  it('a held span paints across the cells it covers (white at 100%)', () => {
    let clip: NoteClipRecord = defaultNoteClip();
    clip = setNoteSpan(clip, 1, 4, clip.root); // steps 1..4 held (no prob → white)
    const f = computeREditFrame(clip);
    for (let step = 1; step <= 4; step++) {
      const noteCell = at(f, padNote(step, 0));
      expect(eqRgb(noteCell, RGB_WHITE), `step ${step}`).toBe(true);
    }
    // step 5 (outside the span) is NOT a note colour.
    const after = at(f, padNote(5, 0));
    expect(eqRgb(after, RGB_WHITE)).toBe(false);
  });
  it('SOURCE-AWARE colours through the FRAME: no-own-prob = ORANGE (clip default), own prob = PURPLE, own 100% PINS WHITE', () => {
    // A clip carrying a DEFAULT prob + notes with/without their own prob: a note
    // following the default paints ORANGE, a note using its own sub-100% prob
    // paints PURPLE, and a note SET to 100% PINS to WHITE over a lower default —
    // asserted through the SHIPPED frame, not just the noteProbRgb pure boundary.
    let clip: NoteClipRecord = defaultNoteClip();
    clip = toggleNoteAt(clip, 1, clip.root); // no own prob → follows the clip default
    clip = toggleNoteAt(clip, 3, clip.root);
    clip = setNoteProb(clip, 3, clip.root, 0.25); // its own 25% → purple
    clip = toggleNoteAt(clip, 5, clip.root);
    clip = setNoteProb(clip, 5, clip.root, 1); // its own 100% (stored) → pins WHITE
    clip = setClipDefaultProb(clip, 0.5); // clip default 50% → no-own-prob note = orange
    const f = computeREditFrame(clip, { playheadStep: -1 });
    expect(eqRgb(at(f, padNote(1, 0)), probNoteRgbOrange(0.5)), 'no-own-prob note = clip-default ORANGE').toBe(true);
    expect(eqRgb(at(f, padNote(3, 0)), probNoteRgb(0.25)), "the note's own prob = PURPLE").toBe(true);
    expect(eqRgb(at(f, padNote(5, 0)), RGB_WHITE), 'own 100% pins WHITE over the 50% default').toBe(true);
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
    // P7 octave ± / panic on the previously-dead bottom-row cols 3/4/5.
    expect(keysPad('L', KEYS_OCT_DOWN_COL, KEYS_CTRL_ROW)).toEqual({ kind: 'octDown' });
    expect(keysPad('L', KEYS_OCT_UP_COL, KEYS_CTRL_ROW)).toEqual({ kind: 'octUp' });
    expect(keysPad('L', KEYS_PANIC_COL, KEYS_CTRL_ROW)).toEqual({ kind: 'panic' });
    // unit R's bottom row is dark (no controls) even on the new cols.
    expect(keysPad('R', KEYS_EXIT_COL, KEYS_CTRL_ROW)).toBeNull();
    expect(keysPad('R', KEYS_OCT_UP_COL, KEYS_CTRL_ROW)).toBeNull();
    // col 6 is the ONE remaining dead L bottom-row cell.
    expect(keysPad('L', 6, KEYS_CTRL_ROW)).toBeNull();
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

  it('KEYS bottom-row octave ± / panic pads paint on unit L (P7)', () => {
    const base = { unit: 'L' as const, keyboardRoot: 48, playheadStep: -1, lengthSteps: 16, blinkOn: true };
    const f = computeKeysFrame(base);
    expect(at(f, padNote(KEYS_OCT_DOWN_COL, KEYS_CTRL_ROW))).not.toBeNull();
    expect(at(f, padNote(KEYS_OCT_UP_COL, KEYS_CTRL_ROW))).not.toBeNull();
    expect(eqRgb(at(f, padNote(KEYS_PANIC_COL, KEYS_CTRL_ROW)), RGB_PANIC)).toBe(true);
    // unit R's bottom row stays dark on the new cols too.
    const r = computeKeysFrame({ ...base, unit: 'R' });
    expect(at(r, padNote(KEYS_PANIC_COL, KEYS_CTRL_ROW))).toBeNull();
  });
});

// ===========================================================================
// PERFORMANCE CONTROLS (P1 RESET · P4 MONO · P3 MUTE · P2 RATE · P5 tempo · P6
// editor extras · pair-L MUTE) — placement classifiers + LED-frame painting.
// ===========================================================================
describe('Performance controls — placement classifiers', () => {
  it('CC 91 (the reclaimed NEW cell) classifies as the KEYS-arm action', () => {
    expect(clipArmAction(91)).toBe('keys'); // CC_UP
    expect(clipArmAction(92)).toBe('copy');
  });
  it('deck RESET pad = row 1 col 2; MONO/MUTE/RATE rows are per-lane (col = lane)', () => {
    expect(rDeckReset(DECK_RESET_COL, DECK_RESET_ROW)).toBe(true);
    expect(rDeckReset(0, DECK_RESET_ROW)).toBe(false); // col 0 = K● hold
    expect(rDeckMonoLane(3, DECK_MONO_ROW)).toBe(3);
    expect(rDeckMonoLane(3, DECK_MUTE_ROW)).toBeNull(); // wrong row
    expect(rDeckMuteLane(5, DECK_MUTE_ROW)).toBe(5);
    expect(rDeckRateLane(7, DECK_RATE_ROW)).toBe(7);
    expect(rDeckRateLane(8, DECK_RATE_ROW)).toBeNull(); // out of lane range
  });
  it('the three rows never overlap the row-0 functions or each other', () => {
    // row 0 (functions) is not classified as any performance row.
    expect(rDeckMonoLane(0, 0)).toBeNull();
    expect(rDeckMuteLane(0, 0)).toBeNull();
    expect(rDeckRateLane(0, 0)).toBeNull();
    expect(rDeckReset(0, 0)).toBe(false);
    // distinct rows.
    expect(DECK_MONO_ROW).not.toBe(DECK_MUTE_ROW);
    expect(DECK_MUTE_ROW).not.toBe(DECK_RATE_ROW);
  });
  it('pair unit-L top CCs map to MUTE lanes (col = lane); CC 98 → lane 7', () => {
    expect(topCcCol(91)).toBe(0);
    expect(topCcCol(98)).toBe(7);
    expect(topCcCol(99)).toBeNull();
    expect(colTopCc(0)).toBe(91);
    expect(colTopCc(7)).toBe(98);
    expect(lTopMuteLane(91)).toBe(0);
    expect(lTopMuteLane(98)).toBe(7);
  });
  it('editor scene rows 1/0 classify as OCT+/OCT−; rows 3/2 are inert (copy/paste is Grid-only)', () => {
    expect(editSceneAction(EDIT_OCT_UP_SCENE_ROW)).toBe('octUp');
    expect(editSceneAction(EDIT_OCT_DOWN_SCENE_ROW)).toBe('octDown');
    // Rows 3 + 2 (the old editor COPY/PASTE) are null — copy/paste lives on the
    // Grid page only.
    expect(editSceneAction(3)).toBeNull();
    expect(editSceneAction(2)).toBeNull();
    // EXIT/DOUBLE/LENGTH unchanged.
    expect(editSceneAction(7)).toBe('exit');
  });
});

describe('Performance controls — LED frames', () => {
  it('deck frame lights RESET (blue) + MONO/MUTE/RATE per-lane + tempo nudge', () => {
    const d: ClipPlayerData = {
      mono: [true, false, false, false, false, false, false, false],
      muted: [false, false, true, false, false, false, false, false],
      rate: [0, 3, 3, 3, 3, 3, 3, 5],
    } as ClipPlayerData;
    const f = computeRDeckFrame({ data: d });
    expect(eqRgb(at(f, padNote(DECK_RESET_COL, DECK_RESET_ROW)), RGB_RESET)).toBe(true);
    // lane 0 mono ON (teal), lane 1 mono OFF (dim).
    expect(eqRgb(at(f, padNote(0, DECK_MONO_ROW)), RGB_MONO_ON)).toBe(true);
    expect(eqRgb(at(f, padNote(1, DECK_MONO_ROW)), RGB_MONO_OFF)).toBe(true);
    // lane 2 muted (orange), lane 0 live (dim).
    expect(eqRgb(at(f, padNote(2, DECK_MUTE_ROW)), RGB_MUTE_ON)).toBe(true);
    expect(eqRgb(at(f, padNote(0, DECK_MUTE_ROW)), RGB_MUTE_OFF)).toBe(true);
    // rate ramp: lane 0 = index 0, lane 7 = index 5.
    expect(eqRgb(at(f, padNote(0, DECK_RATE_ROW)), RGB_RATE_BY_INDEX[0])).toBe(true);
    expect(eqRgb(at(f, padNote(7, DECK_RATE_ROW)), RGB_RATE_BY_INDEX[5])).toBe(true);
    // tempo nudge lit.
    expect(eqRgb(at(f, CC_TEMPO_DOWN), RGB_TEMPO_NUDGE)).toBe(true);
    expect(eqRgb(at(f, CC_TEMPO_UP), RGB_TEMPO_NUDGE)).toBe(true);
  });
  it('SINGLE clip-view arm strip: CC 91 paints the KEYS-arm tri-state', () => {
    const d: ClipPlayerData = { clips: {} } as ClipPlayerData;
    const CC_91 = 91; // the reclaimed top-row cell (a CC, not a grid pad)
    const off = computeLSessionFrame(d, { arm: { armedAction: null, bufferLoaded: false, nowOn: false, keysArm: 'off' } });
    expect(eqRgb(at(off, CC_91), RGB_KEYS_REC_HOLD)).toBe(true); // idle = dim red
    const rec = computeLSessionFrame(d, { arm: { armedAction: null, bufferLoaded: false, nowOn: false, keysArm: 'rec' } });
    expect(eqRgb(at(rec, CC_91), RGB_KEYS_REC_HOLD_ON)).toBe(true); // armed-REC = red
    const od = computeLSessionFrame(d, { arm: { armedAction: null, bufferLoaded: false, nowOn: false, keysArm: 'od' } });
    expect(eqRgb(at(od, CC_91), RGB_KEYS_OD_HOLD_ON)).toBe(true); // armed-OD = purple
  });
  it('PAIR unit-L top row lights the 8 per-lane MUTE pads (lTopMute)', () => {
    const d: ClipPlayerData = { muted: [false, true, false, false, false, false, false, false] } as ClipPlayerData;
    const f = computeLSessionFrame(d, { lTopMute: true });
    expect(eqRgb(at(f, colTopCc(0)), RGB_MUTE_OFF)).toBe(true); // lane 0 live
    expect(eqRgb(at(f, colTopCc(1)), RGB_MUTE_ON)).toBe(true); // lane 1 muted
  });
  it('editor frame lights OCT ± pads; the old COPY/PASTE rows 3/2 stay dark (Grid-only copy/paste)', () => {
    // SCENE_CCS is top→bottom (index 0 = row 7), so scene row r → SCENE_CCS[7-r].
    const sceneCc = (row: number) => SCENE_CCS[7 - row];
    const clip = defaultNoteClip();
    const f = computeREditFrame(clip);
    // OCT pads lit (non-null).
    expect(at(f, sceneCc(EDIT_OCT_UP_SCENE_ROW))).not.toBeNull();
    expect(at(f, sceneCc(EDIT_OCT_DOWN_SCENE_ROW))).not.toBeNull();
    // Rows 3 + 2 (the removed editor COPY/PASTE) are dark — copy/paste exists
    // only on the Grid page.
    expect(eqRgb(at(f, sceneCc(3)), RGB_OFF)).toBe(true);
    expect(eqRgb(at(f, sceneCc(2)), RGB_OFF)).toBe(true);
  });
});

// ===========================================================================
// SINGLE-UNIT REWORK (S2a) — transpose helpers, per-view right-column
// classifiers, the permanent top row, and the per-view frame builders.
// ===========================================================================
const emptyLpFrame = () => ({ leds: new Map<number, [number, number, number]>() });
const mkTop = (view: SingleView, partial: Partial<PermanentTopOpts> = {}): PermanentTopOpts => ({
  view,
  keysActive: false,
  transportRunning: false,
  shift: { held: false },
  canUndo: false,
  canRedo: false,
  ...partial,
});

describe('Single mode — grid transpose (channel-per-column)', () => {
  it('gridPadToClipIndex ↔ clipIndexToGridPad round-trip all 64 (x=lane, slot top→bottom)', () => {
    // top-left pad (x=0,y=7) = lane 0, slot 0; pad (x=1,y=7) = lane 1, slot 0;
    // pad (x=0,y=6) = lane 0, slot 1.
    expect(gridPadToClipIndex(0, 7)).toBe(clipIndex(0, 0));
    expect(gridPadToClipIndex(1, 7)).toBe(clipIndex(0, 1));
    expect(gridPadToClipIndex(0, 6)).toBe(clipIndex(1, 0));
    for (let lane = 0; lane < 8; lane++) {
      for (let slot = 0; slot < 8; slot++) {
        const idx = clipIndex(slot, lane);
        const pad = clipIndexToGridPad(idx);
        expect(pad).toEqual({ x: lane, y: 8 - 1 - slot });
        expect(gridPadToClipIndex(pad.x, pad.y)).toBe(idx);
      }
    }
  });
  it('out-of-range grid pads are null', () => {
    expect(gridPadToClipIndex(-1, 0)).toBeNull();
    expect(gridPadToClipIndex(8, 0)).toBeNull();
    expect(gridPadToClipIndex(0, -1)).toBeNull();
    expect(gridPadToClipIndex(0, 8)).toBeNull();
  });
  it('gridSceneRowToSlot: scene index 0=top→slot 0 … 7→slot 7; out of range null', () => {
    expect(gridSceneRowToSlot(0)).toBe(0);
    expect(gridSceneRowToSlot(7)).toBe(7);
    expect(gridSceneRowToSlot(8)).toBeNull();
    expect(gridSceneRowToSlot(-1)).toBeNull();
  });
});

describe('Single mode — classifiers', () => {
  it('topRowAction maps CC 91..98 → nav actions; other CCs null', () => {
    expect([91, 92, 93, 94, 95, 96, 97, 98].map(topRowAction)).toEqual([
      'transport', 'grid', 'clip', 'arranger', 'control', 'undo', 'redo', 'shift',
    ]);
    expect(topRowAction(99)).toBeNull();
    expect(topRowAction(19)).toBeNull();
  });
  it('sceneIndexForCc inverts SCENE_CCS (0=top); a non-scene CC is null', () => {
    expect(sceneIndexForCc(SCENE_CCS[0])).toBe(0);
    expect(sceneIndexForCc(SCENE_CCS[7])).toBe(7);
    expect(sceneIndexForCc(91)).toBeNull();
  });
  it('gridShiftRight: 0=copy … 5=len, 6=scrollUp, 7=scrollDown; out of range null', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(gridShiftRight)).toEqual([
      'copy', 'paste', 'clipDiv', 'swingUp', 'swingDown', 'len', 'scrollUp', 'scrollDown',
    ]);
    expect(gridShiftRight(8)).toBeNull();
    expect(gridShiftRight(-1)).toBeNull();
  });
  it('clipRight: 0=double … 7=stepRight; out of range null', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(clipRight)).toEqual([
      'double', 'lengthEdit', 'follow', 'keys', 'rowUp', 'rowDown', 'stepLeft', 'stepRight',
    ]);
    expect(clipRight(8)).toBeNull();
    expect(clipRight(-1)).toBeNull();
  });
  it('keysScaleRight: 0..5 scales, 6 chromatic {scale:undefined}, 7 arpToggle; oor null', () => {
    expect(keysScaleRight(0)).toEqual({ scale: 'major' });
    expect(keysScaleRight(1)).toEqual({ scale: 'minor' });
    expect(keysScaleRight(5)).toEqual({ scale: 'mixolydian' });
    expect(keysScaleRight(6)).toEqual({ scale: undefined }); // chromatic
    expect(keysScaleRight(7)).toBe('arpToggle');
    expect(keysScaleRight(8)).toBeNull();
    expect(keysScaleRight(-1)).toBeNull();
  });
  it('keysArpShiftRight: 0=arpDivUp … 7=arpLatch; out of range null', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(keysArpShiftRight)).toEqual([
      'arpDivUp', 'arpDivDown', 'arpUp', 'arpDown', 'arpUpDown', 'arpRangeUp', 'arpRangeDown', 'arpLatch',
    ]);
    expect(keysArpShiftRight(8)).toBeNull();
  });
  it('controlRight: scene 0(top)=lane 7 … 7(bottom)=lane 0 (row=lane, like the deck)', () => {
    expect(controlRight(0)).toBe(7);
    expect(controlRight(7)).toBe(0);
    expect(controlRight(8)).toBeNull();
    expect(controlRight(-1)).toBeNull();
  });
  it('controlRehomePad classifies the re-homed transport/song pads (the old AUTO pad at (2,6) is RETIRED)', () => {
    expect(controlRehomePad(CTRL_TEMPO_DOWN_COL, CTRL_TEMPO_ROW)).toBe('tempoDown');
    expect(controlRehomePad(CTRL_TEMPO_UP_COL, CTRL_TEMPO_ROW)).toBe('tempoUp');
    expect(controlRehomePad(CTRL_STOP_ALL_COL, CTRL_TEMPO_ROW)).toBe('stopAll');
    expect(controlRehomePad(CTRL_REC_COL, CTRL_ARRANGE_ROW)).toBe('rec');
    expect(controlRehomePad(CTRL_SONG_COL, CTRL_ARRANGE_ROW)).toBe('song');
    // The single AUTO pad at (2,6) is retired — per-lane arm is the permanent
    // top row's SHIFT+column gesture (armTopLane below).
    expect(controlRehomePad(2, CTRL_ARRANGE_ROW)).toBeNull();
    expect(controlRehomePad(2, CTRL_TEMPO_ROW)).toBeNull(); // a gap column
    expect(controlRehomePad(0, 0)).toBeNull(); // not a re-home row
  });
  it('armTopLane: SHIFT+top CC 91..97 → lanes 0..6; CC 98 (shift itself) → null; lane 8 = ARM_SHIFT_LANE', () => {
    expect(armTopLane(91)).toBe(0);
    expect(armTopLane(92)).toBe(1);
    expect(armTopLane(95)).toBe(4);
    expect(armTopLane(97)).toBe(6);
    expect(armTopLane(98)).toBeNull(); // the shift button — lane 8 is the double-tap
    expect(armTopLane(90)).toBeNull();
    expect(armTopLane(0)).toBeNull();
    expect(ARM_SHIFT_LANE).toBe(7);
  });
});

describe('Single mode — scene-scroll window (reach scenes beyond 8)', () => {
  it('slotForScene: every scene 0..MAX_SCENES-1 backs a real slot (scene == slot); out of range → null', () => {
    expect(slotForScene(0)).toBe(0);
    expect(slotForScene(7)).toBe(7);
    expect(slotForScene(8)).toBe(8); // scene 8+ now backs a REAL populatable slot
    expect(slotForScene(9)).toBe(9);
    expect(slotForScene(63)).toBe(63); // the last slot on the axis
    expect(slotForScene(MAX_SCENES)).toBeNull(); // 64 — out of range
    expect(slotForScene(-1)).toBeNull();
  });
  it('sceneForWindowIndex: window index i at offset o → global scene o+i', () => {
    expect(sceneForWindowIndex(0, 0)).toBe(0);
    expect(sceneForWindowIndex(0, 7)).toBe(7);
    expect(sceneForWindowIndex(2, 0)).toBe(2); // top button at offset 2 = scene 2
    expect(sceneForWindowIndex(2, 7)).toBe(9); // bottom button at offset 2 = scene 9
  });
  it('SCENE_WINDOW = LP_HEIGHT (8) and MAX_SCENES is a sane cap (64)', () => {
    expect(SCENE_WINDOW).toBe(8);
    expect(MAX_SCENES).toBe(64);
  });
  it('highestContentScene: -1 when empty; the deepest slot that holds any clip (scans the FULL MAX_SCENES axis)', () => {
    expect(highestContentScene(undefined)).toBe(-1);
    expect(highestContentScene({} as ClipPlayerData)).toBe(-1);
    const d = {
      clips: { [clipIndex(1, 0)]: defaultNoteClip(), [clipIndex(3, 2)]: defaultNoteClip() },
    } as unknown as ClipPlayerData;
    expect(highestContentScene(d)).toBe(3); // slot 3 (lane 2) is the deepest
    const full = { clips: { [clipIndex(7, 5)]: defaultNoteClip() } } as unknown as ClipPlayerData;
    expect(highestContentScene(full)).toBe(7);
    // Content in a scene BEYOND the visible 8 is now reachable (a clip in scene 15).
    const deep = { clips: { [clipIndex(15, 3)]: defaultNoteClip() } } as unknown as ClipPlayerData;
    expect(highestContentScene(deep)).toBe(15);
  });
  it('maxSceneScrollOffset: an empty player cannot scroll; content reveals ONE empty scene past it, capped at MAX_SCENES', () => {
    expect(maxSceneScrollOffset(-1)).toBe(0); // empty → no scroll
    expect(maxSceneScrollOffset(0)).toBe(0); // content only at scene 0 → still a full window
    expect(maxSceneScrollOffset(7)).toBe(1); // content through slot 7 → reveal scene 8 (dark)
    expect(maxSceneScrollOffset(8)).toBe(2); // (once storage grows) content to scene 8 → scene 9 at bottom
    expect(maxSceneScrollOffset(63)).toBe(MAX_SCENES - SCENE_WINDOW); // hard cap = 56
    expect(maxSceneScrollOffset(200)).toBe(MAX_SCENES - SCENE_WINDOW); // never past the cap
  });
  it('clampSceneScrollOffset: clamps into [0, max]; UP clamps at 0; NaN → 0', () => {
    expect(clampSceneScrollOffset(-5, 7)).toBe(0); // UP clamp
    expect(clampSceneScrollOffset(5, 7)).toBe(1); // DOWN clamp (max 1 for content-through-7)
    expect(clampSceneScrollOffset(1, 7)).toBe(1);
    expect(clampSceneScrollOffset(3, -1)).toBe(0); // empty player: max 0
    expect(clampSceneScrollOffset(Number.NaN, 7)).toBe(0);
  });
  it('gridPadToClipIndexScrolled: offset 0 === gridPadToClipIndex; offset shifts the scene onto its real slot; out of range → null', () => {
    // offset 0 agrees with the un-scrolled mapping for every pad.
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        expect(gridPadToClipIndexScrolled(x, y, 0)).toBe(gridPadToClipIndex(x, y));
      }
    }
    // offset 1: the TOP row (y=7) now addresses scene 1 (slot 1).
    expect(gridPadToClipIndexScrolled(0, 7, 1)).toBe(clipIndex(1, 0));
    expect(gridPadToClipIndexScrolled(3, 7, 1)).toBe(clipIndex(1, 3));
    // offset 1: the BOTTOM row (y=0) = scene 8 → its REAL stored slot 8 (no longer null).
    expect(gridPadToClipIndexScrolled(0, 0, 1)).toBe(clipIndex(8, 0));
    // a scene beyond the axis (≥ MAX_SCENES) → null (offset 60, bottom row = scene 67).
    expect(gridPadToClipIndexScrolled(0, 0, 60)).toBeNull();
    // out of the matrix → null.
    expect(gridPadToClipIndexScrolled(8, 0, 0)).toBeNull();
    expect(gridPadToClipIndexScrolled(0, 8, 0)).toBeNull();
  });
  it('gridPadForScrolledSlot: places a stored slot in the window, or null when scrolled off; round-trips with the pad→index map', () => {
    expect(gridPadForScrolledSlot(0, 0, 0)).toEqual({ x: 0, y: 7 }); // slot 0 = top row
    expect(gridPadForScrolledSlot(1, 3, 0)).toEqual({ x: 3, y: 6 });
    expect(gridPadForScrolledSlot(0, 0, 1)).toBeNull(); // scrolled off the top
    expect(gridPadForScrolledSlot(7, 0, 1)).toEqual({ x: 0, y: 1 }); // slot 7 rises to row 6
    for (const offset of [0, 1, 2]) {
      for (let slot = 0; slot < 8; slot++) {
        for (let lane = 0; lane < 8; lane++) {
          const pad = gridPadForScrolledSlot(slot, lane, offset);
          if (pad) expect(gridPadToClipIndexScrolled(pad.x, pad.y, offset)).toBe(clipIndex(slot, lane));
        }
      }
    }
  });
  it('computeSingleGridFrame at an offset: the shifted scene paints its clip; the revealed empty scene is DARK', () => {
    const data = {
      clips: { [clipIndex(1, 0)]: defaultNoteClip() },
      playing: [1, null, null, null, null, null, null, null], // lane 0 playing slot 1
    } as unknown as ClipPlayerData;
    const f = computeSingleGridFrame(data, {
      top: mkTop('grid'),
      blinkOn: true,
      sceneScrollOffset: 1,
    });
    // At offset 1 scene 1 (slot 1) is the TOP row → lane-0 playing shows its hue at (0,7).
    expect(eqRgb(at(f, padNote(0, 7)), hexToRgb127(defaultLaneColorHex(0)))).toBe(true);
    // The BOTTOM row is scene 8 (empty) → DARK.
    expect(eqRgb(at(f, padNote(0, 0)), RGB_OFF)).toBe(true);
    // Scene column: top button (index 0 → scene 1) = amber; bottom (index 7 → scene 8) = DARK.
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_SCENE)).toBe(true);
    expect(eqRgb(at(f, SCENE_CCS[7]), RGB_OFF)).toBe(true);
  });
  it('scenes ≥ 8 hold REAL clips: scene 9 + 15 key + map + paint correctly; an empty scene past content is dark', () => {
    // Clips stored in scene 9 (slot 9, lane 0) and scene 15 (slot 15, lane 3).
    const data = {
      clips: { [clipIndex(9, 0)]: defaultNoteClip(), [clipIndex(15, 3)]: defaultNoteClip() },
      playing: [9, null, null, null, null, null, null, null], // lane 0 playing slot 9
    } as unknown as ClipPlayerData;
    // Stored keys are stride-64 unique + decode back to (slot, lane).
    expect(clipIndex(9, 0)).toBe(9);
    expect(clipIndex(15, 3)).toBe(3 * 64 + 15); // 207
    // The scrolled grid REACHES those cells: at offset 8 the window shows scenes 8..15.
    expect(gridPadToClipIndexScrolled(0, 6, 8)).toBe(clipIndex(9, 0)); // scene 9 → row 1 (y=6)
    expect(gridPadToClipIndexScrolled(3, 0, 8)).toBe(clipIndex(15, 3)); // scene 15 → row 7 (y=0)
    // Render at offset 8: scene-9 lane-0 pad is SOLID (playing) at (x=0, y=6); its
    // scene button (index 1 → scene 9) is amber; scene 8 (index 0, empty) is dark.
    const f = computeSingleGridFrame(data, { top: mkTop('grid'), blinkOn: true, sceneScrollOffset: 8 });
    expect(eqRgb(at(f, padNote(0, 6)), hexToRgb127(defaultLaneColorHex(0)))).toBe(true);
    expect(eqRgb(at(f, SCENE_CCS[1]), RGB_SCENE)).toBe(true); // scene 9 has a clip → amber
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_OFF)).toBe(true); // scene 8 empty → dark (content-gated)
    // A scene with NO clip in its window row is a dark pad (scene 10, row 2, y=5).
    expect(eqRgb(at(f, padNote(0, 5)), RGB_OFF)).toBe(true);
  });
});

describe('Single mode — permanent top row', () => {
  it('lights transport (red stopped), the active view bright purple, undo/redo orange, shift', () => {
    const f = emptyLpFrame();
    paintPermanentTopRow(f, mkTop('grid', { canUndo: true, canRedo: true }));
    expect(eqRgb(at(f, 91), RGB_TRANSPORT_STOP)).toBe(true); // stopped = red
    expect(eqRgb(at(f, 92), RGB_VIEW_ACTIVE)).toBe(true); // grid active = bright purple
    expect(eqRgb(at(f, 93), RGB_VIEW_IDLE)).toBe(true); // clip idle = dim purple
    expect(eqRgb(at(f, 96), RGB_SYS)).toBe(true); // undo available = orange
    expect(eqRgb(at(f, 98), RGB_SHIFT_OFF)).toBe(true); // shift off = dim yellow
    const run = emptyLpFrame();
    paintPermanentTopRow(run, mkTop('grid', { transportRunning: true }));
    expect(eqRgb(at(run, 91), RGB_TRANSPORT_ON)).toBe(true); // running = green
  });
  it('KEYS active lights the CLIP button bright (sub-mode indicator)', () => {
    const f = emptyLpFrame();
    paintPermanentTopRow(f, mkTop('clip', { keysActive: true }));
    expect(eqRgb(at(f, 93), RGB_VIEW_ACTIVE)).toBe(true);
  });
  it('undo/redo dim when the stacks are empty; shift CC 98 = dim off / bright held (no latch)', () => {
    const f = emptyLpFrame();
    paintPermanentTopRow(f, mkTop('grid'));
    expect(eqRgb(at(f, 96), RGB_SYS_DIM)).toBe(true); // canUndo false
    expect(eqRgb(at(f, 97), RGB_SYS_DIM)).toBe(true); // canRedo false
    expect(eqRgb(at(f, 98), RGB_SHIFT_OFF)).toBe(true); // not held → dim
    const held = emptyLpFrame();
    paintPermanentTopRow(held, mkTop('grid', { shift: { held: true } }));
    expect(eqRgb(at(held, 98), RGB_SHIFT_HELD)).toBe(true); // held → bright yellow
  });
  it('ARM MAP while shift is HELD: cols 0..6 = red pulse (armed) / dim red (available); CC 98 keeps the shift LED', () => {
    // Shift HELD, lane 2 armed, blink bright.
    const f = emptyLpFrame();
    paintPermanentTopRow(
      f,
      mkTop('grid', { shift: { held: true }, laneArms: [false, false, true], blinkOn: true }),
    );
    expect(eqRgb(at(f, 93), RGB_RECORDING)).toBe(true); // lane 2 armed → red pulse (bright)
    expect(eqRgb(at(f, 91), RGB_STOP_IDLE)).toBe(true); // lane 0 available → dim red
    expect(eqRgb(at(f, 97), RGB_STOP_IDLE)).toBe(true); // lane 6 available → dim red
    expect(eqRgb(at(f, 98), RGB_SHIFT_HELD)).toBe(true); // the shift button keeps its held LED
    // Blink-off phase: the armed lane dims to the record-dim red.
    const dim = emptyLpFrame();
    paintPermanentTopRow(
      dim,
      mkTop('grid', { shift: { held: true }, laneArms: [false, false, true], blinkOn: false }),
    );
    expect(eqRgb(at(dim, 93), RGB_RECORDING_DIM)).toBe(true);
  });
  it('LANE-8 ARM PAD (below SHFT) lights ONLY while shift is HELD: dim red available / red pulse armed', () => {
    const P = padNote(7, 7); // topmost row (y=7), rightmost col (x=7) — the pad below SHFT
    // No shift → the pad is NOT painted by the top-row painter (view owns it).
    const noShift = emptyLpFrame();
    paintPermanentTopRow(noShift, mkTop('grid', { laneArms: [false, false, false, false, false, false, false, true] }));
    expect(noShift.leds.has(P), 'lane-8 pad untouched off-shift (armed state shows on CC 98)').toBe(false);
    // Shift held, lane 8 AVAILABLE (not armed) → dim red.
    const avail = emptyLpFrame();
    paintPermanentTopRow(avail, mkTop('grid', { shift: { held: true } }));
    expect(eqRgb(at(avail, P), RGB_STOP_IDLE)).toBe(true);
    // Shift held, lane 8 ARMED, blink bright → red pulse; off phase → dim red.
    const armedOn = emptyLpFrame();
    paintPermanentTopRow(armedOn, mkTop('grid', { shift: { held: true }, laneArms: [false, false, false, false, false, false, false, true], blinkOn: true }));
    expect(eqRgb(at(armedOn, P), RGB_RECORDING)).toBe(true);
    const armedOff = emptyLpFrame();
    paintPermanentTopRow(armedOff, mkTop('grid', { shift: { held: true }, laneArms: [false, false, false, false, false, false, false, true], blinkOn: false }));
    expect(eqRgb(at(armedOff, P), RGB_RECORDING_DIM)).toBe(true);
  });
  it('ALWAYS-VISIBLE arm overlay (no shift): an armed lane’s top button red-flashes ALTERNATING with its base colour — every view', () => {
    // Lane 2 (the CLIP button's column) armed, grid view, blink bright → RED.
    const on = emptyLpFrame();
    paintPermanentTopRow(on, mkTop('grid', { laneArms: [false, false, true], blinkOn: true }));
    expect(eqRgb(at(on, 93), RGB_RECORDING)).toBe(true);
    // Blink-off phase → the BASE compass colour shows (the row stays readable).
    const off = emptyLpFrame();
    paintPermanentTopRow(off, mkTop('grid', { laneArms: [false, false, true], blinkOn: false }));
    expect(eqRgb(at(off, 93), RGB_VIEW_IDLE)).toBe(true);
    // Unarmed columns keep their base colours in BOTH phases.
    expect(eqRgb(at(on, 92), RGB_VIEW_ACTIVE)).toBe(true);
    expect(eqRgb(at(off, 92), RGB_VIEW_ACTIVE)).toBe(true);
    // CONTRAST-AWARE off phase: the STOPPED transport button's base is
    // red-family ([104,23,23]) — a red flash against it would be illegible,
    // so the off phase dims to RGB_RECORDING_DIM instead of the base.
    const redBaseOn = emptyLpFrame();
    paintPermanentTopRow(redBaseOn, mkTop('grid', { laneArms: [true], blinkOn: true }));
    expect(eqRgb(at(redBaseOn, 91), RGB_RECORDING)).toBe(true);
    const redBaseOff = emptyLpFrame();
    paintPermanentTopRow(redBaseOff, mkTop('grid', { laneArms: [true], blinkOn: false }));
    expect(eqRgb(at(redBaseOff, 91), RGB_RECORDING_DIM), 'red-family base → dim-red off phase').toBe(true);
    // A RUNNING transport (green base) keeps the base as the off phase.
    const greenBaseOff = emptyLpFrame();
    paintPermanentTopRow(greenBaseOff, mkTop('grid', { transportRunning: true, laneArms: [true], blinkOn: false }));
    expect(eqRgb(at(greenBaseOff, 91), RGB_TRANSPORT_ON)).toBe(true);
    // Lane 8 armed: CC 98 alternates red ↔ the shift LED.
    const l8on = emptyLpFrame();
    paintPermanentTopRow(l8on, mkTop('control', { laneArms: [false, false, false, false, false, false, false, true], blinkOn: true }));
    expect(eqRgb(at(l8on, 98), RGB_RECORDING)).toBe(true);
    const l8off = emptyLpFrame();
    paintPermanentTopRow(l8off, mkTop('control', { laneArms: [false, false, false, false, false, false, false, true], blinkOn: false }));
    expect(eqRgb(at(l8off, 98), RGB_SHIFT_OFF)).toBe(true);
    // Works in EVERY view — the same overlay in control view.
    expect(eqRgb(at(l8on, 95), RGB_VIEW_ACTIVE)).toBe(true); // the control view's own button unaffected
  });
});

describe('Single mode — frame builders', () => {
  it('grid: loaded / playing / queued clips land at the transposed positions', () => {
    const data: ClipPlayerData = {
      clips: {
        [clipIndex(0, 0)]: defaultNoteClip(), // lane0 slot0 — queued
        [clipIndex(1, 1)]: defaultNoteClip(), // lane1 slot1 — playing
        [clipIndex(2, 3)]: defaultNoteClip(), // lane3 slot2 — just loaded
      },
      playing: [null, 1, null, null, null, null, null, null],
      queued: [0, null, null, null, null, null, null, null],
    } as ClipPlayerData;
    const f = computeSingleGridFrame(data, { blinkOn: true, top: mkTop('grid') });
    // lane1 slot1 playing → SOLID lane-1 default hue at pad {x:1,y:6}.
    expect(eqRgb(at(f, padNote(1, 6)), hexToRgb127(defaultLaneColorHex(1)))).toBe(true);
    // lane0 slot0 queued-launch → flash lane-0 default hue (blink on) at pad {x:0,y:7}.
    expect(eqRgb(at(f, padNote(0, 7)), hexToRgb127(defaultLaneColorHex(0)))).toBe(true);
    // lane3 slot2 loaded-idle → DIM lane-3 default hue at pad {x:3,y:5}.
    const dl3 = hexToRgb127(defaultLaneColorHex(3));
    expect(
      eqRgb(at(f, padNote(3, 5)), [
        Math.round(dl3[0] * 0.32),
        Math.round(dl3[1] * 0.32),
        Math.round(dl3[2] * 0.32),
      ]),
    ).toBe(true);
    // an empty pad off.
    expect(eqRgb(at(f, padNote(5, 5)), RGB_OFF)).toBe(true);
    // scene column (no shift): slot0 has a queued lane → flash; slot1 amber idle.
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_QUEUED)).toBe(true);
    expect(eqRgb(at(f, SCENE_CCS[1]), RGB_SCENE)).toBe(true);
    // permanent nav: grid active.
    expect(eqRgb(at(f, 92), RGB_VIEW_ACTIVE)).toBe(true);
  });
  it('grid + shift: the right column shows the function palette; the armed action brightens; UP/DOWN are amber', () => {
    const f = computeSingleGridFrame({} as ClipPlayerData, {
      top: mkTop('grid', { shift: { held: true } }),
      armedRightAction: 'copy',
      bufferLoaded: false,
      canScrollUp: true,
      canScrollDown: true,
    });
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_PATTERN_ARMED)).toBe(true); // COPY armed = bright green
    expect(eqRgb(at(f, SCENE_CCS[1]), RGB_PATTERN)).toBe(true); // PASTE idle green (no buffer)
    expect(eqRgb(at(f, SCENE_CCS[2]), RGB_TIMING)).toBe(true); // CLIP DIV blue
    expect(eqRgb(at(f, SCENE_CCS[5]), RGB_DECK_LEN)).toBe(true); // LEN yellow
    expect(eqRgb(at(f, SCENE_CCS[6]), RGB_SCENE)).toBe(true); // scene UP (was PASTE-REV) = amber
    expect(eqRgb(at(f, SCENE_CCS[7]), RGB_SCENE)).toBe(true); // scene DOWN (was NOW) = amber
  });
  it('grid + shift: UP/DOWN dim to RGB_SCENE_DIM at their scroll clamp', () => {
    const f = computeSingleGridFrame({} as ClipPlayerData, {
      top: mkTop('grid', { shift: { held: true } }),
      canScrollUp: false, // at the top (offset 0) → UP dim
      canScrollDown: false, // nothing more to reveal → DOWN dim
    });
    expect(eqRgb(at(f, SCENE_CCS[6]), RGB_SCENE_DIM)).toBe(true);
    expect(eqRgb(at(f, SCENE_CCS[7]), RGB_SCENE_DIM)).toBe(true);
  });
  it('grid + shift: the Swing buttons flash green on return-to-centre', () => {
    const f = computeSingleGridFrame({} as ClipPlayerData, {
      top: mkTop('grid', { shift: { held: true } }),
      swingMeter: { active: true, dir: 'center', level0to1: 0 },
    });
    expect(eqRgb(at(f, SCENE_CCS[3]), RGB_SWING_CENTER)).toBe(true); // Swing+
    expect(eqRgb(at(f, SCENE_CCS[4]), RGB_SWING_CENTER)).toBe(true); // Swing−
  });
  it('grid + shift: PASTE pulses the AMBER scene-buffer colour when a SCENE is buffered', () => {
    // Turquoise for a clip buffer, amber for a scene buffer (distinct colour).
    const clipBuf = computeSingleGridFrame({} as ClipPlayerData, {
      top: mkTop('grid', { shift: { held: true } }),
      bufferLoaded: true,
      bufferKind: 'clip',
      blinkOn: true,
    });
    expect(eqRgb(at(clipBuf, SCENE_CCS[1]), RGB_COPY_BUFFER)).toBe(true); // clip → turquoise
    const sceneBuf = computeSingleGridFrame({} as ClipPlayerData, {
      top: mkTop('grid', { shift: { held: true } }),
      bufferLoaded: true,
      bufferKind: 'scene',
      blinkOn: true,
    });
    expect(eqRgb(at(sceneBuf, SCENE_CCS[1]), RGB_COPY_BUFFER_SCENE)).toBe(true); // scene → amber
  });
  it('grid (no shift): a SCENE-buffer PASTE arm lights the scene column + DIMS the clip pads', () => {
    const data: ClipPlayerData = {
      clips: { [clipIndex(3, 0)]: defaultNoteClip() }, // a loaded clip pad
    } as ClipPlayerData;
    const f = computeSingleGridFrame(data, {
      top: mkTop('grid'), // NO shift → the sticky paste arm overlays the launch column
      armedRightAction: 'paste',
      bufferLoaded: true,
      bufferKind: 'scene',
      blinkOn: true,
    });
    // Every in-range scene lights the amber scene-buffer target colour (valid class).
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_COPY_BUFFER_SCENE)).toBe(true);
    expect(eqRgb(at(f, SCENE_CCS[5]), RGB_COPY_BUFFER_SCENE)).toBe(true);
    // The loaded clip pad (invalid class) is DIMMED to ~15% of its state colour.
    // slot 3 at offset 0 → matrix row 3 → physical y = 7 - 3 = 4.
    const dl0 = hexToRgb127(defaultLaneColorHex(0)); // lane-0 loaded = 0.32× hue, then 0.15× dim
    const loadedRgb = [Math.round(dl0[0] * 0.32), Math.round(dl0[1] * 0.32), Math.round(dl0[2] * 0.32)];
    const dimmed = [Math.round(loadedRgb[0] * 0.15), Math.round(loadedRgb[1] * 0.15), Math.round(loadedRgb[2] * 0.15)];
    expect(eqRgb(at(f, padNote(0, 4)), dimmed as unknown as typeof RGB_OFF)).toBe(true);
  });
  it('grid (no shift): a CLIP-buffer PASTE arm DIMS the scene column (clip pads stay lit)', () => {
    const data: ClipPlayerData = {
      clips: { [clipIndex(2, 0)]: defaultNoteClip(), [clipIndex(2, 1)]: defaultNoteClip() }, // scene 2 has content
    } as ClipPlayerData;
    const f = computeSingleGridFrame(data, {
      top: mkTop('grid'),
      armedRightAction: 'paste',
      bufferLoaded: true,
      bufferKind: 'clip',
      blinkOn: true,
    });
    // Scene column dims (invalid class for a clip buffer) even where it has content.
    expect(eqRgb(at(f, SCENE_CCS[2]), RGB_SCENE_DIM)).toBe(true);
    // A loaded clip pad stays at its normal loaded colour (valid class, not dimmed).
    // slot 2 at offset 0 → matrix row 2 → physical y = 7 - 2 = 5.
    const dl0 = hexToRgb127(defaultLaneColorHex(0));
    const loadedRgb = [Math.round(dl0[0] * 0.32), Math.round(dl0[1] * 0.32), Math.round(dl0[2] * 0.32)];
    expect(eqRgb(at(f, padNote(0, 5)), loadedRgb as unknown as typeof RGB_OFF)).toBe(true);
  });
  it('grid: divPulse pulses the TARGET clip pad blue in time', () => {
    const shiftTop = mkTop('grid', { shift: { held: true } });
    const on = computeSingleGridFrame({} as ClipPlayerData, {
      top: shiftTop,
      divPulse: { clipIndex: clipIndex(0, 0), on: true },
    });
    expect(eqRgb(at(on, padNote(0, 7)), RGB_TIMING_ARMED)).toBe(true);
    const off = computeSingleGridFrame({} as ClipPlayerData, {
      top: shiftTop,
      divPulse: { clipIndex: clipIndex(0, 0), on: false },
    });
    expect(eqRgb(at(off, padNote(0, 7)), RGB_TIMING)).toBe(true);
  });
  it('hexToRgb127 scales #rrggbb / #rgb into the 0..127 lighting range', () => {
    expect(hexToRgb127('#ff0000')).toEqual([127, 0, 0]);
    expect(hexToRgb127('#fff')).toEqual([127, 127, 127]);
    expect(hexToRgb127('#000000')).toEqual([0, 0, 0]);
  });
  it('grid: EVERY channel tints its clips by its effective colour (picked, else default hue); dim loaded, full playing; stop stays red', () => {
    const red = '#ff0000';
    const laneCol = new Array(8).fill(null);
    laneCol[2] = red; // channel 2 picked red; channel 3 left unpicked
    const data = {
      clips: {
        [clipIndex(0, 2)]: defaultNoteClip(), // loaded on the coloured lane 2
        [clipIndex(1, 2)]: defaultNoteClip(), // playing on lane 2
        [clipIndex(0, 3)]: defaultNoteClip(), // loaded on the UNcoloured lane 3
      },
      laneColor: laneCol,
      playing: [null, null, 1, null, null, null, null, null],
    } as unknown as ClipPlayerData;
    const f = computeSingleGridFrame(data, { top: mkTop('grid'), blinkOn: true });
    const rgb = hexToRgb127(red); // [127,0,0]
    // loaded clip on the coloured lane → a DIM version of the channel colour
    expect(eqRgb(at(f, padNote(2, 7 - 0)), [Math.round(rgb[0] * 0.32), 0, 0])).toBe(true);
    // playing clip on the coloured lane → the FULL channel colour
    expect(eqRgb(at(f, padNote(2, 7 - 1)), rgb)).toBe(true);
    // loaded clip on an UNpicked lane → its DEFAULT hue (dim), NOT cool-blue RGB_LOADED
    const d3 = hexToRgb127(defaultLaneColorHex(3));
    expect(
      eqRgb(at(f, padNote(3, 7 - 0)), [
        Math.round(d3[0] * 0.32),
        Math.round(d3[1] * 0.32),
        Math.round(d3[2] * 0.32),
      ]),
    ).toBe(true);
    // a queued-STOP on a coloured lane keeps the semantic RED, not the channel colour
    const stopData = {
      clips: { [clipIndex(0, 2)]: defaultNoteClip() },
      laneColor: laneCol,
      playing: [null, null, 0, null, null, null, null, null],
      queued: [null, null, 'stop', null, null, null, null, null],
    } as unknown as ClipPlayerData;
    const sf = computeSingleGridFrame(stopData, { top: mkTop('grid'), blinkOn: true });
    expect(eqRgb(at(sf, padNote(2, 7 - 0)), RGB_QUEUED_STOP)).toBe(true);
  });
  it('clip: note grid + clipRight column (KEYS bright orange, Double green, Step◀ blue)', () => {
    let clip: NoteClipRecord = defaultNoteClip();
    clip = toggleNoteAt(clip, 2, clip.root);
    const f = computeSingleClipFrame(clip, { top: mkTop('clip'), playheadStep: -1 });
    const noteCell = at(f, padNote(2, 0));
    expect(eqRgb(noteCell, RGB_WHITE), '100% note is white (probability colour)').toBe(true);
    expect(eqRgb(at(f, SCENE_CCS[3]), RGB_KEYS_ENTRY)).toBe(true); // KEYS bright orange
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_PATTERN)).toBe(true); // DOUBLE green
    expect(eqRgb(at(f, SCENE_CCS[6]), RGB_TIMING)).toBe(true); // STEP◀ blue
    expect(eqRgb(at(f, 93), RGB_VIEW_ACTIVE)).toBe(true); // clip active
  });
  it('clip: SOURCE-AWARE note colours through the frame (clip default → ORANGE, own prob → PURPLE, own 100% pins WHITE)', () => {
    let clip: NoteClipRecord = defaultNoteClip();
    clip = toggleNoteAt(clip, 1, clip.root); // no own prob → follows the clip default
    clip = toggleNoteAt(clip, 3, clip.root);
    clip = setNoteProb(clip, 3, clip.root, 0.25); // its own 25% → purple
    clip = toggleNoteAt(clip, 5, clip.root);
    clip = setNoteProb(clip, 5, clip.root, 1); // its own 100% (stored) → pins WHITE
    clip = setClipDefaultProb(clip, 0.5); // clip default → orange for the no-own-prob note
    const f = computeSingleClipFrame(clip, { top: mkTop('clip'), playheadStep: -1 });
    expect(eqRgb(at(f, padNote(1, 0)), probNoteRgbOrange(0.5)), 'no-own-prob note = clip-default ORANGE').toBe(true);
    expect(eqRgb(at(f, padNote(3, 0)), probNoteRgb(0.25)), "the note's own prob = PURPLE").toBe(true);
    expect(eqRgb(at(f, padNote(5, 0)), RGB_WHITE), 'own 100% pins WHITE over the 50% default').toBe(true);
  });
  it('clip + shift: Step buttons brighten (block jump); Follow lights bright when on', () => {
    const clip = defaultNoteClip();
    const f = computeSingleClipFrame(clip, {
      top: mkTop('clip', { shift: { held: true } }),
      followOn: true,
    });
    expect(eqRgb(at(f, SCENE_CCS[6]), RGB_TIMING_ARMED)).toBe(true); // Step◀ block-jump
    expect(eqRgb(at(f, SCENE_CCS[2]), RGB_PATTERN_ARMED)).toBe(true); // Follow on = bright green
  });
  it('keys: scale-select highlights the selected scale; the keyboard still paints', () => {
    const f = computeSingleKeysFrame({
      top: mkTop('clip', { keysActive: true }),
      keyboardRoot: 48,
      scale: 'major',
      lengthSteps: 16,
      selectedScale: 'major',
      arpOn: false,
      arpDir: 'up',
      arpDivIndex: 3,
      arpRangeIndex: 0,
      arpLatch: false,
    });
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_PATTERN_ARMED)).toBe(true); // MAJOR selected = bright
    expect(eqRgb(at(f, SCENE_CCS[1]), RGB_PATTERN)).toBe(true); // MINOR unselected = green
    expect(eqRgb(at(f, SCENE_CCS[7]), RGB_SYS_DIM)).toBe(true); // ARP off = dim orange
    expect(at(f, padNote(0, 1))).not.toBeNull(); // keyboard band still painted
    expect(eqRgb(at(f, 93), RGB_VIEW_ACTIVE)).toBe(true); // CLIP bright (KEYS sub-mode)
  });
  it('keys + shift: arp control column; the selected direction + latch brighten', () => {
    const f = computeSingleKeysFrame({
      top: mkTop('clip', { keysActive: true, shift: { held: true } }),
      keyboardRoot: 48,
      lengthSteps: 16,
      selectedScale: undefined,
      arpOn: true,
      arpDir: 'updown',
      arpDivIndex: 3,
      arpRangeIndex: 0,
      arpLatch: true,
    });
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_TIMING)).toBe(true); // ArpDiv+ blue
    expect(eqRgb(at(f, SCENE_CCS[4]), RGB_PATTERN_ARMED)).toBe(true); // ArpUpDown selected = bright
    expect(eqRgb(at(f, SCENE_CCS[2]), RGB_PATTERN)).toBe(true); // ArpUp unselected = green
    expect(eqRgb(at(f, SCENE_CCS[7]), RGB_SYS)).toBe(true); // ArpLatch on = orange
  });
  it('control: RESET + per-lane MONO/MUTE/RATE + STOP column + re-homed tempo/stop/rec/song', () => {
    const data: ClipPlayerData = {
      mono: [true, false, false, false, false, false, false, false],
      muted: [false, false, true, false, false, false, false, false],
      rate: [0, 3, 3, 3, 3, 3, 3, 5],
      playing: [0, null, null, null, null, null, null, null],
    } as ClipPlayerData;
    const f = computeSingleControlFrame({
      top: mkTop('control'),
      data,
      recording: true,
      arrangeMode: true,
      blinkOn: true,
    });
    expect(eqRgb(at(f, padNote(DECK_RESET_COL, DECK_RESET_ROW)), RGB_RESET)).toBe(true);
    expect(eqRgb(at(f, padNote(0, DECK_MONO_ROW)), RGB_MONO_ON)).toBe(true);
    expect(eqRgb(at(f, padNote(2, DECK_MUTE_ROW)), RGB_MUTE_ON)).toBe(true);
    expect(eqRgb(at(f, padNote(0, DECK_RATE_ROW)), RGB_RATE_BY_INDEX[0])).toBe(true);
    // STOP column: lane0 playing → bright red at the BOTTOM scene (SCENE_CCS[7]=row0=lane0).
    expect(eqRgb(at(f, SCENE_CCS[7]), RGB_STOP_ACTIVE)).toBe(true);
    // re-homed tempo nudges + STOP-ALL on the top grid row.
    expect(eqRgb(at(f, padNote(CTRL_TEMPO_DOWN_COL, CTRL_TEMPO_ROW)), RGB_TEMPO_NUDGE)).toBe(true);
    expect(eqRgb(at(f, padNote(CTRL_TEMPO_UP_COL, CTRL_TEMPO_ROW)), RGB_TEMPO_NUDGE)).toBe(true);
    expect(eqRgb(at(f, padNote(CTRL_STOP_ALL_COL, CTRL_TEMPO_ROW)), RGB_STOP_IDLE)).toBe(true);
    // REC lit (recording) + SONG = arrangement white.
    expect(at(f, padNote(CTRL_REC_COL, CTRL_ARRANGE_ROW))).not.toBeNull();
    expect(eqRgb(at(f, padNote(CTRL_SONG_COL, CTRL_ARRANGE_ROW)), RGB_SONG_ARRANGE)).toBe(true);
    // the old deck row-0 EDIT/COPY/… functions are DARK in the single control view.
    expect(at(f, padNote(DECK_EDIT_COL, 0))).toBeNull();
    // permanent nav: control active.
    expect(eqRgb(at(f, 95), RGB_VIEW_ACTIVE)).toBe(true);
  });
  it('arranger: a dim 8×8, a dark right column, and the permanent nav (Arranger active)', () => {
    const f = computeSingleArrangerFrame({ top: mkTop('arranger') });
    expect(eqRgb(at(f, padNote(0, 0)), RGB_ARRANGER_DIM)).toBe(true);
    expect(eqRgb(at(f, padNote(7, 7)), RGB_ARRANGER_DIM)).toBe(true);
    expect(eqRgb(at(f, SCENE_CCS[0]), RGB_OFF)).toBe(true); // right column dark
    expect(eqRgb(at(f, 94), RGB_VIEW_ACTIVE)).toBe(true); // arranger active = bright purple
  });

  it('control: the OLD AUTO pad at (2,6) is RETIRED — dark; the top row carries the per-lane arm instead', () => {
    const idle = computeSingleControlFrame({ top: mkTop('control'), data: {} as ClipPlayerData, blinkOn: true });
    expect(at(idle, padNote(2, CTRL_ARRANGE_ROW)), 'unpainted = dark').toBeNull();
    // An armed lane shows on the PERMANENT TOP ROW even in the control view
    // (the always-visible arm overlay), not on any grid pad.
    const armed = computeSingleControlFrame({
      top: mkTop('control', { laneArms: [true], blinkOn: true }),
      data: { automation: { lanes: [{ arm: true }] } } as ClipPlayerData,
      blinkOn: true,
    });
    expect(at(armed, padNote(2, CTRL_ARRANGE_ROW)), 'still dark').toBeNull();
    expect(eqRgb(at(armed, 91), RGB_RECORDING)).toBe(true); // lane 0's top button flashes red
  });

  it('countdownRgb: yellow/red map to the qrec/record palette with an on-beat pulse', () => {
    expect(countdownRgb({ color: 'yellow', on: true })).toEqual(RGB_QREC_ARMED);
    expect(countdownRgb({ color: 'yellow', on: false })).toEqual(RGB_QREC_IDLE);
    expect(countdownRgb({ color: 'red', on: true })).toEqual(RGB_RECORDING);
    expect(countdownRgb({ color: 'red', on: false })).toEqual(RGB_RECORDING_DIM);
  });

  it('grid: EACH recording lane’s clip cell flashes ITS countdown when its scene is in view (per-lane)', () => {
    const idxA = clipIndex(0, 7); // recording clip at lane 7, slot 0 (flat, stride-64)
    const idxB = clipIndex(1, 2); // a SECOND recording lane (lane 2, slot 1)
    const padA = clipIndexToGridPad(idxA);
    const padB = clipIndexToGridPad(idxB);
    const f = computeSingleGridFrame({} as ClipPlayerData, {
      top: mkTop('grid'),
      blinkOn: true,
      autoCountdown: [
        { clipIndex: idxA, color: 'red', on: true },
        { clipIndex: idxB, color: 'yellow', on: false },
      ],
    });
    expect(eqRgb(at(f, padNote(padA.x, padA.y)), RGB_RECORDING)).toBe(true);
    expect(eqRgb(at(f, padNote(padB.x, padB.y)), RGB_QREC_IDLE)).toBe(true);
  });
});
