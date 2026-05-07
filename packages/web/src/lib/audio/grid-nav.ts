// packages/web/src/lib/audio/grid-nav.ts
//
// Pure 2D-grid focus resolver shared by SequencerCard + CartesianCard.
//
// Each cell has two focusable controls: a gate button on top and a pitch input
// below. The arrow keys move between conceptual "rows":
//   row 0: gate of column 0 cells
//   row 1: pitch of column 0 cells
//   row 2: gate of column 1 cells
//   ...
// — i.e. for a grid that's `cols` wide and `cellRows` tall, the conceptual
// keyboard grid is `cellRows * 2` rows by `cols` columns.
//
// Up/Down moves to the same column, prev/next conceptual row (clamped at
// edges; no wrap). Left/Right moves within the same conceptual row, prev/next
// column (clamped). Tab honors browser semantics; this resolver only handles
// the four arrow keys.

export type CellRole = 'pitch' | 'gate';

export interface GridSpec {
  /** Number of columns in the cell grid. Sequencer uses 16 (or 32 for the
   *  longest case); Cartesian uses 4. */
  cols: number;
  /** Number of cell rows. Sequencer is 1 (linear). Cartesian is 4. */
  cellRows: number;
}

export interface FocusPos {
  /** Cell index in row-major order. 0 .. cols*cellRows - 1. */
  index: number;
  role: CellRole;
}

/** Convert a focus position to its conceptual (row, col) coordinate. */
export function focusToCoord(
  pos: FocusPos,
  spec: GridSpec,
): { row: number; col: number } {
  const cellRow = Math.floor(pos.index / spec.cols);
  const col = pos.index % spec.cols;
  // gate=top (row=0), pitch=bottom (row=1) within each cell pair.
  const row = cellRow * 2 + (pos.role === 'gate' ? 0 : 1);
  return { row, col };
}

/** Inverse of focusToCoord. Returns null if (row, col) is out of bounds. */
export function coordToFocus(
  row: number,
  col: number,
  spec: GridSpec,
): FocusPos | null {
  const totalRows = spec.cellRows * 2;
  if (row < 0 || row >= totalRows) return null;
  if (col < 0 || col >= spec.cols) return null;
  const cellRow = Math.floor(row / 2);
  const role: CellRole = row % 2 === 0 ? 'gate' : 'pitch';
  const index = cellRow * spec.cols + col;
  return { index, role };
}

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/** Resolve the next focus position for an arrow key. Returns null if the
 *  edge of the grid is reached (caller should leave focus where it is). */
export function resolveArrowNav(
  pos: FocusPos,
  key: ArrowKey,
  spec: GridSpec,
): FocusPos | null {
  const { row, col } = focusToCoord(pos, spec);
  let nextRow = row;
  let nextCol = col;
  if (key === 'ArrowUp') nextRow = row - 1;
  else if (key === 'ArrowDown') nextRow = row + 1;
  else if (key === 'ArrowLeft') nextCol = col - 1;
  else if (key === 'ArrowRight') nextCol = col + 1;
  return coordToFocus(nextRow, nextCol, spec);
}
