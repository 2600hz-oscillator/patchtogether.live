// packages/web/src/lib/control/launchpad/launchpad-map.ts
//
// LAUNCHPAD PLACEMENT adapter — the 2× Launchpad Mini Mk3 surface laid over the
// controller-agnostic clip-surface core (`$lib/control/clip-surface-map`). It
// supplies ONLY the Launchpad-specific PLACEMENT (which pad/CC is which control
// on each unit) + the RGB COLOUR LANGUAGE, then defers every clip/edit/length
// DECISION to the shared brain — so the monome + both Launchpads are thin
// adapters over ONE model.
//
// Owner-LOCKED layout (Plan B + Plan C's "matrix never disappears"):
//
//   UNIT L = the clip MATRIX, PERMANENTLY (never flips to the editor):
//     · 8×8 pads: pad (x=slot, y=lane) ↔ clip index lane*8+slot. y is measured
//       from the BOTTOM (programmer-mode 11=bottom-left). Tap = launch/stop the
//       lane via node.data.queued[] (the SAME synced field the card + monome
//       write → multiplayer-synced for free).
//     · right SCENE column (CCs 89..19, top→bottom = rows 7..0) = SCENE LAUNCH:
//       scene button row y fires slot y across ALL lanes.
//
//   UNIT R = the COMMAND DECK (session); FLIPS to the 8-pitch × 8-step NOTE
//   EDITOR while editing (so L keeps the live matrix):
//     SESSION deck:
//       · top row (CC 91..95): ▲ ▼ ◀ ▶ + SHIFT(▣, CC 95). In session these are
//         spare (the editor uses them). CC 96 = TRANSPORT, CC 97 = STOP-ALL.
//       · right scene column (CC 89..19) = per-lane STOP (row y stops lane y).
//       · 8×8 deck pads, by functional COLUMN (x):
//           col 0  = EDIT (hold) — tap a clip on L to edit it
//           col 1  = COPY (hold) / col 2 = PASTE (hold) / col 3 = PASTE-REV (hold)
//           col 4  = COPY-INDICATOR (render-only buffer pulse)
//           col 5  = DOUBLE (tap)
//           col 6  = LENGTH-EDIT (tap → opens the 2-row length page on R)
//           col 7  = NOW/QNT launch-immediate modifier (hold)
//         (deck pads use ROW 0 only as the active control; rows 1..7 of those
//          columns are dark — the deck is intentionally sparse + legible.)
//     EDIT editor (R flips here):
//       · all 8×8 pads = the note grid: X = step over the shown 8-step window
//         (half a 16-step block), Y = pitch (8 in-key rows). y from the BOTTOM,
//         so row 0 = the lowest shown pitch.
//       · top row: ▲/▼ scroll pitch ±1 row, ◀/▶ scroll step ±1; SHIFT (CC 95)
//         held makes ▲▼◀▶ jump a full screen (±8). CC 96 = VEL (hold+tap a pad
//         to cycle velocity), CC 97 = SCALE cycle, CC 98 = FOLLOW toggle.
//       · right scene column: top (row 7) = EXIT; rows 6..0 spare.
//     LENGTH-EDIT page (R, opened by the deck's LEN pad):
//       · row 0 (bottom): end-BLOCK ruler (pads 0..7 → blocks 1..8); pad 7 of
//         row 7 (scene top) = EXIT.  row 1: end-STEP ruler (pads 0..15 don't
//         fit 8 wide → we use rows 1 + 2 for steps 1..8 / 9..16).
//
// RGB COLOUR LANGUAGE: the legend (`legend-colors.svg`). Each state maps to an
// exact RGB triple (0..127, the lighting-SysEx range). State always wins over a
// clip's own tint (Ableton convention). Animation (pulse/flash) is expressed
// here as a blink between two RGB triples on the binding's blink cadence (the
// device only does static RGB in our pipeline; pulse/flash are emulated by the
// render loop swapping triples — same as the monome's brightness blink).

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
  velBucket,
  noteCovering,
} from '$lib/audio/modules/clip-types';
import {
  clipIndexForSlotLane,
  slotLaneForClipIndex,
  editPageCount,
  noteForCell,
  lengthEditAction,
  lengthRulers,
  type LengthEditAction,
} from '../clip-surface-map';
import {
  LP_WIDTH,
  LP_HEIGHT,
  padNote,
  CC_UP,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SESSION,
  CC_TOP_SPARE_6,
  CC_TOP_SPARE_7,
  CC_TOP_SPARE_8,
  SCENE_CCS,
} from './launchpad-sysex';
import { type LaunchpadFrame, emptyFrame } from './launchpad-device.svelte';

