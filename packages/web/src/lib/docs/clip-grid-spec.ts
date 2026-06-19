// clip-grid-spec.ts — docs data for the clip-launcher GridDiagram(s).
//
// The diagrams are a pure function of the REAL grid layout constants
// (grid-clip-map + mext), so they can never drift from what the binding
// actually does. Two views: SESSION (launch clips) and EDIT (note editor).

import { GRID_WIDTH, GRID_HEIGHT } from '$lib/control/monome/mext';
import {
  CLIP_SLOTS,
  CLIP_LANES,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
} from '$lib/audio/modules/clip-types';
import {
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
  ROW_DOWN_PAD,
  OCT_DOWN_PAD,
  ROW_UP_PAD,
  OCT_UP_PAD,
  SCALE_PAD,
  FOLLOW_PAD,
  PAGE_LEFT_PAD,
  PAGE_RIGHT_PAD,
  DOUBLE_PAD,
  LENGTH_EDIT_PAD,
  NOTE_ROWS,
  FUNC_ROW,
} from '$lib/control/monome/monome-map';
import type { GridCell, GridCallout, GridSideLabel } from './grid-diagram-types';

// shared palette (muted, doc-friendly)
const CLIP = '#374a6b'; // a loaded clip pad
const PLAYING = '#2f7d52'; // green = currently playing
const STOP = '#5e3636';
const SCENE = '#5e4f2e';
const EDIT = '#7a5a1f'; // amber
const XPORT = '#2f7d52'; // green
const STOPALL = '#7a2f2f'; // red
const NOTE = '#374a6b';
const HELD = '#4a7dc0'; // a lit note in the editor
const FUNC = '#444853'; // a function pad
const COPY = '#3f5e4a'; // copy/paste modifier (teal-green)
const COPY_IND = '#2f7d52'; // the copy-buffer indicator (green)
const LEN_BLOCK = '#3a4a6b'; // a counted length block (blue)
const LEN_END = '#4a7dc0'; // the end block / end step (bright blue)

export interface GridSpec {
  cols: number;
  rows: number;
  cells: GridCell[];
  callouts: GridCallout[];
  sideLabels?: GridSideLabel[];
  caption: string;
}

/** SESSION view: cols 0..7 = clip slots, rows 0..7 = instrument lanes;
 *  col 8 = per-lane STOP, col 9 = SCENE launch; col 15 (top→bottom) = EDIT ·
 *  COPY · COPY-IND · PASTE · PASTE-REV · STOP-ALL · TRANSPORT. */
export function clipSessionGrid(): GridSpec {
  const cells: GridCell[] = [];
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    for (let slot = 0; slot < CLIP_SLOTS; slot++) {
      // illustrate one playing clip per a couple of lanes
      const playing = (lane === 1 && slot === 2) || (lane === 4 && slot === 0);
      cells.push({ x: slot, y: lane, fill: playing ? PLAYING : CLIP });
    }
    cells.push({ x: CTRL_STOP_COL, y: lane, fill: STOP });
  }
  for (let slot = 0; slot < CLIP_SLOTS; slot++) cells.push({ x: CTRL_SCENE_COL, y: slot, fill: SCENE });
  cells.push({ x: EDIT_PAD.x, y: EDIT_PAD.y, fill: EDIT });
  cells.push({ x: COPY_PAD.x, y: COPY_PAD.y, fill: COPY });
  cells.push({ x: COPY_IND_PAD.x, y: COPY_IND_PAD.y, fill: COPY_IND });
  cells.push({ x: PASTE_PAD.x, y: PASTE_PAD.y, fill: COPY });
  cells.push({ x: PASTE_REV_PAD.x, y: PASTE_REV_PAD.y, fill: COPY });
  cells.push({ x: STOPALL_PAD.x, y: STOPALL_PAD.y, fill: STOPALL });
  cells.push({ x: TRANSPORT_PAD.x, y: TRANSPORT_PAD.y, fill: XPORT });

  const callouts: GridCallout[] = [
    { label: 'CLIPS — 8 lanes × 8 slots', fromCol: 0, toCol: CLIP_SLOTS - 1 },
    { label: 'STOP', fromCol: CTRL_STOP_COL },
    { label: 'SCENE', fromCol: CTRL_SCENE_COL },
  ];
  // The right-column controls are STACKED in col 15 (different rows), so a
  // below-column callout can't disambiguate them — point at each pad instead.
  const sideLabels: GridSideLabel[] = [
    { label: 'EDIT (hold)', atX: EDIT_PAD.x, atY: EDIT_PAD.y },
    { label: 'COPY (hold)', atX: COPY_PAD.x, atY: COPY_PAD.y },
    { label: 'buffer', atX: COPY_IND_PAD.x, atY: COPY_IND_PAD.y },
    { label: 'PASTE (hold)', atX: PASTE_PAD.x, atY: PASTE_PAD.y },
    { label: 'PASTE↺ (hold)', atX: PASTE_REV_PAD.x, atY: PASTE_REV_PAD.y },
    { label: 'STOP ALL', atX: STOPALL_PAD.x, atY: STOPALL_PAD.y },
    { label: 'TRANSPORT ▶', atX: TRANSPORT_PAD.x, atY: TRANSPORT_PAD.y },
  ];
  return {
    cols: GRID_WIDTH,
    rows: GRID_HEIGHT,
    cells,
    callouts,
    sideLabels,
    caption:
      'Session view — press a clip pad to launch it in its lane (green = playing). ' +
      'Col 8 stops a lane; col 9 launches a whole scene. Right column (held modifiers): ' +
      'hold COPY + tap a clip to grab it (the buffer indicator pulses), then hold PASTE (or PASTE↺ for a reversed copy) + tap a destination to drop it in.',
  };
}

