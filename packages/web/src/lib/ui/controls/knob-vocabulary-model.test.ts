// packages/web/src/lib/ui/controls/knob-vocabulary-model.test.ts
//
// The PF-1 / PF-3 / PF-10 readout + detent resolvers. The interesting cases are
// all "what does the dial say when the value is NOT where the roster expected
// it" — an off-detent save, a value exactly between two waypoints, an empty
// roster — because those are the ones a live rack actually produces.

import { describe, expect, it } from 'vitest';
import {
  knobMarks,
  knobNameReadout,
  knobReadout,
  knobValueReadout,
  nearestByValue,
} from './knob-vocabulary-model';
import { knobValueToFrac } from './knob-conic-model';

const MODES = [
  { value: 0, label: 'LP' },
  { value: 1, label: 'HP' },
  { value: 2, label: 'BP' },
] as const;

const SHAPES = [
  { value: 0, label: 'TRI' },
  { value: 1, label: 'SAW' },
  { value: 2, label: 'SQR' },
] as const;

describe('nearestByValue', () => {
  it('finds the exact entry', () => {
    expect(nearestByValue(1, MODES)?.label).toBe('HP');
  });

  it('finds the nearest entry for an off-detent value', () => {
    expect(nearestByValue(0.6, MODES)?.label).toBe('HP');
    expect(nearestByValue(1.9, MODES)?.label).toBe('BP');
    expect(nearestByValue(-4, MODES)?.label).toBe('LP');
    expect(nearestByValue(99, MODES)?.label).toBe('BP');
  });

  it('resolves a TIE to the EARLIER entry, deterministically', () => {
    // A motorized/CV-driven value sweeping through the midpoint must not make
    // the readout flicker between two equally-near names.
    expect(nearestByValue(0.5, MODES)?.label).toBe('LP');
    expect(nearestByValue(1.5, MODES)?.label).toBe('HP');
  });

  it('is undefined for an empty roster', () => {
    expect(nearestByValue(0, [])).toBeUndefined();
  });
});

// ── THE PAINTED READOUT — A NAME, NEVER A NUMBER ──────────────────────────
//
// Owner ruling 2026-08-17: *"we should kill the light white decimil
// represebtation of knob state in ALL modules"* / *"i want the data gone, not
// there but hidden or something"*. `knobNameReadout` is the whole of what a
// dial paints at rest, and the tests below are written as a PAIR against
// `knobValueReadout` on every case — the number must be absent from one and
// present in the other for the same input, or the removal is either incomplete
// or has taken the accessible value with it.
describe('knobNameReadout — what the dial PAINTS', () => {
  it('a plain param paints NOTHING (and still SPEAKS its number)', () => {
    expect(knobNameReadout(0.42, {})).toBeNull();
    // The paired leg. Without it, deleting the readout and deleting the VALUE
    // look identical from this file.
    expect(knobValueReadout(0.42, {})).toBe('0.42');
  });

  it('a declared numeric FORMAT paints nothing — a formatted number is still a number', () => {
    // The case the removal is actually about. `450 ms` / `900 HZ` / `+3.0 dB`
    // read as "meaningful" and are exactly what covered tidyVco's faceplate.
    const ms = { format: (v: number) => `${Math.round(v)} ms` };
    expect(knobNameReadout(450, ms)).toBeNull();
    expect(knobValueReadout(450, ms)).toBe('450 ms');
  });

  it('an option NAME paints — it is not a representation of the number', () => {
    expect(knobNameReadout(2, { options: MODES })).toBe('BP');
    expect(knobValueReadout(2, { options: MODES })).toBe('BP');
  });

  it('a landmark NAME paints, nearest wins, and a FORMAT does not outrank it', () => {
    expect(knobNameReadout(0.9, { landmarks: SHAPES })).toBe('SAW');
    // ⚠ PRECEDENCE INVERTS vs `knobReadout`, deliberately. There `format` wins
    // (it is the most specific RENDERING); here the question is different —
    // "is there a name?" — and a param that declared both wants the name on
    // the panel and the units in the accessibility tree.
    const both = { landmarks: SHAPES, format: (v: number) => `${v.toFixed(2)}x` };
    expect(knobNameReadout(0.9, both)).toBe('SAW');
    expect(knobValueReadout(0.9, both)).toBe('0.90x');
  });

  it('an EMPTY roster is not a vocabulary', () => {
    expect(knobNameReadout(0.42, { options: [], landmarks: [] })).toBeNull();
  });

  it('NEGATIVE CONTROL: the predicate moves in BOTH directions on one param', () => {
    // The permanent leg. `knobNameReadout` returning null for everything would
    // pass every assertion above except this one, which requires the SAME
    // vocabulary shape to produce a name once a roster is added and nothing
    // before it.
    const bare = {};
    const named = { landmarks: SHAPES };
    expect(knobNameReadout(1, bare)).toBeNull();
    expect(knobNameReadout(1, named)).toBe('SAW');
  });
});