export { editPageCount, type LengthEditAction } from '../clip-surface-map';

// ---------------------------------------------------------------------------
// RGB COLOUR LANGUAGE (legend-colors.svg). 0..127 components.
// ---------------------------------------------------------------------------
export type Rgb = readonly [number, number, number];

export const RGB_OFF: Rgb = [0, 0, 0];
// Session clip states.
export const RGB_LOADED: Rgb = [14, 20, 28]; // dim blue (idle, has notes)
export const RGB_PLAYING: Rgb = [23, 104, 53]; // green (playing) — pulses (see blink)
export const RGB_PLAYING_DIM: Rgb = [8, 40, 20]; // the down phase of the playing pulse
export const RGB_QUEUED: Rgb = [23, 104, 53]; // green (queued-launch) — FLASHES on/off
export const RGB_QUEUED_STOP: Rgb = [104, 23, 23]; // red (queued-stop) — flashes on/off
export const RGB_RECORDING: Rgb = [127, 16, 16]; // red (record-armed / recording) — pulses
// Control / function colours.
export const RGB_SCENE: Rgb = [112, 81, 21]; // amber (scene launch)
export const RGB_STOP_IDLE: Rgb = [69, 37, 16]; // dim red (stop lane idle)
export const RGB_STOP_ACTIVE: Rgb = [104, 23, 23]; // bright red (lane playing)
export const RGB_FUNC: Rgb = [60, 60, 70]; // function idle (white-ish)
export const RGB_FUNC_ON: Rgb = [122, 79, 112]; // held modifier (violet, bright)
export const RGB_FUNC_DIM: Rgb = [10, 10, 14]; // a no-op-right-now function pad
export const RGB_TRANSPORT_ON: Rgb = [23, 104, 53]; // green (transport running)
export const RGB_COPY_BUFFER: Rgb = [15, 99, 99]; // turquoise (copy buffer loaded) — pulses
export const RGB_COPY_BUFFER_DIM: Rgb = [4, 30, 30]; // down phase of the copy pulse
export const RGB_EXIT: Rgb = [104, 23, 23]; // red (EXIT)
// Editor note colours (velocity buckets) + playhead.
export const RGB_NOTE_BY_VEL: readonly Rgb[] = [
  [29, 41, 57], // low velocity (dim blue)
  [37, 62, 96], // med
  [63, 91, 127], // high
];
export const RGB_NOTE_PLAYHEAD: Rgb = [127, 105, 29]; // a note under the playhead (yellow boost)
export const RGB_PLAYHEAD_WASH: Rgb = [40, 33, 9]; // the moving playhead column wash (amber, dim)
export const RGB_ROOT_GUIDE: Rgb = [10, 12, 16]; // faint marker on root-pitch-class rows
// LENGTH-EDIT page.
export const RGB_LEN_BLOCK: Rgb = [20, 28, 38]; // a counted block/step (dim)
export const RGB_LEN_END: Rgb = [63, 91, 127]; // the END block/step (bright)

// ---------------------------------------------------------------------------
// UNIT L — the clip matrix placement (PURE classifiers).
// ---------------------------------------------------------------------------

/** L pad (x=slot, y=lane) → flat clip index, or null when out of the matrix. */
export function lPadToClipIndex(x: number, y: number): number | null {
  return clipIndexForSlotLane(x, y); // launchpad L: pad.x = slot, pad.y = lane
}
/** Flat clip index → its (x=slot, y=lane) pad on unit L. */
export function clipIndexToLPad(index: number): { x: number; y: number } {
  const { slot, lane } = slotLaneForClipIndex(index);
  return { x: slot, y: lane };
}
/** An L scene-column row → the slot it launches across all lanes, or null.
 *  Scene row y addresses slot y (rows 0..CLIP_SLOTS-1). */
export function lSceneSlotForRow(row: number): number | null {
  if (row >= 0 && row < CLIP_SLOTS) return row;
  return null;
}

