// packages/web/src/lib/audio/modules/seqtris-engine.ts
//
// SEQTRIS — the PURE game core. No Web Audio, no Svelte, no DOM, no clock.
// Every function here is total and deterministic: given a seed and a sequence
// of inputs/clock pulses you get the same board, the same pieces and the same
// notes, every time. The module factory (seqtris.ts) and the card UI both
// consume THIS — neither owns a rule.
//
// WHY A PURE CORE. The musically interesting part of SEQTRIS is not the audio
// graph, it is the game: which square a piece tracks, what note that square is
// on, when the board drops and how the tempo ladder steps. Those are the things
// a unit test can pin exactly and a Playwright test cannot. Keeping them out of
// the factory means the e2e only has to prove the WIRING (real Launchpad-shaped
// input → poly out → audible voice), not the rules.
//
// ── THE BOARD ────────────────────────────────────────────────────────────────
// 8 columns × 8 rows, matching the Launchpad's 8×8 pad grid exactly. Row 0 is
// the TOP (where pieces spawn), row 7 is the FLOOR. Column 0 is the LEFT.
// Stored row-major as a flat length-64 array of piece ids (or null) so the card
// can colour a landed cell by the piece that put it there.
//
// ── THE PIECE SET (the owner's 8×8 modifications) ────────────────────────────
// The normal seven tetromino NAMES are kept, with two shapes shortened so the
// tallest piece is 3 rows on an 8-row board:
//
//   I  shortened to a 2-cell domino   →  1 row horizontal, 2 rows vertical
//   O  unchanged 2×2 square           →  2 rows
//   T  unchanged tetromino            →  2 rows horizontal, 3 vertical
//   S  unchanged tetromino            →  2 rows horizontal, 3 vertical
//   Z  unchanged tetromino            →  2 rows horizontal, 3 vertical
//   L  shortened to a 3-cell corner   →  2 rows in every rotation
//   J  the MIRROR of that corner      →  2 rows in every rotation
//
// which lands exactly on the owner's "all pieces are 1-3 rows depending on
// vertical or horizontal". J and L are congruent under rotation — they are kept
// as two bag entries because they SPAWN mirrored, and the spawn orientation is
// what picks the tracked square, so they are musically distinct even though
// they are the same shape.
//
// ── THE TRACKED SQUARE ───────────────────────────────────────────────────────
// Each spawned piece carries ONE square that decides its note for the piece's
// whole life: the first square to appear on screen, which is the leftmost cell
// of the spawn shape's top row. Rotation is applied as a rigid body transform
// that PERMUTES POSITIONS WITHOUT REORDERING THE CELL ARRAY, so cell identity
// is just the array index — the tracked square follows the rotation around the
// piece and is never re-picked, exactly as specified.
//
// ── THE NOTE ─────────────────────────────────────────────────────────────────
// COLUMN picks the octave, ROW picks the degree of a DESCENDING C major scale:
//
//   row 0 C   row 1 B   row 2 A   row 3 G
//   row 4 F   row 5 E   row 6 D   row 7 C   (one octave below row 0)
//
// Eight rows spanning exactly one octave with C at both ends is what the spec's
// "top row corresponding to C … and the bottom of the 8 rows therefore
// corresponding to C-1" describes, and it is why the scale runs downward.
//
// Column c's TOP row is C(c+1), so its BOTTOM row is C(c). The leftmost column
// therefore reaches down to C0 (MIDI 12 = MIN_MIDI) and the rightmost reaches
// up to C8 (MIDI 108 = MAX_MIDI) — the spec's "left most … octave0 and the
// right most to octave 8" read as the RANGE the 8 columns span, which is the
// only reading that fits 9 octave names onto 8 columns without a gap, and it
// happens to land the extremes exactly on the repo's legal MIDI bounds. Nothing
// this module can emit is ever clamped.
//
// ── GRAVITY AS A CLOCK DIVISOR ───────────────────────────────────────────────
// Gravity is counted in INCOMING CLOCK PULSES, never in milliseconds: one row
// every `divisor` pulses. Clearing a line steps the divisor DOWN the ladder to
// the next integer that approximates +10% speed, so a level change can never
// put the game loop off the clock grid — every gravity step and every spawn
// still lands on a clock edge, before and after. See `divisorLadder`.

// ---------------- Geometry ----------------