describe('knobValueReadout — the SPOKEN value (aria-valuetext), never painted', () => {
  it('prints the NUMBER where knobReadout prints nothing — the bare-label fix', () => {
    // The dock faceplate's largest single drift from its mock: a column of
    // knobs with labels and no values. `knobReadout` is still null here; the
    // dock asks this instead.
    expect(knobReadout(0.42, {})).toBeNull();
    expect(knobValueReadout(0.42, {})).toBe('0.42');
    expect(knobValueReadout(50, {}, 'Hz')).toBe('50.0 Hz');
    expect(knobValueReadout(450, {}, 'ms')).toBe('450 ms');
  });

  it('still prefers the declared vocabulary — a named state never prints as a number', () => {
    expect(knobValueReadout(2, { options: MODES }, 'Hz')).toBe('BP');
    expect(knobValueReadout(0.9, { landmarks: SHAPES })).toBe('SAW');
    expect(knobValueReadout(0.5, { format: (v) => `${(v * 100).toFixed(0)}%` }, 'Hz')).toBe('50%');
  });

  it('is the SAME ladder the hero readout uses, so the two cannot disagree', () => {
    // dock-faceplate-model's readoutText routes through this function; the
    // assertion pins the shared string rather than two lookalike formatters.
    expect(knobValueReadout(50, {}, 'Hz')).toBe('50.0 Hz');
  });

  it('is TOTAL — a non-finite value prints rather than throwing', () => {
    expect(knobValueReadout(Number.NaN, {})).toBe('NaN');
  });
});

describe('knobReadout — the PF-3 gate', () => {
  it('returns null when the param declared NO vocabulary', () => {
    // This is the whole reason PF-3 is cheap: a plain knob renders no
    // persistent readout, so ~17 dock faceplates keep their baselines.
    expect(knobReadout(0.42, {})).toBeNull();
    expect(knobReadout(0.42, { options: [], landmarks: [] })).toBeNull();
  });

  it('names the current OPTION', () => {
    expect(knobReadout(2, { options: MODES })).toBe('BP');
  });

  it('names the NEAREST option for an off-detent value', () => {
    // A rack saved before the param grew `options`, or a CV-motorized read.
    // An exact-match lookup would print nothing here — strictly worse than the
    // bare number the readout replaced.
    expect(knobReadout(1.8, { options: MODES })).toBe('BP');
  });

  it('names the NEAREST landmark for a continuous morph', () => {
    expect(knobReadout(0, { landmarks: SHAPES })).toBe('TRI');
    expect(knobReadout(0.9, { landmarks: SHAPES })).toBe('SAW');
    expect(knobReadout(1.7, { landmarks: SHAPES })).toBe('SQR');
  });

  it('prefers `format` over both rosters (most specific wins)', () => {
    const format = (v: number) => `${(v * 100).toFixed(0)}%`;
    expect(knobReadout(0.5, { format, options: MODES, landmarks: SHAPES })).toBe('50%');
  });

  it('prefers `options` over `landmarks` when both are somehow present', () => {
    // The vocabulary gate forbids this pairing on a real def; the resolver is
    // still total, so a malformed input degrades instead of throwing.
    expect(knobReadout(1, { options: MODES, landmarks: SHAPES })).toBe('HP');
  });
});

describe('knobMarks — detent ticks', () => {
  it('is empty without a vocabulary (no ticks on a plain dial)', () => {
    expect(knobMarks({}, 0, 1)).toEqual([]);
    expect(knobMarks({ format: (v) => String(v) }, 0, 1)).toEqual([]);
  });

  it('places an OPTION tick at every state, unlabeled', () => {
    const marks = knobMarks({ options: MODES }, 0, 2, 'discrete');
    expect(marks.map((m) => m.value)).toEqual([0, 1, 2]);
    expect(marks.map((m) => m.frac)).toEqual([0, 0.5, 1]);
    // The Segmented/Selector alongside already names every state, and the
    // readout names the current one — a third copy would just be noise.
    expect(marks.every((m) => m.label === '')).toBe(true);
  });

  it('places a LANDMARK tick at every waypoint, WITH its name', () => {
    const marks = knobMarks({ landmarks: SHAPES }, 0, 2, 'linear');
    expect(marks.map((m) => m.label)).toEqual(['TRI', 'SAW', 'SQR']);
  });

  it('positions a tick under the param CURVE, not a linear fraction', () => {
    // A log param's midpoint value is nowhere near the arc midpoint; a tick
    // that ignored the curve would sit where the pointer never rests.
    const marks = knobMarks({ landmarks: [{ value: 1000, label: '1k' }] }, 20, 20000, 'log');
    expect(marks[0]!.frac).toBeCloseTo(knobValueToFrac(1000, 20, 20000, 'log'), 12);
    expect(marks[0]!.frac).not.toBeCloseTo((1000 - 20) / (20000 - 20), 3);
  });

  it('drops out-of-range detents and de-duplicates values', () => {
    const marks = knobMarks(
      { landmarks: [{ value: -1, label: 'LO' }, { value: 0, label: 'A' }, { value: 0, label: 'DUP' }, { value: 9, label: 'HI' }] },
      0,
      2,
      'linear',
    );
    expect(marks.map((m) => m.label)).toEqual(['A']);
  });

  it('sorts marks by value regardless of authoring order', () => {
    const marks = knobMarks(
      { landmarks: [{ value: 2, label: 'C' }, { value: 0, label: 'A' }, { value: 1, label: 'B' }] },
      0,
      2,
      'linear',
    );
    expect(marks.map((m) => m.label)).toEqual(['A', 'B', 'C']);
  });

  it('landmarks win the tick source when both rosters are present', () => {
    const marks = knobMarks({ options: MODES, landmarks: [{ value: 1, label: 'MID' }] }, 0, 2, 'linear');
    expect(marks.map((m) => m.label)).toEqual(['MID']);
  });
});