// ---------------------------------------------------------------------------
// UNIT R — SESSION command-deck placement.
// ---------------------------------------------------------------------------
// Deck control columns (the active pad is at ROW 0 of each column).
export const DECK_ROW = 0;
export const DECK_EDIT_COL = 0;
export const DECK_COPY_COL = 1;
export const DECK_PASTE_COL = 2;
export const DECK_PASTE_REV_COL = 3;
export const DECK_COPY_IND_COL = 4;
export const DECK_DOUBLE_COL = 5;
export const DECK_LENGTH_COL = 6;
export const DECK_NOW_COL = 7;

// Top-row CC roles (session deck): the arrows are unused; CC 96/97 = transport
// / stop-all. (CC 95 = SHIFT, reserved across both modes; CC 98 spare.)
export const CC_TRANSPORT = CC_TOP_SPARE_6; // 96
export const CC_STOP_ALL = CC_TOP_SPARE_7; // 97

/** Classify an R session-deck PAD press → a deck action, or null for a dark
 *  pad. Acts only on ROW 0; other rows are dark. */
export type DeckAction =
  | 'edit'
  | 'copy'
  | 'paste'
  | 'pasteRev'
  | 'double'
  | 'lengthEdit'
  | 'now';
export function rDeckPad(x: number, y: number): DeckAction | null {
  if (y !== DECK_ROW) return null;
  switch (x) {
    case DECK_EDIT_COL:
      return 'edit';
    case DECK_COPY_COL:
      return 'copy';
    case DECK_PASTE_COL:
      return 'paste';
    case DECK_PASTE_REV_COL:
      return 'pasteRev';
    case DECK_DOUBLE_COL:
      return 'double';
    case DECK_LENGTH_COL:
      return 'lengthEdit';
    case DECK_NOW_COL:
      return 'now';
    default:
      return null; // DECK_COPY_IND_COL is render-only
  }
}
/** An R scene-column row → the lane it STOPs (per-lane stop), or null. */
export function rStopLaneForRow(row: number): number | null {
  if (row >= 0 && row < CLIP_LANES) return row;
  return null;
}

// ---------------------------------------------------------------------------
// UNIT R — EDIT note-grid placement (8 pitch rows × 8 step columns).
// ---------------------------------------------------------------------------
export const EDIT_ROWS = LP_HEIGHT; // 8 pitch rows (full grid — no function row eaten)
export const EDIT_COLS = LP_WIDTH; // 8 step columns = HALF a 16-step block

/** Editor pitch row (y from BOTTOM, 0 = lowest shown) → logical core row. The
 *  core treats row 0 as the bottom-of-window note, increasing up — which is
 *  exactly the Launchpad's bottom-origin y, so this is the identity (unlike the
 *  monome's top-down flip). */
export function editYToLogicalRow(y: number): number {
  return y;
}

/** An edit-mode pad (x=step-col, y=pitch) → the {step, midi} it edits, or null
 *  for an out-of-grid / past-length cell. `colOffset` scrolls the 8-step window
 *  within the clip (realStep = page*16 + colOffset + x via the core), `page`
 *  selects the 16-step block, `rowOffset` scrolls the pitch window. */
export function editPadToNote(
  clip: NoteClipRecord,
  x: number,
  y: number,
  opts: { rowOffset?: number; colOffset?: number; page?: number } = {},
): { step: number; midi: number } | null {
  if (x < 0 || x >= EDIT_COLS || y < 0 || y >= EDIT_ROWS) return null;
  const colOffset = opts.colOffset ?? 0;
  // The core's noteForCell takes a window COLUMN; we widen the window by
  // colOffset (the 8-step half-block scroll) before handing it the column.
  return noteForCell(clip, colOffset + x, editYToLogicalRow(y), opts.rowOffset ?? 0, opts.page ?? 0);
}

// Editor top-row CC roles.
export const CC_EDIT_ROW_UP = CC_UP; // 91 — pitch +1 (SHIFT: +8)
export const CC_EDIT_ROW_DOWN = CC_DOWN; // 92 — pitch -1 (SHIFT: -8)
export const CC_EDIT_STEP_LEFT = CC_LEFT; // 93 — step -1 (SHIFT: -8)
export const CC_EDIT_STEP_RIGHT = CC_RIGHT; // 94 — step +1 (SHIFT: +8)
export const CC_SHIFT = CC_SESSION; // 95 — magnitude(×8)+scope modifier
export const CC_EDIT_VEL = CC_TOP_SPARE_6; // 96 — hold + tap to cycle velocity
export const CC_EDIT_SCALE = CC_TOP_SPARE_7; // 97 — cycle the clip scale
export const CC_EDIT_FOLLOW = CC_TOP_SPARE_8; // 98 — FOLLOW toggle