export const SEQTRIS_COLS = 8;
export const SEQTRIS_ROWS = 8;
export const SEQTRIS_CELLS = SEQTRIS_COLS * SEQTRIS_ROWS;

/** The seven bag entries. Lowercase — the module label rule is about labels,
 *  but keeping ids lowercase keeps LED/testid derivation trivial. */
export type SeqtrisPieceId = 'i' | 'o' | 't' | 's' | 'z' | 'j' | 'l';

export const SEQTRIS_PIECE_IDS: readonly SeqtrisPieceId[] = ['i', 'o', 't', 's', 'z', 'j', 'l'];

export interface SeqtrisCell {
  readonly row: number;
  readonly col: number;
}

/**
 * SPAWN shapes, as relative (row, col) with row 0 = the piece's top row.
 *
 * ⚠ THE ARRAY ORDER IS THE CELL IDENTITY. `rotateCw` maps entry i to entry i,
 * so the tracked square is an INDEX into these arrays and survives rotation for
 * free. Reordering an entry here silently re-points the tracked square of that
 * piece — which is a musical change, not a cosmetic one.
 */
const SPAWN_SHAPES: Record<SeqtrisPieceId, readonly SeqtrisCell[]> = {
  // XX      (the straight-line piece, shortened from 4 cells to 2)
  i: [{ row: 0, col: 0 }, { row: 0, col: 1 }],
  // XX
  // XX
  o: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 }],
  // XXX
  // .X.
  t: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 1 }],
  // .XX
  // XX.
  s: [{ row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 0 }, { row: 1, col: 1 }],
  // XX.
  // .XX
  z: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 1 }, { row: 1, col: 2 }],
  // .X     (corner tromino, top-RIGHT corner — the mirror of L)
  // XX
  j: [{ row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 }],
  // X.     (corner tromino, top-LEFT corner)
  // XX
  l: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 1, col: 1 }],
};

/**
 * Rotate a cell list 90° clockwise about the origin and re-normalize to a
 * top-left-anchored bounding box. Rigid: (row, col) → (col, -row), then shift.
 *
 * ⚠ ORDER-PRESERVING BY CONSTRUCTION (a `.map`), which is the whole reason the
 * tracked square can be an array index.
 */
export function rotateCw(cells: readonly SeqtrisCell[]): readonly SeqtrisCell[] {
  const turned = cells.map((c) => ({ row: c.col, col: -c.row }));
  let minRow = Infinity;
  let minCol = Infinity;
  for (const c of turned) {
    if (c.row < minRow) minRow = c.row;
    if (c.col < minCol) minCol = c.col;
  }
  return turned.map((c) => ({ row: c.row - minRow, col: c.col - minCol }));
}

/** All four rotation states of every piece, index-identity preserved. */
export const SEQTRIS_ROTATIONS: Record<SeqtrisPieceId, readonly (readonly SeqtrisCell[])[]> =
  (() => {
    const out = {} as Record<SeqtrisPieceId, readonly (readonly SeqtrisCell[])[]>;
    for (const id of SEQTRIS_PIECE_IDS) {
      const states: (readonly SeqtrisCell[])[] = [SPAWN_SHAPES[id]];
      for (let k = 1; k < 4; k++) states.push(rotateCw(states[k - 1]!));
      out[id] = states;
    }
    return out;
  })();

/** Width (columns) of a rotation state. */
export function shapeWidth(cells: readonly SeqtrisCell[]): number {
  let max = 0;
  for (const c of cells) if (c.col > max) max = c.col;
  return max + 1;
}

/** Height (rows) of a rotation state. */
export function shapeHeight(cells: readonly SeqtrisCell[]): number {
  let max = 0;
  for (const c of cells) if (c.row > max) max = c.row;
  return max + 1;
}

/**
 * The tracked square: the index of the leftmost cell of the TOP row — "whatever
 * the first square to spawn on the tetris screen was", with the owner's
 * leftmost-wins tie-break when the spawn row holds 2 or 3 squares.
 *
 * Exported (rather than inlined at the one call site) so the tie-break itself is
 * unit-testable on shapes this module does not ship.
 */
export function pickTrackedIndex(cells: readonly SeqtrisCell[]): number {
  let best = 0;
  for (let i = 1; i < cells.length; i++) {
    const c = cells[i]!;
    const b = cells[best]!;
    if (c.row < b.row || (c.row === b.row && c.col < b.col)) best = i;
  }
  return best;
}

