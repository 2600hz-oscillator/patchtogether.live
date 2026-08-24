// packages/web/src/lib/audio/modules/kria-types.test.ts
//
// Golden tests for KRIA's PURE step model — step advance (forward / reverse /
// pingpong / drunk / random), loop windows, scale → V/oct note mapping, pattern
// cue quantize, and coercion. No AudioContext, no Y.Doc.

import { describe, it, expect } from 'vitest';
import { midiToVOct } from '$lib/audio/note-entry';
import {
  defaultTrack,
  defaultPattern,
  defaultKriaData,
  coerceTrack,
  coercePattern,
  activePattern,
  patternAt,
  slotOccupied,
  stepMidi,
  stepVOct,
  loopWindow,
  initialCursor,
  advanceStep,
  willWrap,
  tickCue,
  toggleTrig,
  setNote,
  setOctave,
  setDuration,
  applyLaneEdit,
  laneCellName,
  laneRowActive,
  laneRowLit,
  laneRowsUsed,
  laneStepText,
  laneValueForRow,
  KRIA_EDIT_ROWS,
  KRIA_GLIDE_MAX,
  KRIA_LANES,
  KRIA_PROBABILITY_LEVELS,
  KRIA_TRACKS,
  KRIA_STEPS,
  type KriaTrack,
  type CueState,
} from './kria-types';

describe('kria-types: defaults + coercion', () => {
  it('a default track has KRIA_STEPS-length arrays + sane defaults', () => {
    const t = defaultTrack();
    expect(t.trig).toHaveLength(KRIA_STEPS);
    expect(t.note).toHaveLength(KRIA_STEPS);
    expect(t.trig.every((v) => v === false)).toBe(true);
    expect(t.loopLength).toBe(KRIA_STEPS);
    expect(t.direction).toBe('forward');
  });
  it('a default pattern has 4 tracks + a major scale', () => {
    const p = defaultPattern();
    expect(p.tracks).toHaveLength(KRIA_TRACKS);
    expect(p.scale).toBe('major');
  });
  it('defaultKriaData seeds slot 0 only (string-keyed bank)', () => {
    const d = defaultKriaData();
    expect(d.patterns!['0']).not.toBeNull();
    expect(d.patterns!['1']).toBeUndefined();
    expect(slotOccupied(d, 0)).toBe(true);
    expect(slotOccupied(d, 1)).toBe(false);
    expect(d.active).toBe(0);
  });
  it('coerceTrack normalizes ragged/invalid arrays + clamps', () => {
    const t = coerceTrack({
      trig: [true, 1, 0, 'x'], // short + mixed truthiness
      note: [99, -5, 3],
      octave: [9, -1],
      duration: [2, -1, 0.4],
      loopLength: 999,
      timeDivision: 5, // not a valid division → 1
      direction: 'sideways', // invalid → forward
    });
    expect(t.trig.slice(0, 4)).toEqual([true, true, false, true]);
    expect(t.trig).toHaveLength(KRIA_STEPS);
    expect(t.note[0]).toBe(35); // clamped to max degree
    expect(t.note[1]).toBe(0); // clamped to min
    expect(t.octave[0]).toBe(5);
    expect(t.octave[1]).toBe(0);
    expect(t.duration[0]).toBe(1);
    expect(t.duration[1]).toBe(0);
    expect(t.loopLength).toBe(KRIA_STEPS);
    expect(t.timeDivision).toBe(1);
    expect(t.direction).toBe('forward');
  });
  it('coercePattern returns null for junk + a full pattern for an object', () => {
    expect(coercePattern(null)).toBeNull();
    expect(coercePattern(42)).toBeNull();
    const p = coercePattern({ scale: 'minor', root: 60, tracks: [] });
    expect(p).not.toBeNull();
    expect(p!.tracks).toHaveLength(KRIA_TRACKS);
    expect(p!.scale).toBe('minor');
    expect(p!.root).toBe(60);
  });
  it('activePattern + patternAt read the right slot', () => {
    const d = defaultKriaData();
    d.active = 0;
    expect(activePattern(d)).not.toBeNull();
    expect(patternAt(d, 1)).toBeNull();
    expect(patternAt(d, 0)).not.toBeNull();
  });
});