// Editor scene-column functions (the full 8×8 is the note grid, so DOUBLE +
// LENGTH-EDIT live on the otherwise-spare right scene column):
//   row 7 (top) = EXIT · row 6 = DOUBLE · row 5 = LENGTH-EDIT.
export const EDIT_EXIT_SCENE_ROW = LP_HEIGHT - 1; // 7
export const EDIT_DOUBLE_SCENE_ROW = LP_HEIGHT - 2; // 6
export const EDIT_LENGTH_SCENE_ROW = LP_HEIGHT - 3; // 5
export function isEditExitSceneRow(row: number): boolean {
  return row === EDIT_EXIT_SCENE_ROW;
}
export type EditSceneAction = 'exit' | 'double' | 'lengthEdit' | null;
export function editSceneAction(row: number): EditSceneAction {
  if (row === EDIT_EXIT_SCENE_ROW) return 'exit';
  if (row === EDIT_DOUBLE_SCENE_ROW) return 'double';
  if (row === EDIT_LENGTH_SCENE_ROW) return 'lengthEdit';
  return null;
}

// ---------------------------------------------------------------------------
// UNIT R — LENGTH-EDIT page placement. Row 0 = end-BLOCK ruler (pads 0..7 →
// blocks 1..8). Rows 1+2 = end-STEP ruler (steps 1..8 on row 1, 9..16 on row
// 2). EXIT = the top scene button (row 7), same as the editor.
// ---------------------------------------------------------------------------
export const LEN_BLOCK_ROW = 0;
export const LEN_STEP_LO_ROW = 1; // steps 1..8
export const LEN_STEP_HI_ROW = 2; // steps 9..16

/** Classify a LENGTH-EDIT pad on unit R → its action, or null. The EXIT is the
 *  top scene button (handled by the scene-row path), so PAD presses are only
 *  block/step here. */
export function rLengthPad(x: number, y: number): LengthEditAction | null {
  if (y === LEN_BLOCK_ROW) {
    // cell 0..MAX_EDIT_PAGES-1 → block 1..N
    return lengthEditAction(0, x, false);
  }
  if (y === LEN_STEP_LO_ROW) {
    return lengthEditAction(1, x, false); // steps 1..8
  }
  if (y === LEN_STEP_HI_ROW) {
    return lengthEditAction(1, x + STEPS_PER_PAGE / 2, false); // steps 9..16
  }
  return null;
}

// ---------------------------------------------------------------------------
// LED FRAMES (PURE) — build a LaunchpadFrame for each unit/mode from the shared
// brain. The render loop in launchpad-control passes the blink phase so pulses /
// flashes animate (the device only does static RGB; animation = swapping
// triples on the blink cadence, exactly like the monome's brightness blink).
// ---------------------------------------------------------------------------

function put(frame: LaunchpadFrame, index: number, rgb: Rgb): void {
  frame.leds.set(index, [rgb[0], rgb[1], rgb[2]]);
}

// ── UNIT L (the clip matrix) ──
export interface LSessionOpts {
  blinkOn?: boolean;
  /** Index of the clip currently in the copy buffer (turquoise), or null. */
  bufferClipIndex?: number | null;
  /** True if this clip-player is record-armed (paints empty pads dim red). */
  recording?: boolean;
}