/**
 * The piece palette, in LAUNCHPAD RGB units (0..127) — the classic tetromino
 * colours. ONE palette for both surfaces on purpose: the player is looking at
 * the hardware, so the card has to be the same picture in the same colours, and
 * a second copy of these numbers is how the two drift apart.
 */
export const SEQTRIS_PIECE_RGB: Record<SeqtrisPieceId, readonly [number, number, number]> = {
  i: [0, 110, 118], // cyan
  o: [118, 110, 0], // yellow
  t: [86, 0, 118], // purple
  s: [0, 112, 24], // green
  z: [118, 12, 12], // red
  j: [16, 24, 122], // blue
  l: [122, 52, 0], // orange
};

/** The same palette as a CSS colour, scaled 0..127 → 0..255 for the card. */
export function seqtrisCssColor(id: SeqtrisPieceId | null): string {
  if (id === null) return 'rgb(18, 20, 26)';
  const [r, g, b] = SEQTRIS_PIECE_RGB[id];
  const s = (v: number): number => Math.round((v / 127) * 255);
  return `rgb(${s(r)}, ${s(g)}, ${s(b)})`;
}

// ---------------- Notes ----------------

/**
 * Semitone offsets from the column's C, one per board row — C major DESCENDING.
 * Row 7 is a full octave below row 0, so a column spans exactly one octave and
 * both of its ends are a C.
 */
export const SEQTRIS_ROW_SEMITONES: readonly number[] = [0, -1, -3, -5, -7, -8, -10, -12];

/** The octave name of a column's TOP row. Column 0 → octave 1 (so its bottom
 *  row is C0); column 7 → octave 8. */
export function octaveForColumn(col: number): number {
  return col + 1;
}

/**
 * The MIDI note a tracked square at (row, col) plays. C(oct) = 12 * (oct + 1),
 * so column c's top row is 12 * (c + 2).
 *
 * Total over the whole board: the extremes are MIDI 12 (col 0, row 7 → C0) and
 * MIDI 108 (col 7, row 0 → C8), which are exactly MIN_MIDI and MAX_MIDI — no
 * board position can produce an out-of-range note.
 */
export function midiForCell(row: number, col: number): number {
  const clampedRow = Math.max(0, Math.min(SEQTRIS_ROWS - 1, Math.round(row)));
  const clampedCol = Math.max(0, Math.min(SEQTRIS_COLS - 1, Math.round(col)));
  return 12 * (octaveForColumn(clampedCol) + 1) + SEQTRIS_ROW_SEMITONES[clampedRow]!;
}

// ---------------- Speed ladder ----------------

/** The speed-up the owner asked for: "roughly 10% every time we lose a line". */
export const SEQTRIS_SPEEDUP = 1.1;

/**
 * One rung DOWN the divisor ladder. The next divisor is the integer nearest to
 * `divisor / 1.1` — but never larger than `divisor - 1`, so a rung is always a
 * real speed-up, and never below 1, which is the fastest a clock-locked game
 * loop can run (one row per incoming pulse).
 *
 * ⚠ INTEGER BY CONSTRUCTION, and that is the point rather than a rounding
 * convenience: gravity fires every Nth pulse, so a fractional divisor would put
 * a step BETWEEN two clock edges and the "+10%" would cost the 1:1 alignment the
 * spec asks for. The approximation error is paid in the ladder, not in the grid.
 */
export function nextDivisor(divisor: number): number {
  const d = Math.max(1, Math.round(divisor));
  if (d <= 1) return 1;
  return Math.max(1, Math.min(d - 1, Math.round(d / SEQTRIS_SPEEDUP)));
}

/**
 * The full ladder from a base divisor down to 1 — what the docs quote and what
 * the card shows as the level meter's length.
 */
export function divisorLadder(base: number): readonly number[] {
  const out: number[] = [Math.max(1, Math.round(base))];
  while (out[out.length - 1]! > 1) out.push(nextDivisor(out[out.length - 1]!));
  return out;
}

/** The divisor after `lines` cleared lines, starting from `base`. */
export function divisorForLines(base: number, lines: number): number {
  let d = Math.max(1, Math.round(base));
  for (let i = 0; i < lines; i++) d = nextDivisor(d);
  return d;
}