describe('kria-types: scale → V/oct note mapping', () => {
  it('degree 0 octave 0 maps to the root (major)', () => {
    const p = defaultPattern(); // root 48 (C3), major
    const t = setNote(defaultTrack(), 0, 0);
    expect(stepMidi(p, t, 0)).toBe(48);
    expect(stepVOct(p, t, 0)).toBeCloseTo(midiToVOct(48), 6);
  });
  it('major degrees follow [0,2,4,5,7,9,11]', () => {
    const p = defaultPattern();
    const t = defaultTrack();
    const expected = [0, 2, 4, 5, 7, 9, 11].map((s) => 48 + s);
    for (let d = 0; d < 7; d++) {
      const tt = setNote(t, 0, d);
      expect(stepMidi(p, tt, 0)).toBe(expected[d]);
    }
  });
  it('degree wraps into the next scale octave (degree 7 = +12)', () => {
    const p = defaultPattern();
    const t = setNote(defaultTrack(), 0, 7); // 7 degrees in major → octave up, degree 0
    expect(stepMidi(p, t, 0)).toBe(48 + 12);
  });
  it('OCTAVE offset adds whole octaves on top', () => {
    const p = defaultPattern();
    let t = setNote(defaultTrack(), 0, 0);
    t = setOctave(t, 0, 2);
    expect(stepMidi(p, t, 0)).toBe(48 + 24); // MIDI 72 = C5 = +1 V/oct
    expect(stepVOct(p, t, 0)).toBeCloseTo(1, 6);
  });
  it('pentatonic uses only [0,2,4,7,9]', () => {
    const p = { ...defaultPattern(), scale: 'pentatonic' as const };
    const t = defaultTrack();
    const expected = [0, 2, 4, 7, 9].map((s) => 48 + s);
    for (let d = 0; d < 5; d++) {
      expect(stepMidi(p, setNote(t, 0, d), 0)).toBe(expected[d]);
    }
  });
});

describe('kria-types: loop window', () => {
  it('full loop = all 16 steps in order', () => {
    expect(loopWindow(defaultTrack())).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });
  it('a sub-loop wraps past the end', () => {
    const t: KriaTrack = { ...defaultTrack(), loopStart: 14, loopLength: 4 };
    expect(loopWindow(t)).toEqual([14, 15, 0, 1]);
  });
});

describe('kria-types: direction step advance', () => {
  function walk(track: KriaTrack, n: number, rng?: () => number): number[] {
    let cur = initialCursor(track);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = advanceStep(track, cur, rng);
      out.push(r.step);
      cur = r.cursor;
    }
    return out;
  }
  it('forward advances 0→1→2…→0 within a 4-step loop', () => {
    const t: KriaTrack = { ...defaultTrack(), loopLength: 4, direction: 'forward' };
    expect(walk(t, 5)).toEqual([1, 2, 3, 0, 1]);
  });
  it('reverse counts down, wrapping', () => {
    const t: KriaTrack = { ...defaultTrack(), loopLength: 4, direction: 'reverse' };
    expect(walk(t, 5)).toEqual([3, 2, 1, 0, 3]);
  });
  it('pingpong bounces off the ends without repeating the endpoints', () => {
    const t: KriaTrack = { ...defaultTrack(), loopLength: 4, direction: 'pingpong' };
    // start pos 0 → 1,2,3 then bounce back 2,1,0 then forward 1,2,3...
    expect(walk(t, 8)).toEqual([1, 2, 3, 2, 1, 0, 1, 2]);
  });
  it('drunk stays within the loop window (±1 walk)', () => {
    const t: KriaTrack = { ...defaultTrack(), loopStart: 4, loopLength: 4, direction: 'drunk' };
    const seq = walk(t, 50, mulberry(7));
    for (const s of seq) expect([4, 5, 6, 7]).toContain(s);
  });
  it('random stays within the loop window', () => {
    const t: KriaTrack = { ...defaultTrack(), loopStart: 8, loopLength: 4, direction: 'random' };
    const seq = walk(t, 50, mulberry(3));
    for (const s of seq) expect([8, 9, 10, 11]).toContain(s);
  });
  it('willWrap flags the forward loop boundary', () => {
    const t: KriaTrack = { ...defaultTrack(), loopLength: 4, direction: 'forward' };
    let cur = initialCursor(t); // pos 0
    // pos 0,1,2 → not the wrap; pos 3 → next advance wraps to 0.
    const wraps: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      wraps.push(willWrap(t, cur));
      cur = advanceStep(t, cur).cursor;
    }
    expect(wraps).toEqual([false, false, false, true]);
  });
});

describe('kria-types: pattern-cue quantize', () => {
  it('cueSteps=0 switches on the next loop boundary', () => {
    let s: CueState = { active: 0, cued: 3, countdown: 0 };
    let r = tickCue(s, 0, false); // mid-loop — no switch
    expect(r.switched).toBe(false);
    expect(r.state.active).toBe(0);
    s = r.state;
    r = tickCue(s, 0, true); // boundary — switch
    expect(r.switched).toBe(true);
    expect(r.state.active).toBe(3);
    expect(r.state.cued).toBeNull();
  });
  it('cueSteps>0 counts down then switches', () => {
    let s: CueState = { active: 0, cued: 5, countdown: 3 };
    for (let i = 0; i < 2; i++) {
      const r = tickCue(s, 3, false);
      expect(r.switched).toBe(false);
      s = r.state;
    }
    const fin = tickCue(s, 3, false);
    expect(fin.switched).toBe(true);
    expect(fin.state.active).toBe(5);
  });
  it('no cue → never switches', () => {
    const s: CueState = { active: 2, cued: null, countdown: 0 };
    expect(tickCue(s, 0, true).switched).toBe(false);
  });
});

