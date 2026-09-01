// The SEQTRIS rules, pinned. Everything the owner specified about the game
// lives in the pure core, so everything the owner specified is asserted here
// rather than through a browser: the modified piece set, rotation as a rigid
// index-preserving transform, the tracked square and its immutability, wall and
// floor collision, line clear + board drop, the divisor ladder, and the
// column→octave / row→descending-major note derivation.
//
// The def shape is in seqtris.test.ts; the real chain in e2e/tests/seqtris.spec.ts.

import { describe, expect, it } from 'vitest';
import { MIN_MIDI, MAX_MIDI } from '$lib/audio/note-entry';
import {
  SEQTRIS_COLS,
  SEQTRIS_ROWS,
  SEQTRIS_CELLS,
  SEQTRIS_PIECE_IDS,
  SEQTRIS_ROTATIONS,
  SEQTRIS_ROW_SEMITONES,
  SEQTRIS_PIECE_RGB,
  SEQTRIS_DEFAULT_DIVISOR,
  applyInput,
  cellIndex,
  clockPulse,
  coalesceSeqtrisNotes,
  createSeqtrisState,
  divisorForLines,
  divisorLadder,
  midiForCell,
  nextDivisor,
  octaveForColumn,
  pickTrackedIndex,
  pieceCells,
  pieceMidi,
  renderBoard,
  rotateCw,
  setBaseDivisor,
  shapeHeight,
  shapeWidth,
  shuffledBag,
  trackedCell,
  type SeqtrisEvent,
  type SeqtrisPieceId,
  type SeqtrisState,
} from './seqtris-engine';

// ────────────────────────── helpers ──────────────────────────

/** Render a rotation state as rows of '#' / '.' so a shape assertion reads as
 *  the shape it is asserting. */
function draw(cells: readonly { row: number; col: number }[]): string[] {
  const h = shapeHeight(cells);
  const w = shapeWidth(cells);
  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => '.'));
  for (const c of cells) grid[c.row]![c.col] = '#';
  return grid.map((r) => r.join(''));
}

/** A board with every cell of the named rows filled EXCEPT the given columns. */
function boardWith(fills: readonly (readonly [number, number])[]): (SeqtrisPieceId | null)[] {
  const b: (SeqtrisPieceId | null)[] = Array.from({ length: SEQTRIS_CELLS }, () => null);
  for (const [r, c] of fills) b[cellIndex(r, c)] = 'o';
  return b;
}

function events(step: { events: readonly SeqtrisEvent[] }, kind: SeqtrisEvent['kind']) {
  return step.events.filter((e) => e.kind === kind);
}

// ────────────────────────── geometry ──────────────────────────

describe('board geometry', () => {
  it('is 8 wide by 8 rows — the Launchpad pad grid exactly', () => {
    expect(SEQTRIS_COLS).toBe(8);
    expect(SEQTRIS_ROWS).toBe(8);
    expect(SEQTRIS_CELLS).toBe(64);
  });

  it('cellIndex is row-major', () => {
    expect(cellIndex(0, 0)).toBe(0);
    expect(cellIndex(0, 7)).toBe(7);
    expect(cellIndex(1, 0)).toBe(8);
    expect(cellIndex(7, 7)).toBe(63);
  });
});

// ────────────────────────── the piece set ──────────────────────────

