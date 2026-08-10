// packages/web/src/lib/ui/workflow/shell-control-kind.test.ts
//
// Unit tests for the PURE param render-kind resolver. Pure + fixture-driven —
// no registry, no DOM. The two lines it holds:
//
//  1. The DECLARATION WINS over the shape. A press-pad and a latching switch
//     are the identical ParamDef (`0..1 discrete default 0`), so `face.momentary`
//     is the only thing that can tell them apart — and if the shape ever won,
//     tomtom's STRIKE and tidyVco's HOLD would go back to being toggles that
//     stay down (the stuck-value-in-the-Y.Doc bug).
//  2. A plain 0/1 switch renders as a Toggle, not a rotary reading "0.00".

import { describe, it, expect } from 'vitest';
import type { ParamDef } from '$lib/graph/types';
import { PACKED_RGB_MAX } from '$lib/ui/controls/color-field-model';
import {
  declaredParamCells,
  looksLikeSwitch,
  momentaryParamIds,
  momentaryValue,
  paramCellKind,
  type DeclaredParamCell,
} from './shell-control-kind';

const param = (over: Partial<ParamDef> & { id: string }): ParamDef => ({
  label: over.id,
  defaultValue: 0,
  min: 0,
  max: 1,
  curve: 'discrete',
  ...over,
});

const NONE: ReadonlySet<string> = new Set<string>();
/** A `face.paramCells` map, built the way `declaredParamCells` returns one. */
const declare = (m: Record<string, DeclaredParamCell>): ReadonlyMap<string, DeclaredParamCell> =>
  new Map(Object.entries(m));

describe('paramCellKind — which primitive a param cell paints', () => {
  it('a DECLARED press-pad is momentary, whatever its shape looks like', () => {
    const strike = param({ id: 'strike' });
    expect(paramCellKind(strike, new Set(['strike']))).toBe('momentary');
    // tidyVco `hold` — the live bug: identical shape, momentary by declaration.
    expect(paramCellKind(param({ id: 'hold' }), new Set(['hold']))).toBe('momentary');
  });

  it('an UNDECLARED 0..1 discrete switch is a toggle, not a knob', () => {
    // kickdrum / snaredrum HARD: latching by intent, but as a KnobConic it read
    // "0.00" and took a full-arc drag to flip one of two states.
    expect(paramCellKind(param({ id: 'hard' }), NONE)).toBe('toggle');
    // Resting HIGH is still a toggle — looksLikeToggle is about the RANGE;
    // only looksLikeSwitch (the classification ratchet) also pins the default.
    expect(paramCellKind(param({ id: 'bypass', defaultValue: 1 }), NONE)).toBe('toggle');
  });

  it('everything else stays a knob', () => {
    expect(paramCellKind(param({ id: 'cutoff', min: 40, max: 14000, curve: 'log' }), NONE)).toBe('knob');
    // A discrete param with MORE than two states is a stepped knob, not a switch.
    expect(paramCellKind(param({ id: 'oct2', min: -1, max: 1 }), NONE)).toBe('knob');
    expect(paramCellKind(param({ id: 'algorithm', min: 1, max: 32 }), NONE)).toBe('knob');
    // Continuous 0..1 is a knob even though its RANGE matches a switch.
    expect(paramCellKind(param({ id: 'mix', curve: 'linear' }), NONE)).toBe('knob');
  });

  it('momentary BEATS toggle for a param that is both shapes', () => {
    // The precedence that matters: `hold` is 0..1 discrete (toggle-shaped) AND
    // declared momentary. Rendering it as a Toggle would latch it — exactly the
    // bug PF-0 fixed at the declaration end.
    const hold = param({ id: 'hold' });
    expect(paramCellKind(hold, NONE), 'undeclared → toggle').toBe('toggle');
    expect(paramCellKind(hold, new Set(['hold'])), 'declared → momentary').toBe('momentary');
  });
});

describe('paramCellKind — the DECLARED grid cell (PF-15)', () => {
  const alg = param({ id: 'algorithm', min: 1, max: 32 });
  const GRID = declare({ algorithm: 'grid' });

  it('a declared paramCells entry paints a grid where the shape alone says knob', () => {
    expect(paramCellKind(alg, NONE), 'undeclared → a stepped knob').toBe('knob');
    expect(paramCellKind(alg, NONE, 'lane', GRID)).toBe('grid');
  });

  it('is TIER-INDEPENDENT — the popover is portaled, so the lane can hold it too', () => {
    // The property that distinguishes it from `segmented`/`selector`, which
    // fall back to a dial in a 46px lane column. A grid does not live in the
    // column at all, so a 32-cell chart is as reachable from a mini tile as
    // from the dock faceplate.
    for (const tier of ['lane', 'dock'] as const) {
      expect(paramCellKind(alg, NONE, tier, GRID), tier).toBe('grid');
    }
  });

  it('grid BEATS a declared options roster at the dock (a chart is not a button row)', () => {
    const withOptions = param({
      id: 'algorithm',
      min: 1,
      max: 3,
      options: [
        { value: 1, label: 'one' },
        { value: 2, label: 'two' },
        { value: 3, label: 'three' },
      ],
    });
    expect(paramCellKind(withOptions, NONE, 'dock'), 'options alone → segmented').toBe('segmented');
    expect(paramCellKind(withOptions, NONE, 'dock', GRID)).toBe('grid');
  });

  it('momentary still outranks grid — an invalid face fails toward the SAFE render', () => {
    // module-face-lint forbids declaring both, so this ordering is unobservable
    // in a valid face; it is pinned so a broken one paints the pad that RETURNS
    // TO REST rather than a picker that commits a latched value.
    expect(paramCellKind(alg, new Set(['algorithm']), 'dock', GRID)).toBe('momentary');
  });

  it('an undeclared param is untouched by another param’s grid declaration', () => {
    expect(paramCellKind(param({ id: 'level', curve: 'linear', max: 2 }), NONE, 'dock', GRID)).toBe('knob');
  });
});