// ---------------- Seeded RNG + 7-bag ----------------

/** mulberry32 — 32-bit, seedable, no dependencies, uniform enough for a bag. */
export function nextRandom(state: number): { state: number; value: number } {
  let t = (state + 0x6d2b79f5) >>> 0;
  let x = t;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { state: t, value };
}

/** Fisher-Yates over the seven ids, driven by the seeded RNG. */
export function shuffledBag(seed: number): { state: number; bag: readonly SeqtrisPieceId[] } {
  const bag = [...SEQTRIS_PIECE_IDS];
  let state = seed;
  for (let i = bag.length - 1; i > 0; i--) {
    const r = nextRandom(state);
    state = r.state;
    const j = Math.floor(r.value * (i + 1));
    const tmp = bag[i]!;
    bag[i] = bag[j]!;
    bag[j] = tmp;
  }
  return { state, bag };
}

// ---------------- State ----------------

export interface SeqtrisPiece {
  readonly id: SeqtrisPieceId;
  /** 0..3, 0 = spawn orientation. */
  readonly rot: number;
  /** Board row/col of the piece's relative (0,0) anchor. */
  readonly row: number;
  readonly col: number;
  /** Index into SEQTRIS_ROTATIONS[id][rot] — immutable for the piece's life. */
  readonly trackedIndex: number;
}

export interface SeqtrisState {
  /** Row-major, length 64. null = empty; a piece id = a landed cell. */
  readonly board: readonly (SeqtrisPieceId | null)[];
  readonly piece: SeqtrisPiece | null;
  /** Pulses accumulated toward the next gravity step. */
  readonly pulse: number;
  /** Pulses per gravity step right now. */
  readonly divisor: number;
  /** Pulses per gravity step at level 0 — the `gravity` param. */
  readonly baseDivisor: number;
  /** Lines cleared in the CURRENT game (resets on reset / game over). */
  readonly lines: number;
  /** Lines cleared since the module was created — a monotonic readout. */
  readonly totalLines: number;
  /** Games ended by stack-out since the module was created. */
  readonly gameOvers: number;
  readonly rng: number;
  readonly bag: readonly SeqtrisPieceId[];
}

export type SeqtrisInput =
  | 'reset'
  | 'drop'
  | 'rotateLeft'
  | 'rotateRight'
  | 'moveLeft'
  | 'moveRight';

/** Why a Piece note fired — carried so the card and the tests can tell a
 *  gravity note from a played one, and so a drop is unmistakably a drop. */
export type SeqtrisNoteCause = 'spawn' | 'gravity' | 'move' | 'rotate';

export type SeqtrisEvent =
  /** ONE note on the Piece output. `midi` is the tracked square's note. */
  | { readonly kind: 'note'; readonly midi: number; readonly row: number; readonly col: number; readonly cause: SeqtrisNoteCause }
  /** A hard drop: every row the tracked square passed through, as ONE tied
   *  gate. `midis` is in the order the rows were traversed, resting row last. */
  | { readonly kind: 'tie'; readonly midis: readonly number[] }
  | { readonly kind: 'spawn'; readonly piece: SeqtrisPieceId }
  /** One event per CLEARED ROW — a double clear emits two. */
  | { readonly kind: 'line'; readonly row: number }
  | { readonly kind: 'gameover' };

export interface SeqtrisStep {
  readonly state: SeqtrisState;
  readonly events: readonly SeqtrisEvent[];
}

/**
 * Collapse the notes of ONE clock pulse down to the one that is actually heard.
 *
 * ⚠ WHY THIS IS NOT COSMETIC. A single pulse can produce several note events —
 * a queued player move applies, then gravity falls, and both happen at the same
 * instant on the game clock. Scheduled at the same audio time, the later write
 * simply replaces the earlier one, so only the last was ever audible. Leaving
 * the earlier ones in would make the module COUNT notes it never played, which
 * is the shape of a metric that reads healthy while the instrument is wrong.
 *
 * A TIE is a delimiter rather than a note: it occupies a real span of time (a
 * hard drop's chord is held for a gravity step), so a note before a tie and a
 * note after it are two genuinely separate sounds and both survive.
 *
 * Gate events (`spawn`, `line`, `gameover`) are never collapsed — they are
 * different ports and they all really happened.
 */
