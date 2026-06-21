// packages/web/src/lib/control/monome/monome-map.ts
//
// MONOME PLACEMENT adapter — the monome grid's 16×8 surface laid over the
// controller-agnostic clip-surface core (`$lib/control/clip-surface-map`). This
// file supplies ONLY the monome-specific PLACEMENT (where every control pad
// lands on the 16-wide grid, the 16×8 row-major frame, the 7-note-rows +
// function-row geometry) and re-exports the shared brain so the monome binding
// (monome-control.svelte.ts) + the docs spec import one module, exactly as
// before. Behaviour is IDENTICAL to the old `grid/grid-clip-map.ts`.
//
// SESSION mode:
//   LEFT 8×8 (cols 0-7) = the clip matrix. ROWS = instrument lanes (y), COLS =
//   clip slots (x); pad (x,y) ↔ clip index lane*8+slot (= y*8+x).
//   RIGHT control strip:
//     col 8  rows 0-7 → per-lane STOP  (row y stops lane y)
//     col 9  rows 0-7 → SCENE LAUNCH   (row y fires slot y across ALL lanes)
//     (15,0) → EDIT · (15,2) COPY · (15,3) COPY-IND · (15,4) PASTE ·
//     (15,5) PASTE-REV · (15,6) STOP ALL · (15,7) TRANSPORT
//
// EDIT mode: rows 0..6 = note grid (X = step over the shown 16-step page, Y =
//   pitch), row 7 = the FUNCTION ROW.
// LENGTH-EDIT mode: a 2-row page (row 0 = end-BLOCK ruler + EXIT, row 1 =
//   end-STEP ruler).

import {
  CLIP_LANES,
  CLIP_SLOTS,
  clipIndex,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
  type ClipPlayerData,
  type NoteClipRecord,
  lanePlaying,
  laneQueued,
} from '$lib/audio/modules/clip-types';
import { GRID_WIDTH, GRID_HEIGHT, GRID_CELLS } from './mext';
import {
  // LED level constants (shared decisions).
  LED_EMPTY,
  LED_LOADED,
  LED_QUEUED_LO,
  LED_QUEUED_HI,
  LED_PLAYING,
  LED_STOP_IDLE,
  LED_STOP_ACTIVE,
  LED_SCENE_IDLE,
  LED_EDIT_PAD,
  LED_TRANSPORT_ON,
  LED_MOD_IDLE,
  LED_MOD_ON,
  LED_FUNC,
  LED_FUNC_ON,
  LED_FUNC_DIM,
  LED_FUNC_FLASH,
  LED_LEN_BLOCK,
  LED_LEN_END,
  LED_LEN_EXIT,
  // shared brains
  clipIndexForSlotLane,
  slotLaneForClipIndex,
  editLogicalRowToMidi,
  editPageCount,
  noteForCell,
  noteCellLevel,
  lengthEditAction,
  lengthRulers,
  copyIndicatorLevel,
  type LengthEditAction,
} from '../clip-surface-map';

// Re-export the shared LED constants + core helpers so existing importers of
// `grid-clip-map` (now `monome-map`) keep their import surface unchanged.
export {
  LED_EMPTY,
  LED_LOADED,
  LED_QUEUED_LO,
  LED_QUEUED_HI,
  LED_PLAYING,
  LED_STOP_IDLE,
  LED_STOP_ACTIVE,
  LED_SCENE_IDLE,
  LED_EDIT_PAD,
  LED_TRANSPORT_ON,
  LED_MOD_IDLE,
  LED_MOD_ON,
  LED_FUNC,
  LED_FUNC_ON,
  LED_FUNC_DIM,
  LED_FUNC_FLASH,
  LED_LEN_BLOCK,
  LED_LEN_END,
  LED_LEN_EXIT,
  LED_NOTE_BRIGHTNESS,
  LED_NOTE_PLAYHEAD,
  LED_PLAYHEAD,
  LED_ROOT_GUIDE,
  LED_COPY_IND_PULSE,
  editPageCount,
  type LengthEditAction,
} from '../clip-surface-map';

