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
import {
  looksLikeSwitch,
  momentaryParamIds,
  momentaryValue,
  paramCellKind,
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