export function coalesceSeqtrisNotes(
  events: readonly SeqtrisEvent[],
): readonly SeqtrisEvent[] {
  const out: SeqtrisEvent[] = [];
  let heldNote: SeqtrisEvent | null = null;
  for (const ev of events) {
    if (ev.kind === 'note') {
      heldNote = ev; // a later note in the same span wins
      continue;
    }
    if (ev.kind === 'tie' && heldNote !== null) {
      out.push(heldNote);
      heldNote = null;
    }
    out.push(ev);
  }
  if (heldNote !== null) out.push(heldNote);
  return out;
}

/** The default seed. Fixed rather than random so a fresh SEQTRIS always opens
 *  on the same piece sequence — which is what makes the e2e and the unit suite
 *  able to name a piece, and is friendly rather than surprising in a game. */
export const SEQTRIS_DEFAULT_SEED = 0x5e9721;

export const SEQTRIS_DEFAULT_DIVISOR = 8;

const EMPTY_BOARD: readonly (SeqtrisPieceId | null)[] = Array.from(
  { length: SEQTRIS_CELLS },
  () => null,
);

// ---------------- Board helpers ----------------

export function cellIndex(row: number, col: number): number {
  return row * SEQTRIS_COLS + col;
}

/** Absolute board cells occupied by a piece. */
export function pieceCells(piece: SeqtrisPiece): readonly SeqtrisCell[] {
  const shape = SEQTRIS_ROTATIONS[piece.id][piece.rot % 4]!;
  return shape.map((c) => ({ row: piece.row + c.row, col: piece.col + c.col }));
}

/** The tracked square's ABSOLUTE board position. */
export function trackedCell(piece: SeqtrisPiece): SeqtrisCell {
  const shape = SEQTRIS_ROTATIONS[piece.id][piece.rot % 4]!;
  const c = shape[piece.trackedIndex] ?? shape[0]!;
  return { row: piece.row + c.row, col: piece.col + c.col };
}

/** The MIDI note a piece is currently sounding. */
export function pieceMidi(piece: SeqtrisPiece): number {
  const t = trackedCell(piece);
  return midiForCell(t.row, t.col);
}

function collides(board: readonly (SeqtrisPieceId | null)[], piece: SeqtrisPiece): boolean {
  for (const c of pieceCells(piece)) {
    if (c.col < 0 || c.col >= SEQTRIS_COLS) return true;
    if (c.row < 0 || c.row >= SEQTRIS_ROWS) return true;
    if (board[cellIndex(c.row, c.col)] != null) return true;
  }
  return false;
}

/** Board including the falling piece — what the card and the Launchpad draw. */
export function renderBoard(state: SeqtrisState): readonly (SeqtrisPieceId | null)[] {
  if (!state.piece) return state.board;
  const out = [...state.board];
  for (const c of pieceCells(state.piece)) {
    if (c.row >= 0 && c.row < SEQTRIS_ROWS && c.col >= 0 && c.col < SEQTRIS_COLS) {
      out[cellIndex(c.row, c.col)] = state.piece.id;
    }
  }
  return out;
}

// ---------------- Spawning ----------------

function drawPiece(state: SeqtrisState): { rng: number; bag: readonly SeqtrisPieceId[]; id: SeqtrisPieceId } {
  let { rng, bag } = { rng: state.rng, bag: state.bag };
  if (bag.length === 0) {
    const r = shuffledBag(rng);
    rng = r.state;
    bag = r.bag;
  }
  const id = bag[0]!;
  return { rng, bag: bag.slice(1), id };
}

function makePiece(id: SeqtrisPieceId): SeqtrisPiece {
  const shape = SEQTRIS_ROTATIONS[id][0]!;
  const width = shapeWidth(shape);
  return {
    id,
    rot: 0,
    row: 0,
    col: Math.floor((SEQTRIS_COLS - width) / 2),
    trackedIndex: pickTrackedIndex(shape),
  };
}

/**
 * Put the next piece on the board.
 *
 * ⚠ SPAWN FIRES A NOTE, and that is an interpretation rather than a reading of
 * "whenever the current piece moves". Without it the TONIC is unreachable: a
 * piece spawns on row 0 (a C) and gravity moves it to row 1 (a B) before the
 * player can do anything, so the top row would only ever sound when someone
 * moved sideways on the very first frame. Firing on spawn makes the note stream
 * a superset of the literal reading and makes every spawn audible as a C.
 *
 * On stack-out the board is cleared, the ladder resets to the base divisor and
 * a fresh piece spawns — the module never enters a dead state, because a dead
 * standalone sequencer just goes silent in a rack.
 */
