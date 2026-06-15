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
  noteAt,
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
export const LED_NOTE_LOW = 4;
export const LED_NOTE_MED = 9;
export const LED_NOTE_HIGH = 15;
export const LED_PLAYHEAD = 2; // faint wash on the current step column
export const LED_ROOT_GUIDE = 1; // faint marker on root-pitch-class rows

// --- Control-pad coordinates ---
export const CTRL_STOP_COL = CLIP_SLOTS; // 8 — per-lane stop
export const CTRL_SCENE_COL = CLIP_SLOTS + 1; // 9 — scene launch
export const EDIT_PAD = { x: GRID_WIDTH - 1, y: 0 } as const; // (15,0)
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
// EDIT-mode mapping (PURE)
// ---------------------------------------------------------------------------

/** Display row y (0 = top) → MIDI note for a clip, given an octave-view offset. */
export function editRowToMidi(clip: NoteClipRecord, y: number, octaveOffset = 0): number {
  const scaleLen = scaleSteps(clip.scale).length;
  const logicalRow = octaveOffset * scaleLen + (GRID_HEIGHT - 1 - y);
  return rowToMidi(logicalRow, clip.root, clip.scale);
}

/**
 * An edit-mode pad (x,y) → the {step, midi} it edits, or null when it's the
 * reserved EDIT pad or a step beyond the clip's length / the 16-wide window.
 */
export function editPadToNote(
  clip: NoteClipRecord,
  x: number,
  y: number,
  octaveOffset = 0,
): { step: number; midi: number } | null {
  if (isEditPad(x, y)) return null;
  if (x < 0 || x >= GRID_WIDTH || y < 0 || y >= GRID_HEIGHT) return null;
  if (x >= clip.lengthSteps) return null; // beyond the clip
  return { step: x, midi: editRowToMidi(clip, y, octaveOffset) };
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
 * Full 128-cell EDIT-mode LED frame for one clip: notes lit by velocity tier,
 * a faint wash on the live playhead column, a faint guide on root-pitch-class
 * rows, and the reserved EDIT pad. `playheadStep` < 0 = not playing.
 */
export function computeEditLeds(
  clip: NoteClipRecord,
  playheadStep: number,
  octaveOffset = 0,
): Uint8Array {
  const frame = new Uint8Array(GRID_CELLS);
  const rootPc = ((clip.root % 12) + 12) % 12;
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const fi = frameIndex(x, y);
      if (isEditPad(x, y)) {
        frame[fi] = LED_EDIT_PAD;
        continue;
      }
      const note = editPadToNote(clip, x, y, octaveOffset);
      if (!note) {
        frame[fi] = LED_EMPTY;
        continue;
      }
      const ev = noteAt(clip, note.step, note.midi);
      if (ev) {
        frame[fi] = TIER_LED[velTier(ev.velocity)];
        continue;
      }
      let base = LED_EMPTY;
      if (x === playheadStep) base = LED_PLAYHEAD;
      if (((note.midi % 12) + 12) % 12 === rootPc) base = Math.max(base, LED_ROOT_GUIDE);
      frame[fi] = base;
    }
  }
  return frame;
}
