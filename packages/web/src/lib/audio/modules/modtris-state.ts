// packages/web/src/lib/audio/modules/modtris-state.ts
//
// Pure deterministic game-state stepper for MODTRIS — a Tetris-clone
// game module. Kept separate from the AudioModuleDef factory so it's
// testable without Web Audio + reusable by the cross-peer awareness
// sync wiring planned in the design doc (docs/design/game-modules.md
// §2: MODTRIS → single-owner + 30 Hz awareness snapshot).
//
// Coordinate system: standard 10-wide × 20-tall well. (col, row) with
// col=0 left, row=0 top. A piece is a set of cell offsets + a rotation
// state; the well is a Uint8Array packed [row * COLS + col] storing
// the piece-color index (1..7) for occupied cells and 0 for empty.
//
// Inputs are gate signals (rising-edge: prev<0.5 && curr≥0.5 — same
// convention used by every other gate-edge detector in the project).
// The factory does the analyser-tap edge detect and passes the booleans
// here.
//
// Drop semantics: hard-drop on `drop_fast` rising edge — instantly
// snaps the current piece to its lowest legal row, locks it, and
// emits any line-clear / overfill events. The design-doc rationale
// (game-modules.md §3): in a modular synth a gate is naturally a
// per-event trigger, so per-pulse hard-drop matches the way patches
// actually fire. Soft-drop (gravity-multiplier-while-held) would
// require remembering held state across ticks and would lose pulses
// shorter than 16.67 ms, which is below the project's minimum gate-
// pulse width. Hard-drop is the right contract here.

/** Standard Tetris well width. */
export const COLS = 10;
/** Standard Tetris well height (visible field; spawn happens just above row 0). */
export const ROWS = 20;

/** A tetromino piece occupies 4 cells. */
const PIECE_CELLS = 4;

/** Piece kinds in the standard tetromino set. Indices into PIECE_DEFS. */
export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export const PIECE_KINDS: PieceKind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

/** Per-kind color index (1..7) so we can pack-render in a single Uint8Array
 *  cell value AND look up a render color downstream. Matches conventional
 *  Tetris coloring (I=cyan, O=yellow, T=purple, S=green, Z=red, J=blue, L=orange). */
export const PIECE_COLOR_INDEX: Record<PieceKind, number> = {
  I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7,
};

/**
 * Rotation states for each piece, encoded as a 4×4 grid of (col, row) offsets
 * relative to the piece's top-left bounding box. Standard rotation system
 * (SRS) wall-kicks are NOT implemented in v1 — basic rotation with collision
 * clamping is sufficient for the modular-game use case. If a rotation would
 * collide it's rejected; the player tries again or the piece keeps falling.
 *
 * Each entry is a 2D array of [col, row] cells. Listed in CW order
 * (rotateCW = (state + 1) % len, rotateCCW = (state + len - 1) % len).
 */
type CellOffset = readonly [number, number];
type Rotations = readonly (readonly CellOffset[])[];