function spawn(state: SeqtrisState, events: SeqtrisEvent[]): SeqtrisState {
  const drawn = drawPiece(state);
  let next: SeqtrisState = { ...state, rng: drawn.rng, bag: drawn.bag };
  const piece = makePiece(drawn.id);

  if (collides(next.board, piece)) {
    // Stack-out. `line` does NOT fire — nothing was cleared.
    events.push({ kind: 'gameover' });
    next = {
      ...next,
      board: EMPTY_BOARD,
      lines: 0,
      divisor: next.baseDivisor,
      gameOvers: next.gameOvers + 1,
    };
  }

  events.push({ kind: 'spawn', piece: piece.id });
  const t = trackedCell(piece);
  events.push({ kind: 'note', midi: midiForCell(t.row, t.col), row: t.row, col: t.col, cause: 'spawn' });
  return { ...next, piece, pulse: 0 };
}

// ---------------- Locking + line clears ----------------

function lockAndClear(state: SeqtrisState, events: SeqtrisEvent[]): SeqtrisState {
  const piece = state.piece;
  if (!piece) return state;
  const board = [...state.board];
  for (const c of pieceCells(piece)) {
    if (c.row >= 0 && c.row < SEQTRIS_ROWS && c.col >= 0 && c.col < SEQTRIS_COLS) {
      board[cellIndex(c.row, c.col)] = piece.id;
    }
  }

  const fullRows: number[] = [];
  for (let r = 0; r < SEQTRIS_ROWS; r++) {
    let full = true;
    for (let c = 0; c < SEQTRIS_COLS; c++) {
      if (board[cellIndex(r, c)] == null) { full = false; break; }
    }
    if (full) fullRows.push(r);
  }

  let next: SeqtrisState = { ...state, board, piece: null };

  if (fullRows.length > 0) {
    const kept: (SeqtrisPieceId | null)[] = [];
    for (let r = 0; r < SEQTRIS_ROWS; r++) {
      if (fullRows.includes(r)) continue;
      for (let c = 0; c < SEQTRIS_COLS; c++) kept.push(board[cellIndex(r, c)]!);
    }
    const dropped: (SeqtrisPieceId | null)[] = [];
    while (dropped.length < SEQTRIS_CELLS - kept.length) dropped.push(null);
    // One `line` event per CLEARED ROW: the board drops one row per row cleared,
    // and the spec ties the output to "the board drops down a line".
    for (const r of fullRows) events.push({ kind: 'line', row: r });
    next = {
      ...next,
      board: [...dropped, ...kept],
      lines: next.lines + fullRows.length,
      totalLines: next.totalLines + fullRows.length,
      // One ladder rung per cleared LINE — "roughly 10% every time we lose a
      // line", so a double clear steps twice.
      divisor: divisorForLines(next.divisor, fullRows.length),
    };
  }

  return spawn(next, events);
}

// ---------------- Public constructors + reducers ----------------

export function createSeqtrisState(opts?: {
  seed?: number;
  baseDivisor?: number;
}): SeqtrisState {
  const baseDivisor = Math.max(1, Math.round(opts?.baseDivisor ?? SEQTRIS_DEFAULT_DIVISOR));
  const seeded = shuffledBag(opts?.seed ?? SEQTRIS_DEFAULT_SEED);
  const blank: SeqtrisState = {
    board: EMPTY_BOARD,
    piece: null,
    pulse: 0,
    divisor: baseDivisor,
    baseDivisor,
    lines: 0,
    totalLines: 0,
    gameOvers: 0,
    rng: seeded.state,
    bag: seeded.bag,
  };
  // The opening spawn's events are discarded: nothing is patched yet at
  // construction time, and a note the graph cannot hear is not an event.
  return spawnQuiet(blank);
}

function spawnQuiet(state: SeqtrisState): SeqtrisState {
  const sink: SeqtrisEvent[] = [];
  return spawn(state, sink);
}

/** Change the base divisor (the `gravity` param) without disturbing the game.
 *  The CURRENT divisor is re-derived from the new base and the lines cleared so
 *  far, so the ladder stays a function of the param rather than of history. */
