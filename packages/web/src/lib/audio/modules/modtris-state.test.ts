// packages/web/src/lib/audio/modules/modtris-state.test.ts
//
// Unit tests for the pure MODTRIS state stepper. No Web Audio, no DOM.

import { describe, it, expect } from 'vitest';
import {
  initModtrisState,
  stepModtrisState,
  pieceCells,
  clearLines,
  detectRisingEdge,
  gravitySecondsPerDrop,
  levelForLines,
  LEVEL_GRAVITY_FACTOR,
  MIN_SECONDS_PER_DROP,
  PIECE_KINDS,
  PIECE_COLOR_INDEX,
  COLS,
  ROWS,
  type ModtrisInputs,
  type ModtrisParams,
  type ModtrisState,
  type PieceKind,
} from './modtris-state';

const BASE_PARAMS: ModtrisParams = { gravityBpm: 60, levelStep: 10 };

// Make a seeded RNG (mulberry32). Deterministic tests need this; Math.random
// makes the 7-bag shuffle non-reproducible.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NO_INPUTS: ModtrisInputs = {
  rotateL: false, rotateR: false, dropFast: false, moveL: false, moveR: false,
};

describe('detectRisingEdge', () => {
  it('fires when crossing 0.5 upward', () => {
    expect(detectRisingEdge(0, 1)).toBe(true);
    expect(detectRisingEdge(0.2, 0.8)).toBe(true);
  });
  it('does not fire when staying high', () => {
    expect(detectRisingEdge(1, 1)).toBe(false);
  });
  it('does not fire when staying low', () => {
    expect(detectRisingEdge(0, 0.3)).toBe(false);
  });
  it('does not fire when crossing downward', () => {
    expect(detectRisingEdge(1, 0)).toBe(false);
  });
});

describe('initModtrisState', () => {
  it('starts with an empty well', () => {
    const s = initModtrisState({ rng: seededRng(1) });
    expect(s.well.length).toBe(COLS * ROWS);
    for (let i = 0; i < s.well.length; i++) expect(s.well[i]).toBe(0);
  });
  it('starts with no active piece (spawns on first step)', () => {
    const s = initModtrisState({ rng: seededRng(1) });
    expect(s.piece).toBeNull();
  });
  it('starts with a queue of at least 7 upcoming pieces', () => {
    const s = initModtrisState({ rng: seededRng(1) });
    expect(s.queue.length).toBeGreaterThanOrEqual(7);
  });
  it('starts with zero lines cleared', () => {
    const s = initModtrisState({ rng: seededRng(1) });
    expect(s.lines).toBe(0);
  });
});

describe('7-bag randomizer', () => {
  it('first 7 pieces contain every kind exactly once', () => {
    const s = initModtrisState({ rng: seededRng(42) });
    const bag = s.queue.slice(0, 7);
    const seen = new Set<PieceKind>(bag);
    expect(seen.size).toBe(7);
    for (const k of PIECE_KINDS) expect(seen.has(k)).toBe(true);
  });
  it('two different seeds produce different bag orders', () => {
    const a = initModtrisState({ rng: seededRng(1) }).queue.slice(0, 7);
    const b = initModtrisState({ rng: seededRng(99) }).queue.slice(0, 7);
    expect(a).not.toEqual(b);
  });
  it('same seed produces identical bag order (determinism)', () => {
    const a = initModtrisState({ rng: seededRng(7) }).queue.slice(0, 7);
    const b = initModtrisState({ rng: seededRng(7) }).queue.slice(0, 7);
    expect(a).toEqual(b);
  });
});