// ---------------------------------------------------------------------------
// Edit-mode geometry: 7 note rows (0..6) + a bottom FUNCTION ROW (7).
// ---------------------------------------------------------------------------
export const NOTE_ROWS = GRID_HEIGHT - 1; // 7 pitch rows (= 1 in-key octave)
export const FUNC_ROW = GRID_HEIGHT - 1; // row 7 = controls
// Function-row layout with spacer gaps for legibility:
//   [EDIT] [VEL] _ [ROW−] [OCT−] _ [ROW+] [OCT+] _ [SCALE] _ [FOLLOW] [LEFT] [RIGHT] [DOUBLE] [LEN]
export const EDIT_EXIT_PAD = { x: 0, y: FUNC_ROW } as const; // tap → leave the editor
export const VEL_PAD = { x: 1, y: FUNC_ROW } as const; // hold + tap a note → cycle velocity
export const ROW_DOWN_PAD = { x: 3, y: FUNC_ROW } as const; // shift the pitch window down 1 row
export const OCT_DOWN_PAD = { x: 4, y: FUNC_ROW } as const; // shift the pitch window down 1 octave
export const ROW_UP_PAD = { x: 6, y: FUNC_ROW } as const; // shift the pitch window up 1 row
export const OCT_UP_PAD = { x: 7, y: FUNC_ROW } as const; // shift the pitch window up 1 octave
export const SCALE_PAD = { x: 9, y: FUNC_ROW } as const; // cycle the clip's scale
export const FOLLOW_PAD = { x: 11, y: FUNC_ROW } as const; // tap-toggle auto-scroll
export const PAGE_LEFT_PAD = { x: 12, y: FUNC_ROW } as const; // page left (only when frozen)
export const PAGE_RIGHT_PAD = { x: 13, y: FUNC_ROW } as const; // page right (only when frozen)
export const DOUBLE_PAD = { x: 14, y: FUNC_ROW } as const; // double the clip length
export const LENGTH_EDIT_PAD = { x: 15, y: FUNC_ROW } as const; // open the LENGTH-EDIT page

// ---------------------------------------------------------------------------
// Session-mode control-pad coordinates.
// ---------------------------------------------------------------------------
export const CTRL_STOP_COL = CLIP_SLOTS; // 8 — per-lane stop
export const CTRL_SCENE_COL = CLIP_SLOTS + 1; // 9 — scene launch
export const EDIT_PAD = { x: GRID_WIDTH - 1, y: 0 } as const; // (15,0) — hold to enter edit
export const COPY_PAD = { x: GRID_WIDTH - 1, y: 2 } as const; // (15,2) — hold + tap clip → copy
export const COPY_IND_PAD = { x: GRID_WIDTH - 1, y: 3 } as const; // (15,3) — render-only buffer indicator
export const PASTE_PAD = { x: GRID_WIDTH - 1, y: 4 } as const; // (15,4) — hold + tap clip → paste
export const PASTE_REV_PAD = { x: GRID_WIDTH - 1, y: 5 } as const; // (15,5) — hold + tap → paste reversed
export const STOPALL_PAD = { x: GRID_WIDTH - 1, y: GRID_HEIGHT - 2 } as const; // (15,6)
export const TRANSPORT_PAD = { x: GRID_WIDTH - 1, y: GRID_HEIGHT - 1 } as const; // (15,7)

/** Row-major frame offset for (x,y) in a 16-wide grid. */
function frameIndex(x: number, y: number): number {
  return y * GRID_WIDTH + x;
}

// ---------------------------------------------------------------------------
// SESSION pad classifiers (PURE) — placement → the shared brain.
// ---------------------------------------------------------------------------

/** Left-quadrant pad (x=slot, y=lane) → flat clip index, or null. */
export function padToClipIndex(x: number, y: number): number | null {
  return clipIndexForSlotLane(x, y); // monome: pad.x = slot, pad.y = lane
}
/** Flat clip index → its (x=slot, y=lane) on the grid's left quadrant. */
export function clipIndexToPad(index: number): { x: number; y: number } {
  const { slot, lane } = slotLaneForClipIndex(index);
  return { x: slot, y: lane };
}
/** STOP-column pad → the lane it stops, or null. */
export function stopLaneForPad(x: number, y: number): number | null {
  if (x === CTRL_STOP_COL && y >= 0 && y < CLIP_LANES) return y;
  return null;
}
/** SCENE-column pad → the slot it launches across all lanes, or null. */
export function sceneSlotForPad(x: number, y: number): number | null {
  if (x === CTRL_SCENE_COL && y >= 0 && y < CLIP_SLOTS) return y;
  return null;
}
export function isEditPad(x: number, y: number): boolean {
  return x === EDIT_PAD.x && y === EDIT_PAD.y;
}
export function isStopAllPad(x: number, y: number): boolean {
  return x === STOPALL_PAD.x && y === STOPALL_PAD.y;
}
export function isTransportPad(x: number, y: number): boolean {
  return x === TRANSPORT_PAD.x && y === TRANSPORT_PAD.y;
}

