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
  noteCovering,
  velBucket,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
  lengthEndBlock,
  lengthEndStep,
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
// COPY / PASTE / PASTE-REV held-modifier pads + the copy-buffer indicator.
export const LED_MOD_IDLE = 4; // a held-modifier pad at rest
export const LED_MOD_ON = 15; // a held-modifier pad while held
// COPY-INDICATOR pulse ramp (med→high→med→low), indexed off the blink cadence.
export const LED_COPY_IND_PULSE: readonly number[] = [8, 13, 8, 3];

// --- Edit-mode LED levels ---
// A note is lit by its velocity COLOUR — 3 distinguishable note brightnesses
// (low/med/high), TWO of the 6 velocity levels per colour (velBucket). Empty is
// the only dark cell, so a placed note (even 0%) always shows a colour. That's
// the grid's "4 colours, 1 dark" reality. The playhead column washes empties +
// boosts the note it crosses to full. The bottom FUNCTION ROW holds controls.
export const LED_NOTE_BRIGHTNESS: readonly number[] = [5, 10, 15]; // low / med / high
export const LED_NOTE_PLAYHEAD = 15; // a note the playhead is currently over
export const LED_PLAYHEAD = 6; // wash on the current-step column (the pulse)
export const LED_ROOT_GUIDE = 1; // faint marker on root-pitch-class rows
export const LED_FUNC = 5; // a function-row pad (idle)
export const LED_FUNC_ON = 15; // a held function-row pad (e.g. VEL armed)
export const LED_FUNC_DIM = 2; // a function pad that is a no-op right now (dim)
export const LED_FUNC_FLASH = 12; // a flashing function pad (FOLLOW frozen)

// --- LENGTH-EDIT page LED levels (the 2-row length editor) ---
export const LED_LEN_BLOCK = 6; // a counted 16-step block (cells 1..endBlock−1)
export const LED_LEN_END = 15; // the END block / END step (bright)
export const LED_LEN_EXIT = 5; // the EXIT pad (row 0, cell 16)

// --- Edit-mode geometry: 7 note rows (0..6) + a bottom FUNCTION ROW (7) ---
export const NOTE_ROWS = GRID_HEIGHT - 1; // 7 pitch rows (= 1 in-key octave)
export const FUNC_ROW = GRID_HEIGHT - 1; // row 7 = controls
// Function-row layout (DECIDED 2026-06-16) with spacer gaps for legibility:
//   [EDIT] [VEL] _ [ROW−] [OCT−] _ [ROW+] [OCT+] _ [SCALE] _ [FOLLOW] [LEFT] [RIGHT] [DOUBLE] [LEN]
// x=2,5,8,10 are intentionally blank. ROW±1 shift the pitch window by a single
// scale-degree row; OCT± shift by a whole octave (scaleLen rows). Pages 12..15
// add the multi-page navigation + length cluster.
export const EDIT_EXIT_PAD = { x: 0, y: FUNC_ROW } as const; // tap → leave the editor
export const VEL_PAD = { x: 1, y: FUNC_ROW } as const; // hold + tap a note → cycle velocity
export const ROW_DOWN_PAD = { x: 3, y: FUNC_ROW } as const; // shift the pitch window down 1 row
export const OCT_DOWN_PAD = { x: 4, y: FUNC_ROW } as const; // shift the pitch window down 1 octave
export const ROW_UP_PAD = { x: 6, y: FUNC_ROW } as const; // shift the pitch window up 1 row
export const OCT_UP_PAD = { x: 7, y: FUNC_ROW } as const; // shift the pitch window up 1 octave
export const SCALE_PAD = { x: 9, y: FUNC_ROW } as const; // cycle the clip's scale (major→…→chromatic)
export const FOLLOW_PAD = { x: 11, y: FUNC_ROW } as const; // tap-toggle auto-scroll the shown page
export const PAGE_LEFT_PAD = { x: 12, y: FUNC_ROW } as const; // page left (only when frozen)
export const PAGE_RIGHT_PAD = { x: 13, y: FUNC_ROW } as const; // page right (only when frozen)
export const DOUBLE_PAD = { x: 14, y: FUNC_ROW } as const; // double the clip length (dup first half)
export const LENGTH_EDIT_PAD = { x: 15, y: FUNC_ROW } as const; // open the LENGTH-EDIT page

// --- Session-mode control-pad coordinates ---
// Right column (col 15), top→bottom: EDIT(0) · _(1) · COPY(2) · COPY-IND(3) ·
// PASTE(4) · PASTE-REV(5) · STOP-ALL(6) · TRANSPORT(7).
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

/** Display row y (0 = top, NOTE_ROWS-1 = bottom note row) → MIDI for a clip.
 *  `rowOffset` scrolls the pitch window by whole scale-degree ROWS (ROW± shift
 *  by 1, OCT± by scaleLen) so single-row scrolling falls out for free. */