describe('stepModtrisState — spawn + gravity', () => {
  it('spawns the first piece on the first step', () => {
    const s0 = initModtrisState({ rng: seededRng(1) });
    const s1 = stepModtrisState(s0, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    expect(s1.piece).not.toBeNull();
  });

  it('gravity drops the piece by one row after one second at 60 BPM', () => {
    const s0 = initModtrisState({ rng: seededRng(1) });
    // First step spawns; piece sits at its initial row.
    const s1 = stepModtrisState(s0, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    const initialRow = s1.piece!.row;
    // Now feed exactly 1 s of dt at 60 BPM (= 1 cell/s).
    const s2 = stepModtrisState(s1, NO_INPUTS, BASE_PARAMS, 1.0, { rng: seededRng(1) });
    expect(s2.piece!.row).toBe(initialRow + 1);
  });

  it('higher gravity drops faster', () => {
    const fast: ModtrisParams = { gravityBpm: 240, levelStep: 10 };
    const s0 = initModtrisState({ rng: seededRng(1) });
    const s1 = stepModtrisState(s0, NO_INPUTS, fast, 0.001, { rng: seededRng(1) });
    // At 240 BPM = 4 cells/s, 1 second of dt drops 4 cells.
    const s2 = stepModtrisState(s1, NO_INPUTS, fast, 1.0, { rng: seededRng(1) });
    expect(s2.piece!.row - s1.piece!.row).toBeGreaterThanOrEqual(3);
  });
});

describe('stepModtrisState — horizontal movement', () => {
  it('moveL shifts the piece one column left', () => {
    const s0 = initModtrisState({ rng: seededRng(1) });
    const s1 = stepModtrisState(s0, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    const col0 = s1.piece!.col;
    const s2 = stepModtrisState(
      s1,
      { ...NO_INPUTS, moveL: true },
      BASE_PARAMS,
      0.001,
      { rng: seededRng(1) },
    );
    expect(s2.piece!.col).toBe(col0 - 1);
  });

  it('moveR shifts the piece one column right', () => {
    const s0 = initModtrisState({ rng: seededRng(1) });
    const s1 = stepModtrisState(s0, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    const col0 = s1.piece!.col;
    const s2 = stepModtrisState(
      s1,
      { ...NO_INPUTS, moveR: true },
      BASE_PARAMS,
      0.001,
      { rng: seededRng(1) },
    );
    expect(s2.piece!.col).toBe(col0 + 1);
  });

  it('moveL clamps against the left wall (does not pass through)', () => {
    let s: ModtrisState = initModtrisState({ rng: seededRng(1) });
    s = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    // Hammer moveL many times; piece should clamp at the leftmost legal col.
    for (let i = 0; i < 20; i++) {
      s = stepModtrisState(
        s,
        { ...NO_INPUTS, moveL: true },
        BASE_PARAMS,
        0.001,
        { rng: seededRng(1) },
      );
    }
    // Piece's leftmost actual cell must be at col ≥ 0.
    const cells = pieceCells(s.piece!);
    const minCol = Math.min(...cells.map(([c]) => c));
    expect(minCol).toBeGreaterThanOrEqual(0);
  });

  it('moveR clamps against the right wall', () => {
    let s: ModtrisState = initModtrisState({ rng: seededRng(1) });
    s = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    for (let i = 0; i < 20; i++) {
      s = stepModtrisState(
        s,
        { ...NO_INPUTS, moveR: true },
        BASE_PARAMS,
        0.001,
        { rng: seededRng(1) },
      );
    }
    const cells = pieceCells(s.piece!);
    const maxCol = Math.max(...cells.map(([c]) => c));
    expect(maxCol).toBeLessThanOrEqual(COLS - 1);
  });
});

describe('stepModtrisState — rotation', () => {
  it('rotateR rotates the piece clockwise', () => {
    const s0 = initModtrisState({ rng: seededRng(1) });
    const s1 = stepModtrisState(s0, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    const rot0 = s1.piece!.rotation;
    const s2 = stepModtrisState(
      s1,
      { ...NO_INPUTS, rotateR: true },
      BASE_PARAMS,
      0.001,
      { rng: seededRng(1) },
    );
    // O-piece rotations are all identical to its starting rotation, so the
    // rotation INDEX can advance but cells stay the same. For non-O pieces
    // either rotation advances or stays equal-by-symmetry — either way it's
    // a no-crash + state-consistency check rather than an exact-equality.
    expect(s2.piece!.rotation).toBe((rot0 + 1) % 4);
  });

  it('rotateL rotates the piece counter-clockwise', () => {
    const s0 = initModtrisState({ rng: seededRng(1) });
    const s1 = stepModtrisState(s0, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    const rot0 = s1.piece!.rotation;
    const s2 = stepModtrisState(
      s1,
      { ...NO_INPUTS, rotateL: true },
      BASE_PARAMS,
      0.001,
      { rng: seededRng(1) },
    );
    expect(s2.piece!.rotation).toBe((rot0 + 3) % 4); // -1 mod 4
  });
});

describe('stepModtrisState — hard drop + line clearing', () => {
  it('dropFast snaps the piece to the bottom and locks it', () => {
    const s0 = initModtrisState({ rng: seededRng(1) });
    const s1 = stepModtrisState(s0, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    const s2 = stepModtrisState(
      s1,
      { ...NO_INPUTS, dropFast: true },
      BASE_PARAMS,
      0.001,
      { rng: seededRng(1) },
    );
    // Locked = true, piece cleared (next step will respawn).
    expect(s2.events.locked).toBe(true);
    expect(s2.piece).toBeNull();
    // Some cells in the well are now non-zero (the locked piece).
    const anyOccupied = s2.well.some((v) => v !== 0);
    expect(anyOccupied).toBe(true);
  });

  it('clearLines detects a single full row and removes it', () => {
    const well = new Uint8Array(COLS * ROWS);
    // Fill row ROWS-1 entirely.
    for (let c = 0; c < COLS; c++) well[(ROWS - 1) * COLS + c] = 1;
    const { well: out, linesCleared } = clearLines(well);
    expect(linesCleared).toBe(1);
    // Bottom row now empty (everything compacted down).
    let bottomEmpty = true;
    for (let c = 0; c < COLS; c++) {
      if (out[(ROWS - 1) * COLS + c] !== 0) { bottomEmpty = false; break; }
    }
    expect(bottomEmpty).toBe(true);
  });

  it('clearLines handles a double clear', () => {
    const well = new Uint8Array(COLS * ROWS);
    for (let c = 0; c < COLS; c++) {
      well[(ROWS - 1) * COLS + c] = 1;
      well[(ROWS - 2) * COLS + c] = 1;
    }
    const { linesCleared } = clearLines(well);
    expect(linesCleared).toBe(2);
  });

  it('clearLines handles a triple clear', () => {
    const well = new Uint8Array(COLS * ROWS);
    for (let r = ROWS - 3; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) well[r * COLS + c] = 1;
    }
    const { linesCleared } = clearLines(well);
    expect(linesCleared).toBe(3);
  });

  it('clearLines handles a tetris (4 lines)', () => {
    const well = new Uint8Array(COLS * ROWS);
    for (let r = ROWS - 4; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) well[r * COLS + c] = 1;
    }
    const { linesCleared } = clearLines(well);
    expect(linesCleared).toBe(4);
  });

  it('clearLines preserves a non-full row', () => {
    const well = new Uint8Array(COLS * ROWS);
    for (let c = 0; c < COLS; c++) well[(ROWS - 1) * COLS + c] = 1;
    well[(ROWS - 2) * COLS + 5] = 2; // a single cell in the row above
    const { well: out, linesCleared } = clearLines(well);
    expect(linesCleared).toBe(1);
    // The single cell from row ROWS-2 has now compacted to row ROWS-1.
    expect(out[(ROWS - 1) * COLS + 5]).toBe(2);
  });

  it('hard-drop into a nearly-full row emits a line_cleared event', () => {
    // Build a state where the bottom row is almost full and the active
    // piece is an I-piece horizontally aligned to slot into the open
    // strip. A hard drop locks it and clears the row.
    let s: ModtrisState = initModtrisState({ rng: seededRng(1) });
    s = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    // Fill cols 0..5 of the bottom row, leaving cols 6..9 open.
    const doctored = new Uint8Array(s.well);
    for (const c of [0, 1, 2, 3, 4, 5]) doctored[(ROWS - 1) * COLS + c] = 1;
    // Force the active piece to an I-piece in horizontal rotation 0 at
    // col=3 row=0 — its cells (offset row=1) span cols 3..6. We move it
    // RIGHT 3 times before drop so it ends at cols 6..9, filling the gap.
    s = {
      ...s,
      well: doctored,
      piece: { kind: 'I', rotation: 0, col: 3, row: 0 },
    };
    // Move right 3 times.
    for (let i = 0; i < 3; i++) {
      s = stepModtrisState(
        s,
        { ...NO_INPUTS, moveR: true },
        BASE_PARAMS,
        0.001,
        { rng: seededRng(1) },
      );
    }
    // Hard drop.
    const beforeLines = s.lines;
    s = stepModtrisState(
      s,
      { ...NO_INPUTS, dropFast: true },
      BASE_PARAMS,
      0.001,
      { rng: seededRng(1) },
    );
    expect(s.events.linesCleared).toBe(1);
    expect(s.lines).toBe(beforeLines + 1);
  });
});

describe('stepModtrisState — overfill', () => {
  it('emits overfill + auto-resets when the well is full at spawn', () => {
    // Fill the entire well so the next spawn definitely collides.
    let s: ModtrisState = initModtrisState({ rng: seededRng(1) });
    s = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    // Doctor: fill EVERY cell so the spawn at (col=3, row=0) collides.
    const full = new Uint8Array(COLS * ROWS).fill(1);
    s = { ...s, well: full, piece: null };
    // Step → spawn fails → overfill.
    const s2 = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(1) });
    expect(s2.events.overfill).toBe(true);
    // Board auto-reset (= empty).
    const anyOccupied = s2.well.some((v) => v !== 0);
    expect(anyOccupied).toBe(false);
    expect(s2.lines).toBe(0);
  });
});

// ── THE DIFFICULTY RAMP — the control that used to do NOTHING ──────────────
//
// ⚠ EVERY LEG BELOW FAILS ON THE OLD CODE, which is the point of writing them
// here rather than in the face model test. Before this diff `levelStep` was read
// by nothing: `gravitySecondsPerDrop` took `gravityBpm` alone, `ModtrisState`
// had no `level` field, and the stepper's own type comment said "unused in v1
// stepper but reserved for future scoring" — while `docs.controls.levelStep`
// promised "how many cleared lines it takes to advance a level and ramp the
// difficulty (gravity speeds up each level)". The docs were false in both
// clauses and no gate in the repo could see it.
describe('gravitySecondsPerDrop — the LVL ramp', () => {
  it('level 0 is exactly the un-ramped interval, so an opening game is unchanged', () => {
    // The compatibility leg: everything that ever measured this module measured
    // it at level 0, so level 0 must still be 60/bpm to the last bit.
    expect(gravitySecondsPerDrop(60, 0)).toBe(1);
    expect(gravitySecondsPerDrop(240, 0)).toBe(0.25);
    expect(gravitySecondsPerDrop(30, 0)).toBe(2);
    // …and the default argument is level 0, which is what every pre-existing
    // caller relied on implicitly.
    expect(gravitySecondsPerDrop(60)).toBe(gravitySecondsPerDrop(60, 0));
  });

  it('each level SHORTENS the interval, monotonically', () => {
    let prev = gravitySecondsPerDrop(60, 0);
    for (let lvl = 1; lvl <= 8; lvl++) {
      const now = gravitySecondsPerDrop(60, lvl);
      expect(now, `level ${lvl} must be faster than level ${lvl - 1}`).toBeLessThan(prev);
      prev = now;
    }
    expect(gravitySecondsPerDrop(60, 5)).toBeCloseTo(LEVEL_GRAVITY_FACTOR ** 5, 10);
  });

  it('is FLOORED, so a long run cannot outrun the 25 ms scheduler tick', () => {
    // Without the floor, level 40 at 240 BPM is ~3 microseconds per drop and the
    // gravity `while` loop in one step would run the piece to the floor and lock
    // it every tick — gravity stops being gravity.
    expect(gravitySecondsPerDrop(240, 60)).toBe(MIN_SECONDS_PER_DROP);
    expect(gravitySecondsPerDrop(240, 60)).toBeGreaterThan(0.025);
  });

  it('levelForLines is the ONE definition, and guards a nonsense threshold', () => {
    expect(levelForLines(0, 10)).toBe(0);
    expect(levelForLines(9, 10)).toBe(0);
    expect(levelForLines(10, 10)).toBe(1);
    expect(levelForLines(35, 10)).toBe(3);
    // LVL 1 = a level per line, the steepest the fader can ask for.
    expect(levelForLines(4, 1)).toBe(4);
    // A 0 / negative threshold clamps to 1 rather than dividing by zero.
    expect(levelForLines(4, 0)).toBe(4);
    expect(Number.isFinite(levelForLines(4, -3))).toBe(true);
  });
});

describe('stepModtrisState — the level is DERIVED and it reaches the running game', () => {
  it('a fresh board is level 0', () => {
    const s = initModtrisState({ rng: seededRng(1) });
    expect(s.level).toBe(0);
  });

  it('the level tracks lines / levelStep on the very next step', () => {
    let s: ModtrisState = initModtrisState({ rng: seededRng(4) });
    s = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(4) });
    // Doctor the line count directly — this leg is about the DERIVATION, not
    // about how hard it is to clear 30 rows from a unit test.
    s = { ...s, lines: 30 };
    const next = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(4) });
    expect(next.level).toBe(3);
  });

  it('MOVING THE FADER RE-PRICES THE RAMP IMMEDIATELY, not at the next level-up', () => {
    // The claim `docs.controls.levelStep` makes ("it applies to the RUNNING
    // game"), and the reason the level is re-derived every step rather than
    // accumulated. Same state, two thresholds, one step apart.
    let s: ModtrisState = initModtrisState({ rng: seededRng(5) });
    s = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(5) });
    s = { ...s, lines: 20 };
    const coarse = stepModtrisState(s, NO_INPUTS, { gravityBpm: 60, levelStep: 20 }, 0.001, { rng: seededRng(5) });
    const steep = stepModtrisState(s, NO_INPUTS, { gravityBpm: 60, levelStep: 2 }, 0.001, { rng: seededRng(5) });
    expect(coarse.level).toBe(1);
    expect(steep.level).toBe(10);
  });

  it('THE RAMP CHANGES THE MEASURED DROP INTERVAL — the assertion that fails on the old code', () => {
    // The behavioural half. Two identical boards differing only in `lines`, run
    // with the SAME params for the same simulated time: the one that has cleared
    // enough lines to reach a level must have fallen FURTHER.
    //
    // ⚠ THE PIECE ROW IS THE MEASUREMENT, not the level field — a `level` that is
    // computed and then ignored would pass every leg above.
    function fallenRowsAfter(lines: number, ticks: number): number {
      let s: ModtrisState = initModtrisState({ rng: seededRng(6) });
      s = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(6) });
      s = { ...s, lines, gravityAccumSeconds: 0 };
      const startRow = s.piece!.row;
      for (let i = 0; i < ticks; i++) {
        s = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.025, { rng: seededRng(6) });
        if (!s.piece) break; // locked — stop measuring
      }
      return (s.piece?.row ?? ROWS) - startRow;
    }
    const atLevel0 = fallenRowsAfter(0, 120);
    const atLevel5 = fallenRowsAfter(50, 120);
    expect(atLevel0, 'sanity: gravity moved the piece at all at level 0').toBeGreaterThan(0);
    expect(
      atLevel5,
      `level 5 must drop the piece further in the same 3 s than level 0 does `
        + `(${atLevel5} rows vs ${atLevel0}). Equal means levelStep is inert again.`,
    ).toBeGreaterThan(atLevel0);
  });

  it('NEGATIVE CONTROL: at ZERO lines the LVL fader changes nothing at all', () => {
    // The other half of "sweeping levelStep 1 -> 20 must change the interval
    // after N cleared lines and must NOT change it at zero lines". Without this
    // leg, a ramp keyed on the fader rather than on the line count would pass.
    function rowAfter(levelStep: number): number {
      let s: ModtrisState = initModtrisState({ rng: seededRng(8) });
      s = stepModtrisState(s, NO_INPUTS, { gravityBpm: 60, levelStep }, 0.001, { rng: seededRng(8) });
      for (let i = 0; i < 60; i++) {
        s = stepModtrisState(s, NO_INPUTS, { gravityBpm: 60, levelStep }, 0.025, { rng: seededRng(8) });
      }
      return s.piece?.row ?? -1;
    }
    expect(rowAfter(1)).toBe(rowAfter(20));
  });

  it('an OVERFILL resets the level with the line count', () => {
    let s: ModtrisState = initModtrisState({ rng: seededRng(9) });
    s = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(9) });
    s = { ...s, well: new Uint8Array(COLS * ROWS).fill(1), piece: null, lines: 40, level: 4 };
    const next = stepModtrisState(s, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(9) });
    expect(next.events.overfill).toBe(true);
    expect(next.lines).toBe(0);
    expect(next.level).toBe(0);
  });
});

