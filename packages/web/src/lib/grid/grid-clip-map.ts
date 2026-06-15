// packages/web/src/lib/grid/grid-clip-map.ts
//
// PURE mapping between the monome grid's 16×8 surface and the 8-lane clip
// launcher. Hardware-free so the pad↔clip math + LED-frame computation are
// unit-testable; the binding (grid-clip-binding.svelte.ts) wires these to the
// live grid + graph store.
//
// SESSION mode (DECIDED 2026-06-15):
//   LEFT 8×8 (cols 0-7) = the clip matrix. ROWS = instrument lanes (y), COLS =
//   clip slots (x); pad (x,y) ↔ clip index lane*8+slot (= y*8+x, unchanged).
//   RIGHT control strip:
//     col 8  rows 0-7 → per-lane STOP  (row y stops lane y)
//     col 9  rows 0-7 → SCENE LAUNCH   (row y fires slot y across ALL lanes)
//     (15,0) → EDIT (hold + tap a clip to open its note editor; reserved in
//              BOTH modes so it's never a clip/note cell)
//     (15,6) → STOP ALL
//     (15,7) → TRANSPORT (toggle TIMELORDE.running; dark when ext-clocked)
//
// EDIT mode: the full 16×8 becomes the clip's note grid — X = step (0-15),
//   Y = pitch (row 0 = top/highest, in-key), EXCEPT (15,0) stays the EDIT pad
//   (tap to exit). Press a cell to cycle its note OFF→MED→LOW→HIGH→off (the
//   same velocity gesture as the card).