export function computeLSessionFrame(
  data: ClipPlayerData | undefined,
  opts: LSessionOpts = {},
): LaunchpadFrame {
  const frame = emptyFrame();
  const blinkOn = opts.blinkOn ?? true;
  const clips = data?.clips ?? {};
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const pl = lanePlaying(data, lane);
    const q = laneQueued(data, lane);
    for (let slot = 0; slot < CLIP_SLOTS; slot++) {
      const idx = clipIndex(slot, lane);
      const note = padNote(slot, lane); // x=slot, y=lane
      let rgb: Rgb = RGB_OFF;
      if (pl === slot) {
        // playing: pulse green; if a stop is queued, flash to red.
        rgb = q === 'stop' ? (blinkOn ? RGB_QUEUED_STOP : RGB_OFF) : blinkOn ? RGB_PLAYING : RGB_PLAYING_DIM;
      } else if (q === slot) {
        rgb = blinkOn ? RGB_QUEUED : RGB_OFF; // queued-launch flashes
      } else if (clips[String(idx)]) {
        rgb = opts.bufferClipIndex === idx ? (blinkOn ? RGB_COPY_BUFFER : RGB_COPY_BUFFER_DIM) : RGB_LOADED;
      } else if (opts.recording) {
        rgb = RGB_STOP_IDLE; // record-armed empty slot = dim red (Ableton idiom)
      }
      put(frame, note, rgb);
    }
  }
  // L scene column (CCs 89..19, top→bottom). Each lit amber (idle). SCENE_CCS
  // is top→bottom = rows 7..0; scene row y → slot y, so light rows 0..CLIP_SLOTS-1.
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const row = LP_HEIGHT - 1 - i; // SCENE_CCS[0] = top = row 7
    put(frame, SCENE_CCS[i], row < CLIP_SLOTS ? RGB_SCENE : RGB_OFF);
  }
  return frame;
}

// ── UNIT R (session command deck) ──
export interface RSessionOpts {
  blinkOn?: boolean;
  transportRunning?: boolean;
  editArmed?: boolean;
  copyHeld?: boolean;
  pasteHeld?: boolean;
  pasteRevHeld?: boolean;
  nowHeld?: boolean;
  bufferArmed?: boolean;
  /** Which lanes are playing (lights per-lane STOP active). */
  data?: ClipPlayerData | undefined;
}

export function computeRDeckFrame(opts: RSessionOpts = {}): LaunchpadFrame {
  const frame = emptyFrame();
  const blinkOn = opts.blinkOn ?? true;
  const deck = (col: number, on: boolean) => put(frame, padNote(col, DECK_ROW), on ? RGB_FUNC_ON : RGB_FUNC);
  deck(DECK_EDIT_COL, !!opts.editArmed);
  deck(DECK_COPY_COL, !!opts.copyHeld);
  deck(DECK_PASTE_COL, !!opts.pasteHeld);
  deck(DECK_PASTE_REV_COL, !!opts.pasteRevHeld);
  deck(DECK_NOW_COL, !!opts.nowHeld);
  put(frame, padNote(DECK_DOUBLE_COL, DECK_ROW), RGB_FUNC);
  put(frame, padNote(DECK_LENGTH_COL, DECK_ROW), RGB_FUNC);
  // COPY-INDICATOR — turquoise pulse while the buffer holds a clip.
  put(
    frame,
    padNote(DECK_COPY_IND_COL, DECK_ROW),
    opts.bufferArmed ? (blinkOn ? RGB_COPY_BUFFER : RGB_COPY_BUFFER_DIM) : RGB_OFF,
  );
  // Top-row transport + stop-all.
  put(frame, CC_TRANSPORT, opts.transportRunning ? RGB_TRANSPORT_ON : RGB_STOP_IDLE);
  put(frame, CC_STOP_ALL, RGB_STOP_IDLE);
  // R scene column = per-lane STOP (bright red where a lane plays).
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const row = LP_HEIGHT - 1 - i;
    if (row >= CLIP_LANES) {
      put(frame, SCENE_CCS[i], RGB_OFF);
      continue;
    }
    const playing = lanePlaying(opts.data, row) !== null;
    put(frame, SCENE_CCS[i], playing ? RGB_STOP_ACTIVE : RGB_STOP_IDLE);
  }
  return frame;
}

// ── UNIT R (note editor) ──
export interface REditOpts {
  rowOffset?: number;
  colOffset?: number;
  page?: number;
  /** Live playhead step (-1 when the edited clip isn't playing). */
  playheadStep?: number;
  velArmed?: boolean;
  followOn?: boolean;
  shiftHeld?: boolean;
}