const PIECE_DEFS: Record<PieceKind, Rotations> = {
  // I-piece: horizontal bar / vertical bar (2 rotations are unique).
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  // O-piece: 2×2 square (all 4 rotations identical).
  O: [
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
  ],
  // T-piece.
  T: [
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  // S-piece.
  S: [
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
  ],
  // Z-piece.
  Z: [
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
  ],
  // J-piece.
  J: [
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  // L-piece.
  L: [
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
};

export interface ActivePiece {
  kind: PieceKind;
  /** Rotation index into PIECE_DEFS[kind]. 0..3. */
  rotation: number;
  /** Left-edge column of the piece's 4×4 bounding box. */
  col: number;
  /** Top-edge row of the piece's 4×4 bounding box. Can be negative
   *  briefly during spawn (the piece appears partially above the well). */
  row: number;
}

export interface ModtrisParams {
  /** Gravity in "drops per minute" — 60 = 1 cell/second. Range 30..240. */
  gravityBpm: number;
  /**
   * Lines-per-level threshold. `level = floor(lines / levelStep)`, and each
   * level multiplies the seconds-per-drop by `LEVEL_GRAVITY_FACTOR` — so a
   * LOWER threshold is a STEEPER difficulty curve.
   *
   * ⚠ THIS COMMENT USED TO READ "unused in v1 stepper but reserved for future
   * scoring", AND IT WAS TRUE. The param was declared, faded, contract-locked,
   * ranked on the Push card and documented as "gravity speeds up each level" —
   * and read by nothing: `grep "params\." modtris-state.ts` returned exactly
   * one consumer, `gravitySecondsPerDrop(params.gravityBpm)`. Half the module's
   * control surface moved a dial and changed nothing, reachable in two seconds
   * by a player and by no gate in the repo. Wired here rather than deleted
   * because deleting is the larger contract change (a param row, a docs entry,
   * a Push slot and an orphan key in every saved patch) and because the docs
   * already promised this behaviour.
   */
  levelStep: number;
}

/**
 * Seconds-per-drop multiplier applied ONCE PER LEVEL. 0.85 means each level is
 * ~18 % faster than the one below it, so at the default `levelStep = 10` a run
 * reaching 50 lines is dropping at ~2.3x its opening rate.
 *
 * ⚠ IT IS A RATIO RATHER THAN A SUBTRACTION on purpose: `gravityBpm` spans
 * 30..240 on a LOG curve, so a fixed seconds-per-level decrement would be
 * imperceptible at 30 BPM and would hit the floor within two levels at 240.
 */
export const LEVEL_GRAVITY_FACTOR = 0.85;

/** Floor on the ramp, so a long run cannot drive the drop interval below one
 *  scheduler tick and turn gravity into a per-tick free-fall. */
export const MIN_SECONDS_PER_DROP = 0.05;

/** The difficulty level a given line count reaches at a given threshold. The
 *  ONE definition; the stepper, the docs and the surfaces all read it. */
export function levelForLines(lines: number, levelStep: number): number {
  const step = Math.max(1, Math.floor(levelStep));
  return Math.max(0, Math.floor(lines / step));
}

export interface ModtrisState {
  /** Packed well: index [row * COLS + col], 0 = empty, 1..7 = locked color. */
  well: Uint8Array;
  /** Current falling piece. Null only transiently during reset (spawn happens
   *  on the next step). */
  piece: ActivePiece | null;
  /** The 7-bag queue of upcoming pieces. We always keep ≥7 pieces queued so
   *  the renderer can show a next-piece preview. */
  queue: PieceKind[];
  /** Total lines cleared this game. */
  lines: number;
  /** Difficulty level, `floor(lines / levelStep)` at the moment of the last
   *  step. Derived rather than accumulated, so it cannot drift out of step
   *  with `lines` and it re-derives immediately when the LVL fader moves. */
  level: number;
  /** Internal accumulator for gravity. When it ≥ 1 cell-worth of seconds,
   *  the piece falls one row and the accumulator decrements by that interval. */
  gravityAccumSeconds: number;
  /** Events emitted on the most recent step. The factory reads these and
   *  pulses the corresponding gate outputs. Reset to defaults on the next step. */
  events: ModtrisEvents;
  /** Sequence counter. Incremented every step. Useful for the card / spectators
   *  to detect "did anything happen?" without deep-comparing the well. */
  tick: number;
}

export interface ModtrisEvents {
  /** Number of lines cleared THIS step. 0..4. */
  linesCleared: number;
  /** True if the board overfilled THIS step (and was auto-reset). */
  overfill: boolean;
  /** True if a piece locked THIS step (useful for the renderer; not gated). */
  locked: boolean;
}

export interface ModtrisInputs {
  /** Each is a rising-edge boolean (the factory does the edge detect). */
  rotateL: boolean;
  rotateR: boolean;
  dropFast: boolean;
  moveL: boolean;
  moveR: boolean;
}

/** Deterministic RNG signature. Default = Math.random; tests pass a seeded one. */
export type Rng = () => number;

/** Build the initial empty state. The first piece spawns on the first step
 *  so the queue gets initialised in a predictable place. */
export function initModtrisState(opts: { rng?: Rng } = {}): ModtrisState {
  const rng = opts.rng ?? Math.random;
  return {
    well: new Uint8Array(COLS * ROWS),
    piece: null,
    queue: refillQueueIfNeeded([], rng),
    lines: 0,
    level: 0,
    gravityAccumSeconds: 0,
    events: emptyEvents(),
    tick: 0,
  };
}

function emptyEvents(): ModtrisEvents {
  return { linesCleared: 0, overfill: false, locked: false };
}

/**
 * 7-bag randomizer. Each "bag" contains all 7 piece kinds in a shuffled
 * order; we draw from the front. When the queue has fewer than 7 pieces
 * left we refill with a fresh shuffled bag. Guarantees that within any
 * window of 7 consecutive pieces each kind appears exactly once — the
 * standard modern Tetris fairness property.
 */
function refillQueueIfNeeded(queue: PieceKind[], rng: Rng): PieceKind[] {
  if (queue.length >= 7) return queue;
  const bag: PieceKind[] = [...PIECE_KINDS];
  // Fisher-Yates shuffle using `rng()` for each swap.
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = bag[i]!; bag[i] = bag[j]!; bag[j] = tmp;
  }
  return [...queue, ...bag];
}

/** Spawn a new piece from the front of the queue. Returns null if the spawn
 *  position is already occupied (= overfill / game over). */
function spawnPiece(state: ModtrisState, rng: Rng): {
  piece: ActivePiece | null;
  queue: PieceKind[];
  overfill: boolean;
} {
  const queue = refillQueueIfNeeded(state.queue, rng);
  const kind = queue[0]!;
  const newQueue = queue.slice(1);
  // Spawn the 4×4 bounding box centered horizontally, row=0 (piece visible
  // immediately; the design says board immediately auto-resets on overfill
  // so we don't need an above-well spawn hide). For COLS=10, col=3 puts
  // the bbox at cols 3..6 — visually centered.
  const piece: ActivePiece = { kind, rotation: 0, col: 3, row: 0 };
  if (collides(state.well, piece)) {
    return { piece: null, queue: newQueue, overfill: true };
  }
  return { piece, queue: newQueue, overfill: false };
}

/** Cells of a piece, translated into well coords. */
export function pieceCells(piece: ActivePiece): Array<[number, number]> {
  const rot = PIECE_DEFS[piece.kind]![piece.rotation % 4]!;
  const out: Array<[number, number]> = [];
  for (const [c, r] of rot) {
    out.push([piece.col + c, piece.row + r]);
  }
  return out;
}

/** Returns true if `piece` would overlap a wall, floor, or locked cell. */
function collides(well: Uint8Array, piece: ActivePiece): boolean {
  for (const [c, r] of pieceCells(piece)) {
    if (c < 0 || c >= COLS) return true;
    if (r >= ROWS) return true;
    if (r < 0) continue; // above the well is allowed during spawn
    if (well[r * COLS + c] !== 0) return true;
  }
  return false;
}

/** Lock the piece's cells into the well at its current position. Returns
 *  the new well (does NOT mutate the input). */
function lockPiece(well: Uint8Array, piece: ActivePiece): Uint8Array {
  const next = new Uint8Array(well);
  const color = PIECE_COLOR_INDEX[piece.kind];
  for (const [c, r] of pieceCells(piece)) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
    next[r * COLS + c] = color;
  }
  return next;
}

/** Detect + remove cleared lines. Returns { well, linesCleared }. */
export function clearLines(well: Uint8Array): { well: Uint8Array; linesCleared: number } {
  const keptRows: number[] = [];
  let cleared = 0;
  for (let r = 0; r < ROWS; r++) {
    let full = true;
    for (let c = 0; c < COLS; c++) {
      if (well[r * COLS + c] === 0) { full = false; break; }
    }
    if (full) cleared += 1;
    else keptRows.push(r);
  }
  if (cleared === 0) return { well, linesCleared: 0 };
  const next = new Uint8Array(COLS * ROWS);
  // Compact kept rows toward the bottom of the well.
  let writeRow = ROWS - 1;
  for (let i = keptRows.length - 1; i >= 0; i--) {
    const sourceRow = keptRows[i]!;
    for (let c = 0; c < COLS; c++) {
      next[writeRow * COLS + c] = well[sourceRow * COLS + c]!;
    }
    writeRow -= 1;
  }
  return { well: next, linesCleared: cleared };
}

/** Try to move the piece. Returns the moved piece, or null if it collides. */
function tryMove(well: Uint8Array, piece: ActivePiece, dCol: number, dRow: number): ActivePiece | null {
  const candidate: ActivePiece = { ...piece, col: piece.col + dCol, row: piece.row + dRow };
  if (collides(well, candidate)) return null;
  return candidate;
}

/** Try to rotate the piece by `dir` (+1 = CW, -1 = CCW). No SRS wall-kicks. */
function tryRotate(well: Uint8Array, piece: ActivePiece, dir: 1 | -1): ActivePiece | null {
  const len = PIECE_DEFS[piece.kind].length;
  const nextRot = (piece.rotation + (dir === 1 ? 1 : len - 1)) % len;
  const candidate: ActivePiece = { ...piece, rotation: nextRot };
  if (collides(well, candidate)) return null;
  return candidate;
}

/** Hard-drop: snap the piece to its lowest legal row, then lock + clear. */
function hardDropAndLock(well: Uint8Array, piece: ActivePiece): {
  well: Uint8Array;
  linesCleared: number;
} {
  let p = piece;
  while (true) {
    const next = tryMove(well, p, 0, 1);
    if (!next) break;
    p = next;
  }
  const lockedWell = lockPiece(well, p);
  return clearLines(lockedWell);
}

/**
 * Convert gravity (drops per minute) to seconds per drop AT A GIVEN LEVEL.
 *
 * ⚠ `level` IS THE HALF THAT USED TO BE MISSING. The function took `gravityBpm`
 * alone, which is why `levelStep` was a dead control and why `docs.controls`
 * described a difficulty ramp the module did not have.
 */
export function gravitySecondsPerDrop(gravityBpm: number, level = 0): number {
  // Guard against zero / negative (faders clamp but tests can pass arbitrary).
  const bpm = Math.max(1, gravityBpm);
  const lvl = Math.max(0, Math.floor(level));
  return Math.max(MIN_SECONDS_PER_DROP, (60 / bpm) * LEVEL_GRAVITY_FACTOR ** lvl);
}

/** Step the state forward by `dtSeconds`, applying input edges + gravity. */
export function stepModtrisState(
  prev: ModtrisState,
  inputs: ModtrisInputs,
  params: ModtrisParams,
  dtSeconds: number,
  opts: { rng?: Rng } = {},
): ModtrisState {
  const rng = opts.rng ?? Math.random;
  const events: ModtrisEvents = emptyEvents();
  let well = prev.well;
  let piece = prev.piece;
  let queue = prev.queue;
  let lines = prev.lines;
  let gravityAccumSeconds = prev.gravityAccumSeconds + dtSeconds;

  // Spawn a piece if we don't have one yet (first tick after init or
  // after a lock).
  if (!piece) {
    const sp = spawnPiece({ ...prev, well }, rng);
    if (sp.overfill) {
      // Overfill on spawn: emit + auto-reset. We DO NOT spawn this step;
      // the next step will spawn into the reset board.
      const fresh = initModtrisState({ rng });
      return {
        ...fresh,
        events: { linesCleared: 0, overfill: true, locked: false },
        tick: prev.tick + 1,
      };
    }
    piece = sp.piece;
    queue = sp.queue;
  }

  // 1. Horizontal movement (rising-edge gates).
  if (inputs.moveL && piece) {
    const moved = tryMove(well, piece, -1, 0);
    if (moved) piece = moved;
  }
  if (inputs.moveR && piece) {
    const moved = tryMove(well, piece, 1, 0);
    if (moved) piece = moved;
  }

  // 2. Rotation (rising-edge gates).
  if (inputs.rotateL && piece) {
    const rotated = tryRotate(well, piece, -1);
    if (rotated) piece = rotated;
  }
  if (inputs.rotateR && piece) {
    const rotated = tryRotate(well, piece, 1);
    if (rotated) piece = rotated;
  }

  // 3. Hard drop (rising-edge gate). Locks immediately + emits clears.
  if (inputs.dropFast && piece) {
    const result = hardDropAndLock(well, piece);
    well = result.well;
    lines += result.linesCleared;
    events.linesCleared = result.linesCleared;
    events.locked = true;
    piece = null;
    gravityAccumSeconds = 0;
    return {
      well,
      piece,
      queue,
      lines,
      level: levelForLines(lines, params.levelStep),
      gravityAccumSeconds,
      events,
      tick: prev.tick + 1,
    };
  }

  // 4. Gravity. Drop one row per `secondsPerDrop`; if it would collide,
  //    lock the piece + clear lines instead. May drop multiple cells in
  //    a single step if dtSeconds > secondsPerDrop (long gaps, paused tabs).
  //
  // ⚠ THE LEVEL IS RE-DERIVED FROM THE LINE COUNT ON EVERY STEP, not carried,
  // so moving the LVL fader mid-game re-prices the ramp on the very next tick
  // instead of on the next level-up. That is what makes the control LIVE — the
  // same property `gravityBpm` already had and the reason both rank.
  const secondsPerDrop = gravitySecondsPerDrop(
    params.gravityBpm,
    levelForLines(lines, params.levelStep),
  );
  while (piece && gravityAccumSeconds >= secondsPerDrop) {
    const moved = tryMove(well, piece, 0, 1);
    gravityAccumSeconds -= secondsPerDrop;
    if (moved) {
      piece = moved;
    } else {
      // Lock + clear.
      const lockedWell = lockPiece(well, piece);
      const { well: clearedWell, linesCleared } = clearLines(lockedWell);
      well = clearedWell;
      lines += linesCleared;
      events.linesCleared += linesCleared;
      events.locked = true;
      piece = null;
      gravityAccumSeconds = 0;
      break;
    }
  }

  return {
    well,
    piece,
    queue,
    lines,
    level: levelForLines(lines, params.levelStep),
    gravityAccumSeconds,
    events,
    tick: prev.tick + 1,
  };
}

/** Rising-edge detector helper. Returns true iff prev<threshold ≤ curr. */
export function detectRisingEdge(prev: number, curr: number, threshold = 0.5): boolean {
  return prev < threshold && curr >= threshold;
}