import {
  CLIP_LANES,
  CLIP_SLOTS,
  clipIndex,
  laneOf,
  slotOf,
  lanePlaying,
  laneQueued,
  rowToMidi,
  scaleSteps,
  noteCovering,
  velTier,
  type ClipPlayerData,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';
import { GRID_WIDTH, GRID_HEIGHT, GRID_CELLS } from './mext';

// --- Session LED levels (0-15 varibright) ---
export const LED_EMPTY = 0;
export const LED_LOADED = 6;
export const LED_QUEUED_LO = 3;
export const LED_QUEUED_HI = 12;
export const LED_PLAYING = 15;
export const LED_STOP_IDLE = 3;
export const LED_STOP_ACTIVE = 12;
export const LED_SCENE_IDLE = 4;
export const LED_EDIT_PAD = 5;
export const LED_TRANSPORT_ON = 15;

// --- Edit-mode LED levels ---
// A note is lit by its velocity tier; the playhead column washes empties + boosts
// the note it crosses to full. The bottom FUNCTION ROW holds the editor controls.
export const LED_NOTE_LOW = 5;
export const LED_NOTE_MED = 10;
export const LED_NOTE_HIGH = 15;
export const LED_NOTE_PLAYHEAD = 15; // a note the playhead is currently over
export const LED_PLAYHEAD = 6; // wash on the current-step column (the pulse)
export const LED_ROOT_GUIDE = 1; // faint marker on root-pitch-class rows
export const LED_FUNC = 5; // a function-row pad (idle)
export const LED_FUNC_ON = 15; // a held function-row pad (e.g. VEL armed)

// --- Edit-mode geometry: 7 note rows (0..6) + a bottom FUNCTION ROW (7) ---
export const NOTE_ROWS = GRID_HEIGHT - 1; // 7 pitch rows (= 1 in-key octave)
export const FUNC_ROW = GRID_HEIGHT - 1; // row 7 = controls
export const EDIT_EXIT_PAD = { x: 0, y: FUNC_ROW } as const; // tap → leave the editor
export const VEL_PAD = { x: 1, y: FUNC_ROW } as const; // hold + tap a note → cycle velocity
export const OCT_DOWN_PAD = { x: 2, y: FUNC_ROW } as const; // shift the pitch window down
export const OCT_UP_PAD = { x: 3, y: FUNC_ROW } as const; // shift the pitch window up

// --- Session-mode control-pad coordinates ---
export const CTRL_STOP_COL = CLIP_SLOTS; // 8 — per-lane stop
export const CTRL_SCENE_COL = CLIP_SLOTS + 1; // 9 — scene launch
export const EDIT_PAD = { x: GRID_WIDTH - 1, y: 0 } as const; // (15,0) — hold to enter edit
export const STOPALL_PAD = { x: GRID_WIDTH - 1, y: GRID_HEIGHT - 2 } as const; // (15,6)
export const TRANSPORT_PAD = { x: GRID_WIDTH - 1, y: GRID_HEIGHT - 1 } as const; // (15,7)

/** Row-major frame offset for (x,y) in a 16-wide grid. */
function frameIndex(x: number, y: number): number {
  return y * GRID_WIDTH + x;
}

// ---------------------------------------------------------------------------
// SESSION pad classifiers (PURE)
// ---------------------------------------------------------------------------

/** Left-quadrant pad (x=slot, y=lane) → flat clip index, or null. */
export function padToClipIndex(x: number, y: number): number | null {
  if (x < 0 || x >= CLIP_SLOTS || y < 0 || y >= CLIP_LANES) return null;
  return clipIndex(x, y); // y*CLIP_SLOTS + x
}
/** Flat clip index → its (x=slot, y=lane) on the grid's left quadrant. */
export function clipIndexToPad(index: number): { x: number; y: number } {
  return { x: slotOf(index), y: laneOf(index) };
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

/** Display row y (0 = top, NOTE_ROWS-1 = bottom note row) → MIDI for a clip. */
export function editRowToMidi(clip: NoteClipRecord, y: number, octaveOffset = 0): number {
  const scaleLen = scaleSteps(clip.scale).length;
  const logicalRow = octaveOffset * scaleLen + (NOTE_ROWS - 1 - y);
  return rowToMidi(logicalRow, clip.root, clip.scale);
}

/**
 * An edit-mode pad (x,y) → the {step, midi} it edits, or null when it's in the
 * function row, or a step beyond the clip's length / the 16-wide window.
 */
export function editPadToNote(
  clip: NoteClipRecord,
  x: number,
  y: number,
  octaveOffset = 0,
): { step: number; midi: number } | null {
  if (x < 0 || x >= GRID_WIDTH || y < 0 || y >= NOTE_ROWS) return null; // func row / oob
  if (x >= clip.lengthSteps) return null; // beyond the clip
  return { step: x, midi: editRowToMidi(clip, y, octaveOffset) };
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

// ---------------------------------------------------------------------------
// LED frames (PURE)
// ---------------------------------------------------------------------------

export interface SessionLedOpts {
  transportRunning?: boolean;
  /** True while EDIT is held — lights the EDIT pad bright as feedback. */
  editArmed?: boolean;
}

/**
 * Full 128-cell Session LED frame from the clip-player's live per-lane data.
 * Left quadrant = clips (empty/loaded/queued-blink/playing); right strip =
 * per-lane stop, scene-launch, edit, stop-all, transport. Local render state.
 */
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
    // per-lane STOP pad: brighter while the lane plays
    frame[frameIndex(CTRL_STOP_COL, lane)] = pl !== null ? LED_STOP_ACTIVE : LED_STOP_IDLE;
  }
  // scene-launch column (one pad per slot)
  for (let slot = 0; slot < CLIP_SLOTS; slot++) {
    frame[frameIndex(CTRL_SCENE_COL, slot)] = LED_SCENE_IDLE;
  }
  frame[frameIndex(EDIT_PAD.x, EDIT_PAD.y)] = opts.editArmed ? LED_PLAYING : LED_EDIT_PAD;
  frame[frameIndex(STOPALL_PAD.x, STOPALL_PAD.y)] = anyPlaying ? LED_STOP_ACTIVE : LED_STOP_IDLE;
  frame[frameIndex(TRANSPORT_PAD.x, TRANSPORT_PAD.y)] = opts.transportRunning
    ? LED_TRANSPORT_ON
    : LED_STOP_IDLE;
  return frame;
}

const TIER_LED: Record<'low' | 'med' | 'high', number> = {
  low: LED_NOTE_LOW,
  med: LED_NOTE_MED,
  high: LED_NOTE_HIGH,
};

/**
 * Full 128-cell EDIT-mode LED frame for one clip. Note rows (0..NOTE_ROWS-1):
 * a note lights its WHOLE held span by velocity tier (the playhead column boosts
 * the note it crosses to full and washes empties). Bottom FUNCTION ROW: EDIT
 * (exit), VEL (bright while held), OCT−, OCT+. `playheadStep` < 0 = not playing.
 */
export function computeEditLeds(
  clip: NoteClipRecord,
  playheadStep: number,
  octaveOffset = 0,
  velArmed = false,
): Uint8Array {
  const frame = new Uint8Array(GRID_CELLS);
  const rootPc = ((clip.root % 12) + 12) % 12;
  for (let y = 0; y < NOTE_ROWS; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const fi = frameIndex(x, y);
      const note = editPadToNote(clip, x, y, octaveOffset);
      if (!note) {
        frame[fi] = LED_EMPTY;
        continue;
      }
      const onPlayhead = x === playheadStep;
      const cov = noteCovering(clip, note.step, note.midi);
      if (cov) {
        frame[fi] = onPlayhead ? LED_NOTE_PLAYHEAD : TIER_LED[velTier(cov.velocity)];
        continue;
      }
      let base = LED_EMPTY;
      if (onPlayhead) base = LED_PLAYHEAD; // the moving pulse column
      if (((note.midi % 12) + 12) % 12 === rootPc) base = Math.max(base, LED_ROOT_GUIDE);
      frame[fi] = base;
    }
  }
  // Function row.
  frame[frameIndex(EDIT_EXIT_PAD.x, EDIT_EXIT_PAD.y)] = LED_FUNC;
  frame[frameIndex(VEL_PAD.x, VEL_PAD.y)] = velArmed ? LED_FUNC_ON : LED_FUNC;
  frame[frameIndex(OCT_DOWN_PAD.x, OCT_DOWN_PAD.y)] = LED_FUNC;
  frame[frameIndex(OCT_UP_PAD.x, OCT_UP_PAD.y)] = LED_FUNC;
  return frame;
}