export function computeREditFrame(clip: NoteClipRecord, opts: REditOpts = {}): LaunchpadFrame {
  const frame = emptyFrame();
  const rowOffset = opts.rowOffset ?? 0;
  const colOffset = opts.colOffset ?? 0;
  const page = opts.page ?? 0;
  const playheadStep = opts.playheadStep ?? -1;
  const rootPc = ((clip.root % 12) + 12) % 12;
  for (let y = 0; y < EDIT_ROWS; y++) {
    for (let x = 0; x < EDIT_COLS; x++) {
      const note = editPadToNote(clip, x, y, { rowOffset, colOffset, page });
      const index = padNote(x, y);
      if (!note) {
        put(frame, index, RGB_OFF);
        continue;
      }
      const onPlayhead = note.step === playheadStep;
      const cov = noteCovering(clip, note.step, note.midi);
      if (cov) {
        put(frame, index, onPlayhead ? RGB_NOTE_PLAYHEAD : RGB_NOTE_BY_VEL[velBucket(cov.velocity)]);
      } else if (onPlayhead) {
        put(frame, index, RGB_PLAYHEAD_WASH);
      } else if (((note.midi % 12) + 12) % 12 === rootPc) {
        put(frame, index, RGB_ROOT_GUIDE);
      } else {
        put(frame, index, RGB_OFF);
      }
    }
  }
  // Top-row nav + edit functions.
  const shift = !!opts.shiftHeld;
  put(frame, CC_EDIT_ROW_UP, RGB_FUNC);
  put(frame, CC_EDIT_ROW_DOWN, RGB_FUNC);
  put(frame, CC_EDIT_STEP_LEFT, RGB_FUNC);
  put(frame, CC_EDIT_STEP_RIGHT, RGB_FUNC);
  put(frame, CC_SHIFT, shift ? RGB_FUNC_ON : RGB_FUNC);
  put(frame, CC_EDIT_VEL, opts.velArmed ? RGB_FUNC_ON : RGB_FUNC);
  put(frame, CC_EDIT_SCALE, RGB_FUNC);
  put(frame, CC_EDIT_FOLLOW, opts.followOn ? RGB_TRANSPORT_ON : RGB_FUNC_ON);
  // Scene column: top = EXIT (red), row 6 = DOUBLE, row 5 = LENGTH-EDIT, rest dark.
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const row = LP_HEIGHT - 1 - i;
    let rgb: Rgb = RGB_OFF;
    if (row === EDIT_EXIT_SCENE_ROW) rgb = RGB_EXIT;
    else if (row === EDIT_DOUBLE_SCENE_ROW || row === EDIT_LENGTH_SCENE_ROW) rgb = RGB_FUNC;
    put(frame, SCENE_CCS[i], rgb);
  }
  return frame;
}

// ── UNIT R (length-edit page) ──
export function computeRLengthFrame(clip: NoteClipRecord): LaunchpadFrame {
  const frame = emptyFrame();
  const { endBlock, endStep } = lengthRulers(clip);
  // Row 0: end-BLOCK ruler (pads 0..MAX_EDIT_PAGES-1 → blocks 1..N).
  for (let x = 0; x < LP_WIDTH; x++) {
    const cell = x + 1;
    let rgb: Rgb = RGB_OFF;
    if (x < MAX_EDIT_PAGES) rgb = cell < endBlock ? RGB_LEN_BLOCK : cell === endBlock ? RGB_LEN_END : RGB_OFF;
    put(frame, padNote(x, LEN_BLOCK_ROW), rgb);
  }
  // Rows 1+2: end-STEP ruler (steps 1..8 on row 1, 9..16 on row 2).
  for (let x = 0; x < LP_WIDTH; x++) {
    const lo = x + 1; // step 1..8
    put(
      frame,
      padNote(x, LEN_STEP_LO_ROW),
      lo < endStep ? RGB_LEN_BLOCK : lo === endStep ? RGB_LEN_END : RGB_OFF,
    );
    const hi = x + 1 + STEPS_PER_PAGE / 2; // step 9..16
    put(
      frame,
      padNote(x, LEN_STEP_HI_ROW),
      hi < endStep ? RGB_LEN_BLOCK : hi === endStep ? RGB_LEN_END : RGB_OFF,
    );
  }
  // EXIT (top scene button).
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const row = LP_HEIGHT - 1 - i;
    put(frame, SCENE_CCS[i], row === EDIT_EXIT_SCENE_ROW ? RGB_EXIT : RGB_OFF);
  }
  return frame;
}