export function editRowToMidi(clip: NoteClipRecord, y: number, rowOffset = 0): number {
  const logicalRow = rowOffset + (NOTE_ROWS - 1 - y);
  return rowToMidi(logicalRow, clip.root, clip.scale);
}

/** Number of 16-step pages a clip spans (1..MAX_EDIT_PAGES). */
export function editPageCount(clip: NoteClipRecord): number {
  return Math.max(1, Math.min(MAX_EDIT_PAGES, Math.ceil(clip.lengthSteps / STEPS_PER_PAGE)));
}

/**
 * An edit-mode pad (x,y) → the {step, midi} it edits, or null when it's in the
 * function row, or a step beyond the clip's length. `page` (0-based, default 0)
 * selects which 16-step window the columns map to: realStep = page*16 + x. A pad
 * whose realStep ≥ lengthSteps is null (beyond the clip).
 */
export function editPadToNote(
  clip: NoteClipRecord,
  x: number,
  y: number,
  rowOffset = 0,
  page = 0,
): { step: number; midi: number } | null {
  if (x < 0 || x >= GRID_WIDTH || y < 0 || y >= NOTE_ROWS) return null; // func row / oob
  const realStep = page * STEPS_PER_PAGE + x;
  if (realStep >= clip.lengthSteps) return null; // beyond the clip
  return { step: realStep, midi: editRowToMidi(clip, y, rowOffset) };
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
// LENGTH-EDIT page mapping (PURE) — the 2-row length editor.
//   ROW 0, pads 0..7   = the 16-step BLOCK the pattern ends in (1-based cells).
//   ROW 0, pad 15      = EXIT (back to the clip editor).
//   ROW 1, pads 0..15  = the STEP within the end block that is last (1-based).
// Returns a tagged action for a pressed pad (null = a no-op / unused pad).
// ---------------------------------------------------------------------------
export type LengthEditAction =
  | { kind: 'exit' }
  | { kind: 'block'; block: number } // 1-based 16-step block
  | { kind: 'step'; step: number }; // 1-based step within the end block

export function isLengthEditExitPad(x: number, y: number): boolean {
  return y === 0 && x === GRID_WIDTH - 1;
}
/** Classify a LENGTH-EDIT pad press → its action, or null for an unused pad. */
export function lengthEditPad(x: number, y: number): LengthEditAction | null {
  if (isLengthEditExitPad(x, y)) return { kind: 'exit' };
  if (y === 0 && x >= 0 && x < MAX_EDIT_PAGES) return { kind: 'block', block: x + 1 };
  if (y === 1 && x >= 0 && x < STEPS_PER_PAGE) return { kind: 'step', step: x + 1 };
  return null;
}

// ---------------------------------------------------------------------------
// LED frames (PURE)
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
  /** Free-running blink phase (= floor(tickCount/BLINK_TICKS)); the copy-indicator
   *  pulse ramp is indexed off it so it animates without extra state. */
  blinkPhase?: number;
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
  // COPY / PASTE / PASTE-REV held-modifier pads (bright while held).
  frame[frameIndex(COPY_PAD.x, COPY_PAD.y)] = opts.copyHeld ? LED_MOD_ON : LED_MOD_IDLE;
  frame[frameIndex(PASTE_PAD.x, PASTE_PAD.y)] = opts.pasteHeld ? LED_MOD_ON : LED_MOD_IDLE;
  frame[frameIndex(PASTE_REV_PAD.x, PASTE_REV_PAD.y)] = opts.pasteRevHeld ? LED_MOD_ON : LED_MOD_IDLE;
  // COPY-INDICATOR — pulses med→high→med→low while the buffer is armed, else dark.
  frame[frameIndex(COPY_IND_PAD.x, COPY_IND_PAD.y)] = opts.bufferArmed
    ? LED_COPY_IND_PULSE[((opts.blinkPhase ?? 0) % LED_COPY_IND_PULSE.length + LED_COPY_IND_PULSE.length) % LED_COPY_IND_PULSE.length]
    : LED_EMPTY;
  frame[frameIndex(STOPALL_PAD.x, STOPALL_PAD.y)] = anyPlaying ? LED_STOP_ACTIVE : LED_STOP_IDLE;
  frame[frameIndex(TRANSPORT_PAD.x, TRANSPORT_PAD.y)] = opts.transportRunning
    ? LED_TRANSPORT_ON
    : LED_STOP_IDLE;
  return frame;
}

export interface EditLedOpts {
  /** Pitch-window scroll offset (ROW±/OCT±). */
  rowOffset?: number;
  /** VEL function pad held → light it bright. */
  velArmed?: boolean;
  /** Whether FOLLOW (auto-scroll the shown page) is on. Default true. When on,
   *  the shown page tracks the playhead and LEFT/RIGHT are no-ops (render dim);
   *  when frozen, the FOLLOW pad flashes and LEFT/RIGHT light per range. */
  followOn?: boolean;
  /** The frozen page to show when !followOn (0-based). Ignored while following. */
  editPage?: number;
}