describe('paramCellKind — the DECLARED colour cell', () => {
  // The packed-RGB shape: wavesculpt's red_color / grn_color / blu_color.
  const col = param({ id: 'red_color', min: 0, max: PACKED_RGB_MAX, defaultValue: 0xff3333 });
  const COLOR = declare({ red_color: 'color' });

  it('⚠ UNDECLARED IT IS A KNOB OVER 16.7 MILLION STATES — the defect this kind exists for', () => {
    // Not a theoretical worry: this is what the shell painted before the kind
    // existed, and faces-parity PASSES it (dragging the dial does move the
    // param), so no gate could report it. The assertion is here so the
    // undeclared behaviour is a PINNED fact rather than a footnote.
    expect(paramCellKind(col, NONE, 'dock')).toBe('knob');
    expect(col.max - col.min + 1).toBe(16_777_216);
  });

  it('a declared paramCells entry paints the swatch', () => {
    expect(paramCellKind(col, NONE, 'dock', COLOR)).toBe('color');
  });

  it('is TIER-INDEPENDENT — a 40px swatch fits a lane column, and a knob there is just as wrong', () => {
    for (const tier of ['lane', 'dock'] as const) {
      expect(paramCellKind(col, NONE, tier, COLOR), tier).toBe('color');
    }
  });

  it('colour BEATS the sniffed toggle shape and a declared roster', () => {
    // Both are unreachable for a real packed-RGB param (it is neither 0..1 nor
    // rostered), so these pin the PRECEDENCE rather than a live case: a
    // declaration must not be silently overridden by a shape.
    const two = param({ id: 'red_color' });
    expect(paramCellKind(two, NONE, 'dock'), 'shape alone → toggle').toBe('toggle');
    expect(paramCellKind(two, NONE, 'dock', COLOR)).toBe('color');
    const rostered = param({
      id: 'red_color',
      min: 0,
      max: 2,
      options: [
        { value: 0, label: 'a' },
        { value: 1, label: 'b' },
        { value: 2, label: 'c' },
      ],
    });
    expect(paramCellKind(rostered, NONE, 'dock'), 'options alone → segmented').toBe('segmented');
    expect(paramCellKind(rostered, NONE, 'dock', COLOR)).toBe('color');
  });

  it('momentary still outranks colour — an invalid face fails toward the SAFE render', () => {
    expect(paramCellKind(col, new Set(['red_color']), 'dock', COLOR)).toBe('momentary');
  });
});

describe('declaredParamCells — the declaration map', () => {
  it('reads face.paramCells, empty for an un-faced or un-declaring def', () => {
    const m = declaredParamCells({ face: { paramCells: { algorithm: 'grid', red_color: 'color' } } });
    expect([...m.entries()].sort()).toEqual([
      ['algorithm', 'grid'],
      ['red_color', 'color'],
    ]);
    expect(declaredParamCells({ face: {} }).size).toBe(0);
    expect(declaredParamCells(undefined).size).toBe(0);
  });

  it('⚠ ONE MAP, so a param cannot be declared TWO primitives', () => {
    // The structural reason this is a map rather than one Set per kind: a
    // record cannot hold two values for one key, so "grid AND color" is
    // unrepresentable instead of being a lint rule someone has to remember.
    const m = declaredParamCells({ face: { paramCells: { x: 'grid' } } });
    expect(m.get('x')).toBe('grid');
    expect(m.size).toBe(1);
  });

  it('the default argument means an undeclared def never reaches a declared branch', () => {
    expect(paramCellKind(param({ id: 'algorithm', min: 1, max: 32 }), NONE, 'dock')).toBe('knob');
    expect(paramCellKind(param({ id: 'red_color', max: PACKED_RGB_MAX }), NONE, 'dock')).toBe('knob');
  });
});

describe('looksLikeSwitch — the press-pad SHAPE (classification ratchet input)', () => {
  it('is 0..1 discrete RESTING AT 0', () => {
    expect(looksLikeSwitch(param({ id: 'hard' }))).toBe(true);
    expect(looksLikeSwitch(param({ id: 'on', defaultValue: 1 })), 'rests high').toBe(false);
    expect(looksLikeSwitch(param({ id: 'mix', curve: 'linear' })), 'continuous').toBe(false);
    expect(looksLikeSwitch(param({ id: 'oct2', min: -1 })), 'three states').toBe(false);
  });
});

describe('momentaryParamIds / momentaryValue', () => {
  it('reads the declared set, empty for an un-faced or un-declaring def', () => {
    expect([...momentaryParamIds({ face: { momentary: ['strike'] } })]).toEqual(['strike']);
    expect(momentaryParamIds({ face: {} }).size).toBe(0);
    expect(momentaryParamIds(undefined).size).toBe(0);
  });

  it('release returns the param to its REST value — nothing stuck persists', () => {
    expect(momentaryValue(true)).toBe(1);
    expect(momentaryValue(false)).toBe(0);
    expect(momentaryValue(false, 0)).toBe(0);
  });
});
