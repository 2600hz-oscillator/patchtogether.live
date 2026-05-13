// packages/web/src/lib/audio/grid-nav.ts
//
// Pure 2D-grid focus resolver shared by sequencer-family cards
// (SequencerCard, CartesianCard, DrumseqzCard, PolyseqzCard).
//
// Each cell has one or more vertically stacked focusable controls ("roles").
// The roles within a cell form consecutive conceptual rows; cells then stack
// vertically by cellRows. For a grid that's `cols` wide, `cellRows` tall,
// with R roles per cell, the conceptual keyboard grid is `cellRows * R` rows
// by `cols` columns.
//
// Sequencer / Cartesian / DRUMSEQZ use the legacy 2-role pair
// ['gate', 'pitch'] (gate on top, pitch below). POLYSEQZ uses 5 roles:
// ['gate', 'pitch', 'quality', 'inversion', 'voicing'] — matching its
// per-step vertical layout.
//
// Up/Down moves to the same column, prev/next conceptual row (clamped at
// edges; no wrap). Left/Right moves within the same conceptual row, prev/next
// column (clamped). Tab honors browser semantics; this resolver only handles
// the four arrow keys.

/** Legacy 2-role alias. New callers can use any string keys via the generic
 *  GridSpec/FocusPos parameters. */
export type CellRole = 'pitch' | 'gate';

const DEFAULT_ROLES = ['gate', 'pitch'] as const;

export interface GridSpec<R extends string = CellRole> {
  /** Number of columns in the cell grid. */
  cols: number;
  /** Number of cell rows (vertically stacked cells). */
  cellRows: number;
  /** Per-cell role stack, top→bottom. Defaults to ['gate', 'pitch'] when
   *  omitted, preserving the original 2-role behavior. */
  roles?: readonly R[];
}

export interface FocusPos<R extends string = CellRole> {
  /** Cell index in row-major order. 0 .. cols*cellRows - 1. */
  index: number;
  role: R;
}

function rolesOf<R extends string>(spec: GridSpec<R>): readonly R[] {
  return (spec.roles ?? (DEFAULT_ROLES as readonly string[] as readonly R[]));
}

/** Convert a focus position to its conceptual (row, col) coordinate. */
export function focusToCoord<R extends string>(
  pos: FocusPos<R>,
  spec: GridSpec<R>,
): { row: number; col: number } {
  const roles = rolesOf(spec);
  const cellRow = Math.floor(pos.index / spec.cols);
  const col = pos.index % spec.cols;
  const roleIdx = Math.max(0, roles.indexOf(pos.role));
  const row = cellRow * roles.length + roleIdx;
  return { row, col };
}

/** Inverse of focusToCoord. Returns null if (row, col) is out of bounds. */
export function coordToFocus<R extends string>(
  row: number,
  col: number,
  spec: GridSpec<R>,
): FocusPos<R> | null {
  const roles = rolesOf(spec);
  const totalRows = spec.cellRows * roles.length;
  if (row < 0 || row >= totalRows) return null;
  if (col < 0 || col >= spec.cols) return null;
  const cellRow = Math.floor(row / roles.length);
  const roleIdx = row % roles.length;
  const role = roles[roleIdx]!;
  const index = cellRow * spec.cols + col;
  return { index, role };
}

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/** Resolve the next focus position for an arrow key. Returns null if the
 *  edge of the grid is reached (caller should leave focus where it is). */
export function resolveArrowNav<R extends string>(
  pos: FocusPos<R>,
  key: ArrowKey,
  spec: GridSpec<R>,
): FocusPos<R> | null {
  const { row, col } = focusToCoord(pos, spec);
  let nextRow = row;
  let nextCol = col;
  if (key === 'ArrowUp') nextRow = row - 1;
  else if (key === 'ArrowDown') nextRow = row + 1;
  else if (key === 'ArrowLeft') nextCol = col - 1;
  else if (key === 'ArrowRight') nextCol = col + 1;
  return coordToFocus(nextRow, nextCol, spec);
}