describe('PIECE_COLOR_INDEX', () => {
  it('has a unique color for every kind', () => {
    const colors = PIECE_KINDS.map((k) => PIECE_COLOR_INDEX[k]);
    expect(new Set(colors).size).toBe(PIECE_KINDS.length);
  });
  it('colors are in 1..7 range (0 reserved for empty)', () => {
    for (const k of PIECE_KINDS) {
      expect(PIECE_COLOR_INDEX[k]).toBeGreaterThanOrEqual(1);
      expect(PIECE_COLOR_INDEX[k]).toBeLessThanOrEqual(7);
    }
  });
});

describe('stepModtrisState — determinism', () => {
  it('two identical input sequences produce identical states (cross-peer sync prereq)', () => {
    const trajectory = Array.from({ length: 50 }, (_, i) => ({
      moveL: i % 7 === 1,
      moveR: i % 5 === 2,
      rotateR: i % 11 === 3,
      rotateL: false,
      dropFast: i % 17 === 5,
    }));
    function runOnce(): ModtrisState {
      let s: ModtrisState = initModtrisState({ rng: seededRng(99) });
      for (const inp of trajectory) {
        s = stepModtrisState(s, inp, BASE_PARAMS, 0.025, { rng: seededRng(99) });
      }
      return s;
    }
    const a = runOnce();
    const b = runOnce();
    expect(a.lines).toBe(b.lines);
    expect(Array.from(a.well)).toEqual(Array.from(b.well));
    expect(a.piece).toEqual(b.piece);
  });
});