describe('the piece set — the owner\'s 8x8 modifications', () => {
  it('keeps all seven tetromino names', () => {
    expect([...SEQTRIS_PIECE_IDS]).toEqual(['i', 'o', 't', 's', 'z', 'j', 'l']);
  });

  it('the straight-line piece is TWO cells, not four', () => {
    const cells = SEQTRIS_ROTATIONS.i[0]!;
    expect(cells).toHaveLength(2);
    expect(draw(cells)).toEqual(['##']);
    expect(draw(SEQTRIS_ROTATIONS.i[1]!)).toEqual(['#', '#']);
  });

  it('the L pieces are THREE-cell corners, mirrored at spawn', () => {
    expect(SEQTRIS_ROTATIONS.l[0]!).toHaveLength(3);
    expect(SEQTRIS_ROTATIONS.j[0]!).toHaveLength(3);
    expect(draw(SEQTRIS_ROTATIONS.l[0]!)).toEqual(['#.', '##']);
    expect(draw(SEQTRIS_ROTATIONS.j[0]!)).toEqual(['.#', '##']);
  });

  it('O, T, S and Z keep their standard four-cell shapes', () => {
    expect(draw(SEQTRIS_ROTATIONS.o[0]!)).toEqual(['##', '##']);
    expect(draw(SEQTRIS_ROTATIONS.t[0]!)).toEqual(['###', '.#.']);
    expect(draw(SEQTRIS_ROTATIONS.s[0]!)).toEqual(['.##', '##.']);
    expect(draw(SEQTRIS_ROTATIONS.z[0]!)).toEqual(['##.', '.##']);
  });

  it('EVERY piece in EVERY rotation is 1 to 3 rows tall — the spec\'s stated result', () => {
    for (const id of SEQTRIS_PIECE_IDS) {
      for (let rot = 0; rot < 4; rot++) {
        const h = shapeHeight(SEQTRIS_ROTATIONS[id][rot]!);
        expect(h, `${id} rot${rot}`).toBeGreaterThanOrEqual(1);
        expect(h, `${id} rot${rot}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('no piece is wider than the well', () => {
    for (const id of SEQTRIS_PIECE_IDS) {
      for (let rot = 0; rot < 4; rot++) {
        expect(shapeWidth(SEQTRIS_ROTATIONS[id][rot]!)).toBeLessThanOrEqual(SEQTRIS_COLS);
      }
    }
  });

  it('every piece has a colour', () => {
    for (const id of SEQTRIS_PIECE_IDS) {
      const rgb = SEQTRIS_PIECE_RGB[id];
      expect(rgb).toHaveLength(3);
      for (const c of rgb) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(127); // Launchpad RGB units
      }
    }
  });
});

// ────────────────────────── rotation ──────────────────────────

describe('rotation is a rigid, index-preserving transform', () => {
  it('four clockwise turns return every piece to its spawn shape', () => {
    for (const id of SEQTRIS_PIECE_IDS) {
      const spawn = SEQTRIS_ROTATIONS[id][0]!;
      let cur: readonly { row: number; col: number }[] = spawn;
      for (let k = 0; k < 4; k++) cur = rotateCw(cur);
      expect(cur, id).toEqual(spawn);
    }
  });

  it('rotation preserves the cell COUNT and never reorders the array', () => {
    // The array order IS the cell identity, which is what lets the tracked
    // square be an index. A rotation that sorted its output would silently
    // re-point the tracked square of every piece.
    const cells = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 1 },
    ];
    const turned = rotateCw(cells);
    expect(turned).toHaveLength(4);
    // The T's LEFT arm (index 0) becomes its TOP; index 3 (the stem) stays the
    // middle of the far side.
    expect(draw(turned)).toEqual(['.#', '##', '.#']);
    expect(turned[0]).toEqual({ row: 0, col: 1 });
    expect(turned[3]).toEqual({ row: 1, col: 0 });
  });

  it('a domino rotates between one row and one column', () => {
    expect(draw(rotateCw(SEQTRIS_ROTATIONS.i[0]!))).toEqual(['#', '#']);
  });
});

// ────────────────────────── the tracked square ──────────────────────────

describe('the tracked square', () => {
  it('is the LEFTMOST cell of the top row', () => {
    expect(
      pickTrackedIndex([
        { row: 1, col: 0 },
        { row: 0, col: 3 },
        { row: 0, col: 1 }, // top row, and further left than index 1
        { row: 2, col: 0 },
      ]),
    ).toBe(2);
  });

  it('breaks a 2-square tie leftwards', () => {
    expect(
      pickTrackedIndex([
        { row: 0, col: 5 },
        { row: 0, col: 2 },
      ]),
    ).toBe(1);
  });

  it('breaks a 3-square tie leftwards', () => {
    expect(
      pickTrackedIndex([
        { row: 0, col: 2 },
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 1 },
      ]),
    ).toBe(1);
  });

  it('every spawned piece tracks a cell that IS in its top row', () => {
    for (const id of SEQTRIS_PIECE_IDS) {
      const cells = SEQTRIS_ROTATIONS[id][0]!;
      const idx = pickTrackedIndex(cells);
      expect(cells[idx]!.row, id).toBe(0);
      // …and nothing else in row 0 is further left.
      for (const c of cells) {
        if (c.row === 0) expect(c.col, id).toBeGreaterThanOrEqual(cells[idx]!.col);
      }
    }
  });

  it('NEVER changes for the life of a piece, even when rotation moves it off the bottom', () => {
    let state = createSeqtrisState({ seed: 7, baseDivisor: 4 });
    const initial = state.piece!.trackedIndex;
    for (let i = 0; i < 8; i++) {
      state = applyInput(state, i % 2 === 0 ? 'rotateRight' : 'rotateLeft').state;
      expect(state.piece!.trackedIndex).toBe(initial);
    }
    state = applyInput(state, 'moveLeft').state;
    expect(state.piece!.trackedIndex).toBe(initial);
  });

  it('the tracked square MOVES with the piece as it rotates (it is not pinned to a corner)', () => {
    // A T spawned flat tracks its left arm; a quarter turn puts that arm on top.
    const piece = { id: 't' as const, rot: 0, row: 0, col: 2, trackedIndex: 0 };
    expect(trackedCell(piece)).toEqual({ row: 0, col: 2 });
    expect(trackedCell({ ...piece, rot: 1 })).toEqual({ row: 0, col: 3 });
  });
});

// ────────────────────────── the note derivation ──────────────────────────

describe('note derivation — column is the octave, row is a DESCENDING major scale', () => {
  it('the eight rows are C B A G F E D C', () => {
    expect([...SEQTRIS_ROW_SEMITONES]).toEqual([0, -1, -3, -5, -7, -8, -10, -12]);
  });

  it('a column spans exactly one octave, with a C at BOTH ends', () => {
    for (let col = 0; col < SEQTRIS_COLS; col++) {
      const top = midiForCell(0, col);
      const bottom = midiForCell(7, col);
      expect(top - bottom).toBe(12);
      expect(top % 12).toBe(0); // a C
      expect(bottom % 12).toBe(0);
    }
  });

  it('the leftmost column reaches octave 0 and the rightmost reaches octave 8', () => {
    expect(octaveForColumn(0)).toBe(1);
    expect(octaveForColumn(7)).toBe(8);
    expect(midiForCell(7, 0)).toBe(12); // C0
    expect(midiForCell(0, 7)).toBe(108); // C8
  });

  it('the whole board lands inside the repo\'s legal MIDI range — nothing is ever clamped', () => {
    for (let row = 0; row < SEQTRIS_ROWS; row++) {
      for (let col = 0; col < SEQTRIS_COLS; col++) {
        const m = midiForCell(row, col);
        expect(m, `row ${row} col ${col}`).toBeGreaterThanOrEqual(MIN_MIDI);
        expect(m, `row ${row} col ${col}`).toBeLessThanOrEqual(MAX_MIDI);
      }
    }
  });

  it('a step RIGHT is exactly an octave up; a step DOWN is one scale degree down', () => {
    expect(midiForCell(3, 4) - midiForCell(3, 3)).toBe(12);
    expect(midiForCell(0, 3) - midiForCell(1, 3)).toBe(1); // C → B
    expect(midiForCell(1, 3) - midiForCell(2, 3)).toBe(2); // B → A
  });

  it('C4 (MIDI 60) is reachable — the middle of the board is a playable register', () => {
    expect(midiForCell(0, 3)).toBe(60);
  });

  it('out-of-range coordinates clamp rather than produce a nonsense note', () => {
    expect(midiForCell(-3, -3)).toBe(midiForCell(0, 0));
    expect(midiForCell(99, 99)).toBe(midiForCell(7, 7));
  });
});

// ────────────────────────── the divisor ladder ──────────────────────────

describe('the speed ladder — +10% per line, always a whole number of clock pulses', () => {
  it('a rung is always a REAL speed-up and never below 1', () => {
    for (let d = 1; d <= 64; d++) {
      const n = nextDivisor(d);
      expect(n, `from ${d}`).toBeGreaterThanOrEqual(1);
      if (d > 1) expect(n, `from ${d}`).toBeLessThan(d);
      else expect(n).toBe(1);
    }
  });

  it('approximates +10% wherever the integers allow it', () => {
    // From 24 the first four rungs are within a percent of the ideal 1.1x.
    for (const d of [24, 22, 20, 18, 16, 14, 12]) {
      const ratio = d / nextDivisor(d);
      expect(ratio, `from ${d}`).toBeGreaterThan(1.05);
      expect(ratio, `from ${d}`).toBeLessThan(1.2);
    }
  });

  it('the DEFAULT ladder is 8·7·6·5·4·3·2·1 — eight levels', () => {
    expect([...divisorLadder(SEQTRIS_DEFAULT_DIVISOR)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('a finer clock buys finer rungs', () => {
    expect([...divisorLadder(24)]).toEqual([
      24, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
    ]);
  });

  it('every ladder ends at 1 and strictly decreases', () => {
    for (const base of [1, 2, 3, 5, 8, 13, 24, 48]) {
      const ladder = divisorLadder(base);
      expect(ladder[0]).toBe(Math.max(1, base));
      expect(ladder[ladder.length - 1]).toBe(1);
      for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeLessThan(ladder[i - 1]!);
    }
  });

  it('divisorForLines walks the same ladder', () => {
    const ladder = divisorLadder(24);
    for (let n = 0; n < ladder.length + 3; n++) {
      expect(divisorForLines(24, n)).toBe(ladder[Math.min(n, ladder.length - 1)]);
    }
  });

  it('EVERY divisor is a whole number — the 1:1 clock alignment the spec asks for', () => {
    for (const base of [8, 24, 48]) {
      for (const d of divisorLadder(base)) expect(Number.isInteger(d)).toBe(true);
    }
  });
});

// ────────────────────────── gravity on the clock ──────────────────────────

describe('gravity is counted in clock pulses', () => {
  it('the piece falls exactly once every `divisor` pulses', () => {
    let state = createSeqtrisState({ seed: 3, baseDivisor: 4 });
    const startRow = state.piece!.row;
    for (let i = 0; i < 3; i++) {
      state = clockPulse(state).state;
      expect(state.piece!.row, `after ${i + 1} pulses`).toBe(startRow);
    }
    state = clockPulse(state).state;
    expect(state.piece!.row).toBe(startRow + 1);
  });

  it('a gravity move fires exactly one Piece note at the tracked square', () => {
    let state = createSeqtrisState({ seed: 3, baseDivisor: 1 });
    const step = clockPulse(state);
    state = step.state;
    const notes = events(step, 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'note', cause: 'gravity' });
    const t = trackedCell(state.piece!);
    expect((notes[0] as { midi: number }).midi).toBe(midiForCell(t.row, t.col));
  });

  it('the pulse counter RESETS on a gravity step, so a level change cannot slide off the grid', () => {
    let state = createSeqtrisState({ seed: 3, baseDivisor: 3 });
    state = clockPulse(state).state;
    state = clockPulse(state).state;
    expect(state.pulse).toBe(2);
    state = clockPulse(state).state;
    expect(state.pulse).toBe(0);
  });

  it('changing the base divisor re-derives the current speed and re-zeroes the count', () => {
    let state = createSeqtrisState({ seed: 3, baseDivisor: 8 });
    state = clockPulse(state).state;
    expect(state.pulse).toBe(1);
    state = setBaseDivisor(state, 24);
    expect(state.baseDivisor).toBe(24);
    expect(state.divisor).toBe(24);
    expect(state.pulse).toBe(0);
  });
});

// ────────────────────────── collision ──────────────────────────

describe('walls, floor and stack', () => {
  it('a piece cannot be moved off the LEFT wall', () => {
    let state = createSeqtrisState({ seed: 11, baseDivisor: 8 });
    for (let i = 0; i < 12; i++) state = applyInput(state, 'moveLeft').state;
    expect(Math.min(...pieceCells(state.piece!).map((c) => c.col))).toBe(0);
    // …and a refused move fires NO note.
    const refused = applyInput(state, 'moveLeft');
    expect(refused.events).toHaveLength(0);
    expect(refused.state).toBe(state);
  });

  it('a piece cannot be moved off the RIGHT wall', () => {
    let state = createSeqtrisState({ seed: 11, baseDivisor: 8 });
    for (let i = 0; i < 12; i++) state = applyInput(state, 'moveRight').state;
    expect(Math.max(...pieceCells(state.piece!).map((c) => c.col))).toBe(SEQTRIS_COLS - 1);
    expect(applyInput(state, 'moveRight').events).toHaveLength(0);
  });

  it('a piece LOCKS on the floor and the next one spawns', () => {
    let state = createSeqtrisState({ seed: 5, baseDivisor: 1 });
    let spawnCount = 0;
    for (let i = 0; i < 40; i++) {
      const step = clockPulse(state);
      state = step.state;
      spawnCount += events(step, 'spawn').length;
      if (spawnCount > 0) break;
    }
    expect(spawnCount).toBeGreaterThan(0);
    // Something is resting on the floor row.
    const floor = Array.from({ length: SEQTRIS_COLS }, (_, c) => state.board[cellIndex(7, c)]);
    expect(floor.some((c) => c !== null)).toBe(true);
  });

  it('a rotation that would leave the well is wall-kicked, or refused entirely', () => {
    let state = createSeqtrisState({ seed: 2, baseDivisor: 8 });
    for (let i = 0; i < 12; i++) state = applyInput(state, 'moveRight').state;
    const before = state;
    const after = applyInput(state, 'rotateRight').state;
    // Either it fitted (after a kick) or nothing moved — never a piece hanging
    // outside the board.
    if (after !== before) {
      for (const c of pieceCells(after.piece!)) {
        expect(c.col).toBeGreaterThanOrEqual(0);
        expect(c.col).toBeLessThan(SEQTRIS_COLS);
        expect(c.row).toBeLessThan(SEQTRIS_ROWS);
      }
    }
  });

  it('every reachable state keeps the piece inside the board', () => {
    let state = createSeqtrisState({ seed: 42, baseDivisor: 1 });
    const script = ['moveLeft', 'rotateRight', 'moveRight', 'rotateLeft', 'drop'] as const;
    for (let i = 0; i < 200; i++) {
      state = clockPulse(state).state;
      state = applyInput(state, script[i % script.length]!).state;
      if (!state.piece) continue;
      for (const c of pieceCells(state.piece)) {
        expect(c.row).toBeGreaterThanOrEqual(0);
        expect(c.row).toBeLessThan(SEQTRIS_ROWS);
        expect(c.col).toBeGreaterThanOrEqual(0);
        expect(c.col).toBeLessThan(SEQTRIS_COLS);
      }
    }
  });
});

// ────────────────────────── notes on movement ──────────────────────────

describe('the Piece output fires on movement', () => {
  it('a sideways move fires a note an OCTAVE away from the last one', () => {
    let state = createSeqtrisState({ seed: 9, baseDivisor: 8 });
    const before = pieceMidi(state.piece!);
    const step = applyInput(state, 'moveRight');
    state = step.state;
    const notes = events(step, 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ cause: 'move' });
    expect((notes[0] as { midi: number }).midi - before).toBe(12);
  });

  it('a rotation fires a note', () => {
    const state = createSeqtrisState({ seed: 9, baseDivisor: 8 });
    const step = applyInput(state, 'rotateRight');
    if (step.state !== state) {
      expect(events(step, 'note')).toHaveLength(1);
      expect(events(step, 'note')[0]).toMatchObject({ cause: 'rotate' });
    }
  });

  it('a SPAWN fires a note too, so the top row (a C) is always heard', () => {
    const state = createSeqtrisState({ seed: 4, baseDivisor: 1 });
    const step = applyInput(state, 'reset');
    const notes = events(step, 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ cause: 'spawn', row: 0 });
    expect((notes[0] as { midi: number }).midi % 12).toBe(0); // a C
  });
});

// ────────────────────────── the hard drop ──────────────────────────

describe('the hard drop is ONE tied gate carrying every row it falls through', () => {
  it('emits a single tie event, not a burst of notes', () => {
    const state = createSeqtrisState({ seed: 6, baseDivisor: 8 });
    const step = applyInput(state, 'drop');
    const ties = events(step, 'tie');
    expect(ties).toHaveLength(1);
    // Only the NEXT piece's spawn note is a plain note; the fall itself is not.
    const notes = events(step, 'note');
    expect(notes.every((n) => (n as { cause: string }).cause === 'spawn')).toBe(true);
  });

  it('the tie carries the note of EVERY row traversed, in order, resting row last', () => {
    const state = createSeqtrisState({ seed: 6, baseDivisor: 8 });
    const before = state.piece!;
    const t0 = trackedCell(before);
    const step = applyInput(state, 'drop');
    const tie = events(step, 'tie')[0] as { midis: readonly number[] };
    expect(tie.midis.length).toBeGreaterThan(0);
    for (let i = 0; i < tie.midis.length; i++) {
      expect(tie.midis[i]).toBe(midiForCell(t0.row + 1 + i, t0.col));
    }
    // Descending rows = descending pitch.
    for (let i = 1; i < tie.midis.length; i++) {
      expect(tie.midis[i]!).toBeLessThan(tie.midis[i - 1]!);
    }
  });

  it('locks the piece and spawns the next one', () => {
    const state = createSeqtrisState({ seed: 6, baseDivisor: 8 });
    const step = applyInput(state, 'drop');
    expect(events(step, 'spawn')).toHaveLength(1);
    expect(step.state.piece).not.toBeNull();
    expect(step.state.piece!.row).toBe(0);
  });

  it('a piece already resting on the floor drops with no tie at all', () => {
    // Fill everything under row 0 so the spawned piece cannot move.
    const fills: [number, number][] = [];
    for (let r = 2; r < SEQTRIS_ROWS; r++) {
      for (let c = 0; c < SEQTRIS_COLS; c++) fills.push([r, c]);
    }
    const base = createSeqtrisState({ seed: 8, baseDivisor: 8 });
    const state: SeqtrisState = { ...base, board: boardWith(fills) };
    const step = applyInput(state, 'drop');
    expect(events(step, 'tie')).toHaveLength(0);
  });
});

// ────────────────────────── line clears ──────────────────────────

describe('line clears', () => {
  /** Board with the floor row filled except one column, and a domino aimed at it. */
  function almostFullFloor(gapCol: number): SeqtrisState {
    const fills: [number, number][] = [];
    for (let c = 0; c < SEQTRIS_COLS; c++) if (c !== gapCol) fills.push([7, c]);
    const base = createSeqtrisState({ seed: 1, baseDivisor: 8 });
    return {
      ...base,
      board: boardWith(fills),
      piece: { id: 'i', rot: 1, row: 0, col: gapCol, trackedIndex: 0 },
    };
  }

  it('fires ONE line event per cleared row and drops the stack', () => {
    const state = almostFullFloor(3);
    const step = applyInput(state, 'drop');
    const lines = events(step, 'line');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'line', row: 7 });
    // The floor is empty again and the leftover domino cell fell to it.
    const floor = Array.from({ length: SEQTRIS_COLS }, (_, c) => step.state.board[cellIndex(7, c)]);
    expect(floor.filter((c) => c !== null)).toHaveLength(1);
  });

  it('counts the line and steps the divisor down one rung', () => {
    const state = almostFullFloor(3);
    expect(state.divisor).toBe(8);
    const step = applyInput(state, 'drop');
    expect(step.state.lines).toBe(1);
    expect(step.state.totalLines).toBe(1);
    expect(step.state.divisor).toBe(7);
  });

  it('a DOUBLE clear fires twice and steps the ladder twice', () => {
    const fills: [number, number][] = [];
    for (let c = 0; c < SEQTRIS_COLS; c++) {
      if (c !== 3) {
        fills.push([6, c]);
        fills.push([7, c]);
      }
    }
    const base = createSeqtrisState({ seed: 1, baseDivisor: 24 });
    const state: SeqtrisState = {
      ...base,
      board: boardWith(fills),
      piece: { id: 'i', rot: 1, row: 0, col: 3, trackedIndex: 0 }, // vertical domino
    };
    const step = applyInput(state, 'drop');
    expect(events(step, 'line')).toHaveLength(2);
    expect(step.state.lines).toBe(2);
    expect(step.state.divisor).toBe(divisorForLines(24, 2));
  });

  it('the board keeps its size and the cleared rows arrive from the TOP as empties', () => {
    const step = applyInput(almostFullFloor(3), 'drop');
    expect(step.state.board).toHaveLength(SEQTRIS_CELLS);
    for (let c = 0; c < SEQTRIS_COLS; c++) {
      expect(step.state.board[cellIndex(0, c)]).toBeNull();
    }
  });
});

// ────────────────────────── stack-out ──────────────────────────

describe('stack-out', () => {
  /**
   * A well stacked to the ceiling everywhere except a two-column chimney on the
   * left. ⚠ THE TWO EMPTY COLUMNS ARE LOAD-BEARING, not decoration: with only
   * ONE empty column, dropping the domino down it COMPLETES the row it lands on
   * and the board clears instead of stacking out — which is what this fixture
   * got wrong first, and it made the test assert a seven-line clear while
   * claiming to assert a game over.
   */
  function fullBoard(): SeqtrisState {
    const fills: [number, number][] = [];
    for (let r = 0; r < SEQTRIS_ROWS - 1; r++) {
      for (let c = 2; c < SEQTRIS_COLS; c++) fills.push([r, c]);
    }
    const base = createSeqtrisState({ seed: 1, baseDivisor: 4 });
    return {
      ...base,
      board: boardWith(fills),
      piece: { id: 'i', rot: 1, row: 0, col: 0, trackedIndex: 0 }, // vertical, down the chimney
      lines: 3,
      divisor: divisorForLines(4, 3),
    };
  }

  it('auto-resets the board and fires NO line event — nothing was cleared', () => {
    const step = applyInput(fullBoard(), 'drop');
    expect(events(step, 'gameover')).toHaveLength(1);
    expect(events(step, 'line')).toHaveLength(0);
    // The stack is gone — only the freshly spawned piece is on the rendered board.
    expect(step.state.board.every((c) => c === null)).toBe(true);
    expect(step.state.gameOvers).toBe(1);
  });

  it('resets the speed ladder to the base divisor', () => {
    const step = applyInput(fullBoard(), 'drop');
    expect(step.state.lines).toBe(0);
    expect(step.state.divisor).toBe(step.state.baseDivisor);
  });

  it('spawns a fresh piece — the module never enters a dead state', () => {
    const step = applyInput(fullBoard(), 'drop');
    expect(events(step, 'spawn')).toHaveLength(1);
    expect(step.state.piece).not.toBeNull();
  });
});

// ────────────────────────── reset ──────────────────────────

describe('the RESET control', () => {
  it('empties the board, zeroes the level and spawns', () => {
    let state = createSeqtrisState({ seed: 12, baseDivisor: 8 });
    for (let i = 0; i < 60; i++) state = clockPulse(state).state;
    const step = applyInput(state, 'reset');
    expect(step.state.board.every((c) => c === null)).toBe(true);
    expect(step.state.lines).toBe(0);
    expect(step.state.divisor).toBe(step.state.baseDivisor);
    expect(events(step, 'spawn')).toHaveLength(1);
  });
});

// ────────────────────────── determinism ──────────────────────────

describe('determinism', () => {
  it('the same seed and the same inputs give the same game, exactly', () => {
    function run(seed: number): string {
      let state = createSeqtrisState({ seed, baseDivisor: 3 });
      const trail: string[] = [];
      const script = ['moveLeft', 'rotateRight', 'drop', 'moveRight'] as const;
      for (let i = 0; i < 120; i++) {
        const a = clockPulse(state);
        state = a.state;
        const b = applyInput(state, script[i % script.length]!);
        state = b.state;
        for (const e of [...a.events, ...b.events]) trail.push(JSON.stringify(e));
      }
      return trail.join('|');
    }
    expect(run(99)).toBe(run(99));
    expect(run(99)).not.toBe(run(100));
  });

  it('the 7-bag is a permutation of the seven pieces', () => {
    for (const seed of [0, 1, 12345, 0x7fffffff]) {
      const { bag } = shuffledBag(seed);
      expect([...bag].sort()).toEqual([...SEQTRIS_PIECE_IDS].sort());
    }
  });

  it('a fresh module always opens on the same piece — what makes the e2e able to name it', () => {
    expect(createSeqtrisState().piece!.id).toBe(createSeqtrisState().piece!.id);
  });

  it('reset draws from the CONTINUING bag, so a replay is not the same game', () => {
    const a = createSeqtrisState({ seed: 21, baseDivisor: 8 });
    const first = a.piece!.id;
    let seen = first;
    let state = a;
    for (let i = 0; i < 7 && seen === first; i++) {
      state = applyInput(state, 'reset').state;
      seen = state.piece!.id;
    }
    expect(seen).not.toBe(first);
  });
});

// ────────────────────────── one pulse, one note ──────────────────────────

describe('coalesceSeqtrisNotes — a clock pulse produces ONE audible note', () => {
  const note = (midi: number): SeqtrisEvent =>
    ({ kind: 'note', midi, row: 0, col: 0, cause: 'move' }) as SeqtrisEvent;

  it('keeps only the LAST note of a batch — the earlier ones are overwritten at the same instant', () => {
    const out = coalesceSeqtrisNotes([note(60), note(72), note(84)]);
    expect(out).toHaveLength(1);
    expect((out[0] as { midi: number }).midi).toBe(84);
  });

  it('never drops a gate — those are different ports and all really happened', () => {
    const out = coalesceSeqtrisNotes([
      note(60),
      { kind: 'line', row: 7 },
      { kind: 'line', row: 6 },
      { kind: 'spawn', piece: 'i' },
      note(72),
    ]);
    expect(out.filter((e) => e.kind === 'line')).toHaveLength(2);
    expect(out.filter((e) => e.kind === 'spawn')).toHaveLength(1);
    expect(out.filter((e) => e.kind === 'note')).toHaveLength(1);
  });

  it('a TIE splits the batch — a note before it and a note after it are two real sounds', () => {
    const out = coalesceSeqtrisNotes([
      note(60),
      { kind: 'tie', midis: [59, 57] },
      note(72),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['note', 'tie', 'note']);
    expect((out[0] as { midi: number }).midi).toBe(60);
    expect((out[2] as { midi: number }).midi).toBe(72);
  });

  it('is a no-op on a batch that has nothing to collapse', () => {
    const batch: SeqtrisEvent[] = [{ kind: 'spawn', piece: 't' }, note(60)];
    expect(coalesceSeqtrisNotes(batch)).toEqual(batch);
  });

  it('is total on an empty batch', () => {
    expect(coalesceSeqtrisNotes([])).toEqual([]);
  });

  it('a real drop batch keeps its tie AND the following spawn note', () => {
    const state = createSeqtrisState({ seed: 6, baseDivisor: 8 });
    const out = coalesceSeqtrisNotes(applyInput(state, 'drop').events);
    expect(out.filter((e) => e.kind === 'tie')).toHaveLength(1);
    expect(out.filter((e) => e.kind === 'note')).toHaveLength(1);
    expect(out.filter((e) => e.kind === 'spawn')).toHaveLength(1);
  });
});

// ────────────────────────── rendering ──────────────────────────

describe('renderBoard', () => {
  it('overlays the falling piece onto the landed stack', () => {
    const state = createSeqtrisState({ seed: 15, baseDivisor: 8 });
    const rendered = renderBoard(state);
    expect(rendered).toHaveLength(SEQTRIS_CELLS);
    for (const c of pieceCells(state.piece!)) {
      expect(rendered[cellIndex(c.row, c.col)]).toBe(state.piece!.id);
    }
    // …without mutating the stored board.
    expect(state.board.every((c) => c === null)).toBe(true);
  });
});