export function setBaseDivisor(state: SeqtrisState, baseDivisor: number): SeqtrisState {
  const base = Math.max(1, Math.round(baseDivisor));
  if (base === state.baseDivisor) return state;
  return {
    ...state,
    baseDivisor: base,
    divisor: divisorForLines(base, state.lines),
    pulse: 0,
  };
}

/**
 * One incoming clock pulse. Gravity fires when `divisor` pulses have arrived.
 *
 * ⚠ `pulse` RESETS to 0 on every gravity step AND on every divisor change, so a
 * level-up never leaves a partial count that would slide the next step off the
 * grid. That is the mechanism behind "piece movements and spawns that line up
 * 1-1 with clock events".
 */
export function clockPulse(state: SeqtrisState): SeqtrisStep {
  const events: SeqtrisEvent[] = [];
  const pulse = state.pulse + 1;
  if (pulse < state.divisor) return { state: { ...state, pulse }, events };

  const piece = state.piece;
  if (!piece) return { state: spawnQuiet({ ...state, pulse: 0 }), events };

  const moved: SeqtrisPiece = { ...piece, row: piece.row + 1 };
  if (collides(state.board, moved)) {
    return { state: lockAndClear({ ...state, pulse: 0 }, events), events };
  }
  const t = trackedCell(moved);
  events.push({ kind: 'note', midi: midiForCell(t.row, t.col), row: t.row, col: t.col, cause: 'gravity' });
  return { state: { ...state, piece: moved, pulse: 0 }, events };
}

/** Column offsets tried when a rotation collides in place — a small, symmetric
 *  wall kick. NOT the SRS kick table: an 8-wide board has no room for SRS's
 *  two-column T-spin kicks, and the owner asked for the normal shapes rather
 *  than the normal kick system. */
const KICKS: readonly number[] = [0, -1, 1, -2, 2];

export function applyInput(state: SeqtrisState, input: SeqtrisInput): SeqtrisStep {
  const events: SeqtrisEvent[] = [];

  if (input === 'reset') {
    const blank: SeqtrisState = {
      ...state,
      board: EMPTY_BOARD,
      piece: null,
      pulse: 0,
      lines: 0,
      divisor: state.baseDivisor,
    };
    return { state: spawn(blank, events), events };
  }

  const piece = state.piece;
  if (!piece) return { state, events };

  if (input === 'moveLeft' || input === 'moveRight') {
    const dc = input === 'moveLeft' ? -1 : 1;
    const moved: SeqtrisPiece = { ...piece, col: piece.col + dc };
    if (collides(state.board, moved)) return { state, events };
    const t = trackedCell(moved);
    events.push({ kind: 'note', midi: midiForCell(t.row, t.col), row: t.row, col: t.col, cause: 'move' });
    return { state: { ...state, piece: moved }, events };
  }

  if (input === 'rotateLeft' || input === 'rotateRight') {
    const rot = (piece.rot + (input === 'rotateRight' ? 1 : 3)) % 4;
    for (const kick of KICKS) {
      const turned: SeqtrisPiece = { ...piece, rot, col: piece.col + kick };
      if (collides(state.board, turned)) continue;
      const t = trackedCell(turned);
      events.push({ kind: 'note', midi: midiForCell(t.row, t.col), row: t.row, col: t.col, cause: 'rotate' });
      return { state: { ...state, piece: turned }, events };
    }
    return { state, events };
  }

  // input === 'drop' — a HARD drop.
  //
  // ⚠ ONE TIED GATE CARRYING EVERY ROW'S NOTE. The spec asks for "a single gate
  // but all the notes as the piece drops as one tied gate": the drop is
  // instantaneous in the game, so the rows it passes through are emitted
  // TOGETHER on the poly cable's lanes with their gates rising as one and held,
  // rather than as N retriggered notes. The tie is closed by the NEXT Piece
  // note, which is the next piece's spawn note.
  let cur = piece;
  const midis: number[] = [];
  for (;;) {
    const down: SeqtrisPiece = { ...cur, row: cur.row + 1 };
    if (collides(state.board, down)) break;
    cur = down;
    midis.push(pieceMidi(cur));
  }
  if (midis.length > 0) events.push({ kind: 'tie', midis });
  return { state: lockAndClear({ ...state, piece: cur, pulse: 0 }, events), events };
}