// ---------------------------------------------------------------------------
// EDIT-mode mapping (PURE) — note grid = rows 0..NOTE_ROWS-1 × all 16 steps;
// row NOTE_ROWS (= FUNC_ROW) is the function row, never a note cell.
// ---------------------------------------------------------------------------

/** Display row y (0 = top, NOTE_ROWS-1 = bottom note row) → MIDI for a clip.
 *  Converts the monome's top-down physical row to the core's logical row. */
export function editRowToMidi(clip: NoteClipRecord, y: number, rowOffset = 0): number {
  const logicalRow = rowOffset + (NOTE_ROWS - 1 - y);
  return editLogicalRowToMidi(clip, logicalRow);
}

/**
 * An edit-mode pad (x,y) → the {step, midi} it edits, or null when it's in the
 * function row, out of grid, or a step beyond the clip's length. `page`
 * selects which 16-step window the columns map to: realStep = page*16 + x.
 */
export function editPadToNote(
  clip: NoteClipRecord,
  x: number,
  y: number,
  rowOffset = 0,
  page = 0,
): { step: number; midi: number } | null {
  if (x < 0 || x >= GRID_WIDTH || y < 0 || y >= NOTE_ROWS) return null; // func row / oob
  const logicalRow = NOTE_ROWS - 1 - y; // monome top-down → core bottom-up
  return noteForCell(clip, x, logicalRow, rowOffset, page);
}

// EDIT-mode function-row pad classifiers.
export function isEditExitPad(x: number, y: number): boolean {
  return x === EDIT_EXIT_PAD.x && y === EDIT_EXIT_PAD.y;
}
export function isVelPad(x: number, y: number): boolean {
  return x === VEL_PAD.x && y === VEL_PAD.y;
}
export function isOctDownPad(x: number, y: number): boolean {
  return x === OCT_DOWN_PAD.x && y === OCT_DOWN_PAD.y;
}
export function isOctUpPad(x: number, y: number): boolean {
  return x === OCT_UP_PAD.x && y === OCT_UP_PAD.y;
}
export function isRowDownPad(x: number, y: number): boolean {
  return x === ROW_DOWN_PAD.x && y === ROW_DOWN_PAD.y;
}
export function isRowUpPad(x: number, y: number): boolean {
  return x === ROW_UP_PAD.x && y === ROW_UP_PAD.y;
}
export function isScalePad(x: number, y: number): boolean {
  return x === SCALE_PAD.x && y === SCALE_PAD.y;
}
export function isFollowPad(x: number, y: number): boolean {
  return x === FOLLOW_PAD.x && y === FOLLOW_PAD.y;
}
export function isPageLeftPad(x: number, y: number): boolean {
  return x === PAGE_LEFT_PAD.x && y === PAGE_LEFT_PAD.y;
}
export function isPageRightPad(x: number, y: number): boolean {
  return x === PAGE_RIGHT_PAD.x && y === PAGE_RIGHT_PAD.y;
}
export function isDoublePad(x: number, y: number): boolean {
  return x === DOUBLE_PAD.x && y === DOUBLE_PAD.y;
}
export function isLengthEditPad(x: number, y: number): boolean {
  return x === LENGTH_EDIT_PAD.x && y === LENGTH_EDIT_PAD.y;
}

// --- SESSION held-modifier classifiers (COPY / PASTE / PASTE-REV) ---
export function isCopyPad(x: number, y: number): boolean {
  return x === COPY_PAD.x && y === COPY_PAD.y;
}
export function isPastePad(x: number, y: number): boolean {
  return x === PASTE_PAD.x && y === PASTE_PAD.y;
}
export function isPasteRevPad(x: number, y: number): boolean {
  return x === PASTE_REV_PAD.x && y === PASTE_REV_PAD.y;
}