/** EDIT view: rows 0..6 = in-key pitch rows, columns = clip steps; the bottom
 *  FUNCTION row holds the editor controls. */
export function clipEditGrid(): GridSpec {
  const cells: GridCell[] = [];
  for (let row = 0; row < NOTE_ROWS; row++) {
    for (let step = 0; step < GRID_WIDTH; step++) {
      // illustrate a little melody
      const lit = (step === 0 && row === 2) || (step === 4 && row === 4) || (step === 9 && row === 1);
      cells.push({ x: step, y: row, fill: lit ? HELD : NOTE });
    }
  }
  // function row
  for (let x = 0; x < GRID_WIDTH; x++) cells.push({ x, y: FUNC_ROW, fill: '#23252b' });
  for (const p of [
    EDIT_EXIT_PAD, VEL_PAD, ROW_DOWN_PAD, OCT_DOWN_PAD, ROW_UP_PAD, OCT_UP_PAD, SCALE_PAD,
    FOLLOW_PAD, PAGE_LEFT_PAD, PAGE_RIGHT_PAD, DOUBLE_PAD, LENGTH_EDIT_PAD,
  ])
    cells.push({ x: p.x, y: p.y, fill: FUNC });

  const callouts: GridCallout[] = [
    { label: 'EXIT', fromCol: EDIT_EXIT_PAD.x },
    { label: 'VEL', fromCol: VEL_PAD.x },
    { label: 'ROW−', fromCol: ROW_DOWN_PAD.x },
    { label: 'OCT−', fromCol: OCT_DOWN_PAD.x },
    { label: 'ROW+', fromCol: ROW_UP_PAD.x },
    { label: 'OCT+', fromCol: OCT_UP_PAD.x },
    { label: 'SCALE', fromCol: SCALE_PAD.x },
    { label: 'FOLLOW', fromCol: FOLLOW_PAD.x },
    { label: '◀', fromCol: PAGE_LEFT_PAD.x },
    { label: '▶', fromCol: PAGE_RIGHT_PAD.x },
    { label: 'x2', fromCol: DOUBLE_PAD.x },
    { label: 'LEN', fromCol: LENGTH_EDIT_PAD.x },
  ];
  return {
    cols: GRID_WIDTH,
    rows: GRID_HEIGHT,
    cells,
    callouts,
    caption:
      'Edit view (hold EDIT + tap a clip) — top 7 rows are in-key pitch × step columns; ' +
      'tap to toggle a note, hold + tap to tie. A pattern spans up to 8 pages of 16 steps: ' +
      'FOLLOW auto-scrolls the shown page with the playhead — tap it to FREEZE and page with ◀/▶. ' +
      'x2 DOUBLEs the clip (dups the first half); LEN opens the length editor. ' +
      'The function row also shifts the pitch window (ROW/OCT), cycles VELocity & SCALE, or EXITs.',
  };
}

/** LENGTH-EDIT page: a 2-row length editor. ROW 0 (pads 0..7) = which 16-step
 *  BLOCK the pattern ends in (pad 15 = EXIT); ROW 1 (pads 0..15) = which step in
 *  that block is the last. Rows 2..7 are reserved. Shown for an example L. */
export function clipLengthEditGrid(exampleLength = 48): GridSpec {
  const L = Math.max(1, exampleLength);
  const endBlock = Math.ceil(L / STEPS_PER_PAGE); // 1-based
  const endStep = L - (endBlock - 1) * STEPS_PER_PAGE; // 1-based
  const cells: GridCell[] = [];
  // dim every pad first, then light the two rulers + EXIT.
  for (let y = 0; y < GRID_HEIGHT; y++)
    for (let x = 0; x < GRID_WIDTH; x++) cells.push({ x, y, fill: '#23252b' });
  const set = (x: number, y: number, fill: string) => {
    const c = cells.find((cc) => cc.x === x && cc.y === y);
    if (c) c.fill = fill;
  };
  // ROW 0 — the block ruler.
  for (let x = 0; x < MAX_EDIT_PAGES; x++) {
    const cell = x + 1;
    if (cell < endBlock) set(x, 0, LEN_BLOCK);
    else if (cell === endBlock) set(x, 0, LEN_END);
  }
  set(GRID_WIDTH - 1, 0, EDIT); // EXIT
  // ROW 1 — the step-within-end-block ruler.
  for (let x = 0; x < STEPS_PER_PAGE; x++) {
    const cell = x + 1;
    if (cell < endStep) set(x, 1, LEN_BLOCK);
    else if (cell === endStep) set(x, 1, LEN_END);
  }
  const callouts: GridCallout[] = [
    { label: 'END BLOCK (×16 steps)', fromCol: 0, toCol: MAX_EDIT_PAGES - 1 },
  ];
  const sideLabels: GridSideLabel[] = [
    { label: 'EXIT', atX: GRID_WIDTH - 1, atY: 0 },
    { label: 'END STEP', atX: STEPS_PER_PAGE - 1, atY: 1 },
  ];
  return {
    cols: GRID_WIDTH,
    rows: GRID_HEIGHT,
    cells,
    callouts,
    sideLabels,
    caption:
      'Length editor (the LEN pad) — ROW 0 picks the 16-step BLOCK the pattern ends in ' +
      '(tap block C → length C×16; pad 15 = EXIT); ROW 1 trims to the exact last STEP within ' +
      'that block (so 113 = block 8, then step 1). Length is non-destructive — notes past the ' +
      'new end stop playing but are kept and return when you lengthen again.',
  };
}