/**
 * Full 128-cell EDIT-mode LED frame for one clip. Note rows (0..NOTE_ROWS-1):
 * a note lights its WHOLE held span by velocity COLOUR (3 brightnesses, 2 levels
 * each; the playhead column — drawn ONLY when its page is the shown page — boosts
 * the note it crosses to full and washes empties). Bottom FUNCTION ROW (with
 * spacer gaps): EDIT (exit), VEL, ROW−, OCT−, ROW+, OCT+, SCALE, FOLLOW, LEFT,
 * RIGHT, DOUBLE, LENGTH-EDIT.
 *
 * `playheadStep` is the clip's GLOBAL step (-1 = not playing). The shown page is
 * `followOn ? floor(playhead/16) : editPage` (page 0 when not playing/following).
 * The playhead column is drawn only when floor(playhead/16) === shownPage.
 */
export function computeEditLeds(
  clip: NoteClipRecord,
  playheadStep: number,
  rowOffsetOrOpts: number | EditLedOpts = 0,
  velArmedArg = false,
): Uint8Array {
  // Back-compat: the old (rowOffset, velArmed) positional form is still accepted.
  const opts: EditLedOpts =
    typeof rowOffsetOrOpts === 'number'
      ? { rowOffset: rowOffsetOrOpts, velArmed: velArmedArg }
      : rowOffsetOrOpts;
  const rowOffset = opts.rowOffset ?? 0;
  const velArmed = opts.velArmed ?? false;
  const followOn = opts.followOn ?? true;
  const pageCount = editPageCount(clip);
  const playheadPage = playheadStep >= 0 ? Math.floor(playheadStep / STEPS_PER_PAGE) : -1;
  let shownPage = followOn
    ? playheadStep >= 0
      ? playheadPage
      : 0
    : Math.max(0, Math.min(pageCount - 1, opts.editPage ?? 0));

  const frame = new Uint8Array(GRID_CELLS);
  const rootPc = ((clip.root % 12) + 12) % 12;
  // The playhead column is shown only when the playing page IS the shown page.
  const localPlayheadX = playheadPage === shownPage ? playheadStep - shownPage * STEPS_PER_PAGE : -1;
  for (let y = 0; y < NOTE_ROWS; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const fi = frameIndex(x, y);
      const note = editPadToNote(clip, x, y, rowOffset, shownPage);
      if (!note) {
        frame[fi] = LED_EMPTY;
        continue;
      }
      const onPlayhead = x === localPlayheadX;
      const cov = noteCovering(clip, note.step, note.midi);
      if (cov) {
        frame[fi] = onPlayhead ? LED_NOTE_PLAYHEAD : LED_NOTE_BRIGHTNESS[velBucket(cov.velocity)];
        continue;
      }
      let base = LED_EMPTY;
      if (onPlayhead) base = LED_PLAYHEAD; // the moving pulse column
      if (((note.midi % 12) + 12) % 12 === rootPc) base = Math.max(base, LED_ROOT_GUIDE);
      frame[fi] = base;
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
  // FOLLOW: steady-lit while following; FLASHES (med) while frozen.
  frame[frameIndex(FOLLOW_PAD.x, FOLLOW_PAD.y)] = followOn ? LED_FUNC_ON : LED_FUNC_FLASH;
  // LEFT/RIGHT: dim no-op while following or at the edge; lit when actionable.
  const canLeft = !followOn && shownPage > 0;
  const canRight = !followOn && shownPage < pageCount - 1;
  frame[frameIndex(PAGE_LEFT_PAD.x, PAGE_LEFT_PAD.y)] = canLeft ? LED_FUNC : LED_FUNC_DIM;
  frame[frameIndex(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y)] = canRight ? LED_FUNC : LED_FUNC_DIM;
  frame[frameIndex(DOUBLE_PAD.x, DOUBLE_PAD.y)] = LED_FUNC;
  frame[frameIndex(LENGTH_EDIT_PAD.x, LENGTH_EDIT_PAD.y)] = LED_FUNC;
  return frame;
}

/**
 * Full 128-cell LENGTH-EDIT page LED frame. ROW 0 pads 0..7 = the 16-step
 * BLOCKS: cells 1..endBlock−1 LOW, cell endBlock BRIGHT, cells after off; pad 15
 * = EXIT. ROW 1 pads 0..15 = the STEP within the end block: cells 1..endStep−1
 * LOW, cell endStep BRIGHT, after off. Rows 2..7 are reserved (dark).
 */
export function computeLengthEditLeds(clip: NoteClipRecord): Uint8Array {
  const frame = new Uint8Array(GRID_CELLS);
  const L = Math.max(1, clip.lengthSteps);
  const endBlock = lengthEndBlock(L); // 1..MAX_EDIT_PAGES
  const endStep = lengthEndStep(L); // 1..STEPS_PER_PAGE
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