// ---------------------------------------------------------------------------
// LENGTH-EDIT page mapping (PURE) — the monome's 2-row placement over the core
// classifier. ROW 0 pads 0..7 = the end BLOCK; ROW 0 pad 15 = EXIT; ROW 1 pads
// 0..15 = the end STEP.
// ---------------------------------------------------------------------------
export function isLengthEditExitPad(x: number, y: number): boolean {
  return y === 0 && x === GRID_WIDTH - 1;
}
/** Classify a LENGTH-EDIT pad press → its action, or null for an unused pad. */
export function lengthEditPad(x: number, y: number): LengthEditAction | null {
  return lengthEditAction(y, x, isLengthEditExitPad(x, y));
}

// ---------------------------------------------------------------------------
// LED frames (PURE) — the 16×8 monome placement painted from the shared brain.
// ---------------------------------------------------------------------------

export interface SessionLedOpts {
  transportRunning?: boolean;
  /** True while EDIT is held — lights the EDIT pad bright as feedback. */
  editArmed?: boolean;
  /** True while COPY / PASTE / PASTE-REV is held (lights that pad bright). */
  copyHeld?: boolean;
  pasteHeld?: boolean;
  pasteRevHeld?: boolean;
  /** True when the per-machine copy buffer holds a clip (pulses the indicator). */
  bufferArmed?: boolean;
  /** Free-running blink phase; the copy-indicator pulse ramp is indexed off it. */
  blinkPhase?: number;
}

export function computeSessionLeds(
  data: ClipPlayerData | undefined,
  blinkOn: boolean,
  opts: SessionLedOpts = {},
): Uint8Array {
  const frame = new Uint8Array(GRID_CELLS);
  const clips = data?.clips ?? {};

  let anyPlaying = false;
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const pl = lanePlaying(data, lane);
    const q = laneQueued(data, lane);
    if (pl !== null) anyPlaying = true;
    for (let slot = 0; slot < CLIP_SLOTS; slot++) {
      const fi = frameIndex(slot, lane);
      if (pl === slot) {
        frame[fi] = q === 'stop' && blinkOn ? LED_LOADED : LED_PLAYING;
      } else if (q === slot) {
        frame[fi] = blinkOn ? LED_QUEUED_HI : LED_QUEUED_LO;
      } else if (clips[String(clipIndex(slot, lane))]) {
        frame[fi] = LED_LOADED;
      } else {
        frame[fi] = LED_EMPTY;
      }
    }
    frame[frameIndex(CTRL_STOP_COL, lane)] = pl !== null ? LED_STOP_ACTIVE : LED_STOP_IDLE;
  }
  for (let slot = 0; slot < CLIP_SLOTS; slot++) {
    frame[frameIndex(CTRL_SCENE_COL, slot)] = LED_SCENE_IDLE;
  }
  frame[frameIndex(EDIT_PAD.x, EDIT_PAD.y)] = opts.editArmed ? LED_PLAYING : LED_EDIT_PAD;
  frame[frameIndex(COPY_PAD.x, COPY_PAD.y)] = opts.copyHeld ? LED_MOD_ON : LED_MOD_IDLE;
  frame[frameIndex(PASTE_PAD.x, PASTE_PAD.y)] = opts.pasteHeld ? LED_MOD_ON : LED_MOD_IDLE;
  frame[frameIndex(PASTE_REV_PAD.x, PASTE_REV_PAD.y)] = opts.pasteRevHeld ? LED_MOD_ON : LED_MOD_IDLE;
  frame[frameIndex(COPY_IND_PAD.x, COPY_IND_PAD.y)] = opts.bufferArmed
    ? copyIndicatorLevel(opts.blinkPhase ?? 0)
    : LED_EMPTY;
  frame[frameIndex(STOPALL_PAD.x, STOPALL_PAD.y)] = anyPlaying ? LED_STOP_ACTIVE : LED_STOP_IDLE;
  frame[frameIndex(TRANSPORT_PAD.x, TRANSPORT_PAD.y)] = opts.transportRunning
    ? LED_TRANSPORT_ON
    : LED_STOP_IDLE;
  return frame;
}

export interface EditLedOpts {
  rowOffset?: number;
  velArmed?: boolean;
  followOn?: boolean;
  editPage?: number;
}