describe('kria-types: edit helpers are immutable', () => {
  it('toggleTrig/setNote/setOctave/setDuration return new tracks', () => {
    const t = defaultTrack();
    const a = toggleTrig(t, 3);
    expect(a).not.toBe(t);
    expect(a.trig[3]).toBe(true);
    expect(t.trig[3]).toBe(false); // original untouched

    const b = setNote(t, 2, 4);
    expect(b.note[2]).toBe(4);
    expect(t.note[2]).toBe(0);

    const c = setOctave(t, 1, 3);
    expect(c.octave[1]).toBe(3);

    const d = setDuration(t, 0, 0.25);
    expect(d.duration[0]).toBeCloseTo(0.25, 6);
  });
});

// ---------------------------------------------------------------------------
// THE STEP-EDITOR GRID MODEL — and the octave defect it closes
// ---------------------------------------------------------------------------
describe('kria grid model: rows are in BIJECTION with values', () => {
  /**
   * ⚠ THE PROPERTY THAT WAS FALSE, and it is stated as a property rather than
   * as a row number so it cannot be satisfied by patching one case.
   *
   * A row a user can CLICK must be a row that can SHOW what the click did.
   * `KriaCard.svelte` computed the octave page's clicked value as
   * `Math.min(5, 6 - row)` and lit it with `6 - row <= oct`: rows 0 and 1 both
   * wrote octave 5, and octave 5 lit rows 1..6 — so row 0 accepted clicks
   * forever and never once displayed its own state. Written this way the test
   * fails for ANY lane that grows a click target it cannot paint.
   */
  /**
   * DENY BY DEFAULT with ONE named exemption carrying its reason.
   *
   * `trig` is a single boolean per COLUMN, not a value per row: clicking
   * anywhere in the column toggles it and the BOTTOM row reports the result.
   * The click therefore has a visible consequence — which is the thing the
   * octave defect lacked — but it is not "row R lights row R". It is exempt
   * from the row-lights-itself form and carries a stronger, positive assertion
   * of its own below, so the exemption costs no coverage.
   */
  const NOT_ROW_ADDRESSED: Readonly<Record<string, string>> = {
    trig: 'one boolean per column; the consequence shows on the bottom row (asserted separately)',
  };

  it('every ACTIVE row, once clicked, lights that row — for every value lane', () => {
    const offenders: string[] = [];
    for (const { id: lane } of KRIA_LANES) {
      if (NOT_ROW_ADDRESSED[lane]) continue;
      for (let row = 0; row < KRIA_EDIT_ROWS; row++) {
        if (!laneRowActive(lane, row)) continue;
        for (const step of [0, 7, 15]) {
          const next = applyLaneEdit(lane, defaultTrack(), step, row);
          expect(next, `${lane} row ${row}: an active row must write something`).not.toBeNull();
          if (!laneRowLit(lane, next!, step, row)) {
            offenders.push(`${lane}: clicking row ${row} (step ${step}) did not light row ${row}`);
          }
        }
      }
    }
    expect(offenders, 'a click target that cannot show its own result').toEqual([]);
  });

  it('…and the exemption is ANCHORED — every exempt lane still exists', () => {
    // A named exemption for a lane that no longer exists is RED, so the list
    // cannot outlive its subject.
    for (const lane of Object.keys(NOT_ROW_ADDRESSED)) {
      expect(
        KRIA_LANES.map((l) => String(l.id)),
        `exempt lane '${lane}' is not a declared lane`,
      ).toContain(lane);
    }
  });

  it('TRIG (the exempt lane): a click anywhere in the column moves the bottom row', () => {
    for (let row = 0; row < KRIA_EDIT_ROWS; row++) {
      expect(laneRowActive('trig', row), `trig row ${row} must be clickable`).toBe(true);
      const on = applyLaneEdit('trig', defaultTrack(), 6, row)!;
      expect(on.trig[6], `clicking trig row ${row} set the step`).toBe(true);
      expect(
        laneRowLit('trig', on, 6, KRIA_EDIT_ROWS - 1),
        `clicking trig row ${row} lit the bottom row`,
      ).toBe(true);
      // …and the click is a TOGGLE: clicking again clears it.
      expect(applyLaneEdit('trig', on, 6, row)!.trig[6]).toBe(false);
    }
  });

  it('every INACTIVE row is inert — no value, no edit, never lit', () => {
    const offenders: string[] = [];
    for (const { id: lane } of KRIA_LANES) {
      for (let row = 0; row < KRIA_EDIT_ROWS; row++) {
        if (laneRowActive(lane, row)) continue;
        if (laneValueForRow(lane, row) !== null) offenders.push(`${lane} row ${row}: has a value`);
        if (applyLaneEdit(lane, defaultTrack(), 0, row) !== null)
          offenders.push(`${lane} row ${row}: edited the track`);
        if (laneRowLit(lane, defaultTrack(), 0, row)) offenders.push(`${lane} row ${row}: lit`);
      }
    }
    expect(offenders, 'an inert row must be inert in all three directions').toEqual([]);
  });

  it('OCTAVE: row 0 is inert and rows 1..6 map onto octaves 5..0 one-to-one', () => {
    // The regression test for the shipped defect, named concretely so the diff
    // is legible next to the property above.
    expect(laneRowActive('octave', 0)).toBe(false);
    const written = new Set<number>();
    for (let row = 1; row <= 6; row++) {
      const v = laneValueForRow('octave', row);
      expect(v, `octave row ${row}`).toBe(6 - row);
      written.add(v!);
    }
    expect(written.size, 'six rows wrote six DISTINCT octaves (rows 0+1 both wrote 5)').toBe(6);
    expect([...written].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('PROBABILITY quantises to the four declared levels and nothing between', () => {
    const seen = new Set<number>();
    for (let row = 0; row < KRIA_EDIT_ROWS; row++) {
      if (!laneRowActive('probability', row)) continue;
      seen.add(laneValueForRow('probability', row)!);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...KRIA_PROBABILITY_LEVELS].sort((a, b) => a - b));
    // …and the three unused rows are not aliased onto a level (§6.4's warning).
    expect(laneRowsUsed('probability')).toBe(KRIA_PROBABILITY_LEVELS.length);
  });

  it('RATCHET spans exactly 1..KRIA_RATCHET_MAX', () => {
    const seen: number[] = [];
    for (let row = 0; row < KRIA_EDIT_ROWS; row++) {
      if (laneRowActive('ratchet', row)) seen.push(laneValueForRow('ratchet', row)!);
    }
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('GLIDE reaches 0 and the declared ceiling, and never exceeds it', () => {
    const vals: number[] = [];
    for (let row = 0; row < KRIA_EDIT_ROWS; row++) vals.push(laneValueForRow('glide', row)!);
    expect(Math.min(...vals)).toBe(0);
    expect(Math.max(...vals)).toBeCloseTo(KRIA_GLIDE_MAX, 9);
    // The ceiling is the SAME bound coerceTrack clamps to — imported, never
    // re-typed, so the editor cannot offer a value the model would clamp away.
    const t = applyLaneEdit('glide', defaultTrack(), 0, 0)!;
    expect(coerceTrack(t).glide[0]).toBeCloseTo(KRIA_GLIDE_MAX, 9);
  });

  it('a lane edit touches ONLY its own lane and only the clicked step', () => {
    const before = defaultTrack();
    const after = applyLaneEdit('note', before, 5, 2)!;
    expect(after.note[5]).toBe(4);
    expect(after.note.filter((n) => n !== 0)).toHaveLength(1);
    for (const lane of ['trig', 'octave', 'duration', 'probability', 'glide', 'ratchet'] as const) {
      expect(JSON.stringify(after[lane]), `${lane} moved`).toBe(JSON.stringify(before[lane]));
    }
  });

  it('laneStepText speaks the value — the only readable form on a faceplate', () => {
    // The face paints no resting derived text, so this string IS the coverage
    // for per-step state. Each lane must say something DIFFERENT for two
    // different values, or the accessible name is decoration.
    const t = defaultTrack();
    for (const { id: lane } of KRIA_LANES) {
      const low = applyLaneEdit(lane, t, 0, KRIA_EDIT_ROWS - 1)!;
      const highRow = laneRowActive(lane, 0) ? 0 : KRIA_EDIT_ROWS - laneRowsUsed(lane);
      const high = applyLaneEdit(lane, t, 0, highRow)!;
      if (lane === 'trig') continue; // one boolean; covered by on/off below
      expect(
        laneStepText(lane, low, 0),
        `${lane}: the extremes must not read the same`,
      ).not.toBe(laneStepText(lane, high, 0));
    }
    expect(laneStepText('trig', toggleTrig(t, 0), 0)).toBe('on');
    expect(laneStepText('trig', t, 0)).toBe('off');
  });

  it('laneCellName is PAGE-DEPENDENT — the card said "step 5 row 2" on every page', () => {
    const names = KRIA_LANES.map(({ id }) => laneCellName(id, 4, 5));
    expect(new Set(names).size, 'seven lanes must not share one accessible name').toBe(names.length);
    for (const n of names) expect(n).toContain('step 5');
  });
});

// Deterministic RNG for drunk/random tests.
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
