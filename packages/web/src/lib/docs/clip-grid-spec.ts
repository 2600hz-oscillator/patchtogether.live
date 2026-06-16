// clip-grid-spec.ts — docs data for the clip-launcher GridDiagram(s).
//
// The diagrams are a pure function of the REAL grid layout constants
// (grid-clip-map + mext), so they can never drift from what the binding
// actually does. Two views: SESSION (launch clips) and EDIT (note editor).

import { GRID_WIDTH, GRID_HEIGHT } from '$lib/grid/mext';
import { CLIP_SLOTS, CLIP_LANES } from '$lib/audio/modules/clip-types';
import {
  CTRL_STOP_COL,
  CTRL_SCENE_COL,
  EDIT_PAD,
  STOPALL_PAD,
  TRANSPORT_PAD,
  EDIT_EXIT_PAD,
  VEL_PAD,
  ROW_DOWN_PAD,
  OCT_DOWN_PAD,
  ROW_UP_PAD,
  OCT_UP_PAD,
  SCALE_PAD,
  NOTE_ROWS,
  FUNC_ROW,
} from '$lib/grid/grid-clip-map';
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

export interface GridSpec {
  cols: number;
  rows: number;
  cells: GridCell[];
  callouts: GridCallout[];
  sideLabels?: GridSideLabel[];
  caption: string;
}

/** SESSION view: cols 0..7 = clip slots, rows 0..7 = instrument lanes;
 *  col 8 = per-lane STOP, col 9 = SCENE launch; col 15 = EDIT / STOP-ALL /
 *  TRANSPORT. (Cols 10..14 are unused in session.) */
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
  cells.push({ x: STOPALL_PAD.x, y: STOPALL_PAD.y, fill: STOPALL });
  cells.push({ x: TRANSPORT_PAD.x, y: TRANSPORT_PAD.y, fill: XPORT });

  const callouts: GridCallout[] = [
    { label: 'CLIPS — 8 lanes × 8 slots', fromCol: 0, toCol: CLIP_SLOTS - 1 },
    { label: 'STOP', fromCol: CTRL_STOP_COL },
    { label: 'SCENE', fromCol: CTRL_SCENE_COL },
  ];
  // The three right-column controls are STACKED in col 15 (different rows), so
  // a below-column callout can't disambiguate them — point at each pad instead.
  const sideLabels: GridSideLabel[] = [
    { label: 'EDIT (hold)', atX: EDIT_PAD.x, atY: EDIT_PAD.y },
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
      'Right column: hold EDIT (top), STOP-ALL, TRANSPORT (bottom). Col 8 stops a lane; col 9 launches a whole scene.',
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
  for (const p of [EDIT_EXIT_PAD, VEL_PAD, ROW_DOWN_PAD, OCT_DOWN_PAD, ROW_UP_PAD, OCT_UP_PAD, SCALE_PAD])
    cells.push({ x: p.x, y: p.y, fill: FUNC });

  const callouts: GridCallout[] = [
    { label: 'EXIT', fromCol: EDIT_EXIT_PAD.x },
    { label: 'VEL', fromCol: VEL_PAD.x },
    { label: 'ROW−', fromCol: ROW_DOWN_PAD.x },
    { label: 'OCT−', fromCol: OCT_DOWN_PAD.x },
    { label: 'ROW+', fromCol: ROW_UP_PAD.x },
    { label: 'OCT+', fromCol: OCT_UP_PAD.x },
    { label: 'SCALE', fromCol: SCALE_PAD.x },
  ];
  return {
    cols: GRID_WIDTH,
    rows: GRID_HEIGHT,
    cells,
    callouts,
    caption:
      'Edit view (hold EDIT + tap a clip) — top 7 rows are in-key pitch × step columns; ' +
      'tap to toggle a note, hold + tap to tie. Bottom function row shifts the pitch window (ROW/OCT), cycles VELocity & SCALE, or EXITs.',
  };
}