export function computeEditLeds(
  clip: NoteClipRecord,
  playheadStep: number,
  rowOffsetOrOpts: number | EditLedOpts = 0,
  velArmedArg = false,
): Uint8Array {
  const opts: EditLedOpts =
    typeof rowOffsetOrOpts === 'number'
      ? { rowOffset: rowOffsetOrOpts, velArmed: velArmedArg }
      : rowOffsetOrOpts;
  const rowOffset = opts.rowOffset ?? 0;
  const velArmed = opts.velArmed ?? false;
  const followOn = opts.followOn ?? true;
  const pageCount = editPageCount(clip);
  const playheadPage = playheadStep >= 0 ? Math.floor(playheadStep / STEPS_PER_PAGE) : -1;
  const shownPage = followOn
    ? playheadStep >= 0
      ? playheadPage
      : 0
    : Math.max(0, Math.min(pageCount - 1, opts.editPage ?? 0));

  const frame = new Uint8Array(GRID_CELLS);
  const localPlayheadX = playheadPage === shownPage ? playheadStep - shownPage * STEPS_PER_PAGE : -1;
  for (let y = 0; y < NOTE_ROWS; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const fi = frameIndex(x, y);
      const note = editPadToNote(clip, x, y, rowOffset, shownPage);
      if (!note) {
        frame[fi] = LED_EMPTY;
        continue;
      }
      frame[fi] = noteCellLevel(clip, note.step, note.midi, x === localPlayheadX);
    }
  }
  // Function row (spacer pads at x=2,5,8,10 stay dark / LED_EMPTY).
  frame[frameIndex(EDIT_EXIT_PAD.x, EDIT_EXIT_PAD.y)] = LED_FUNC;
  frame[frameIndex(VEL_PAD.x, VEL_PAD.y)] = velArmed ? LED_FUNC_ON : LED_FUNC;
  frame[frameIndex(ROW_DOWN_PAD.x, ROW_DOWN_PAD.y)] = LED_FUNC;
  frame[frameIndex(OCT_DOWN_PAD.x, OCT_DOWN_PAD.y)] = LED_FUNC;
  frame[frameIndex(ROW_UP_PAD.x, ROW_UP_PAD.y)] = LED_FUNC;
  frame[frameIndex(OCT_UP_PAD.x, OCT_UP_PAD.y)] = LED_FUNC;
  frame[frameIndex(SCALE_PAD.x, SCALE_PAD.y)] = LED_FUNC;
  frame[frameIndex(FOLLOW_PAD.x, FOLLOW_PAD.y)] = followOn ? LED_FUNC_ON : LED_FUNC_FLASH;
  const canLeft = !followOn && shownPage > 0;
  const canRight = !followOn && shownPage < pageCount - 1;
  frame[frameIndex(PAGE_LEFT_PAD.x, PAGE_LEFT_PAD.y)] = canLeft ? LED_FUNC : LED_FUNC_DIM;
  frame[frameIndex(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y)] = canRight ? LED_FUNC : LED_FUNC_DIM;
  frame[frameIndex(DOUBLE_PAD.x, DOUBLE_PAD.y)] = LED_FUNC;
  frame[frameIndex(LENGTH_EDIT_PAD.x, LENGTH_EDIT_PAD.y)] = LED_FUNC;
  return frame;
}

export function computeLengthEditLeds(clip: NoteClipRecord): Uint8Array {
  const frame = new Uint8Array(GRID_CELLS);
  const { endBlock, endStep } = lengthRulers(clip);
  // ROW 0: the block ruler (cells are 1-based; pad x = cell x+1).
  for (let x = 0; x < MAX_EDIT_PAGES; x++) {
    const cell = x + 1;
    frame[frameIndex(x, 0)] =
      cell < endBlock ? LED_LEN_BLOCK : cell === endBlock ? LED_LEN_END : LED_EMPTY;
  }
  frame[frameIndex(GRID_WIDTH - 1, 0)] = LED_LEN_EXIT; // EXIT pad
  // ROW 1: the step-within-end-block ruler.
  for (let x = 0; x < STEPS_PER_PAGE; x++) {
    const cell = x + 1;
    frame[frameIndex(x, 1)] =
      cell < endStep ? LED_LEN_BLOCK : cell === endStep ? LED_LEN_END : LED_EMPTY;
  }
  return frame;
}
