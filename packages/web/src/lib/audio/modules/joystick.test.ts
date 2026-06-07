// packages/web/src/lib/audio/modules/joystick.test.ts
//
// Unit tests for the standalone JOYSTICK module. Pure helpers + module-
// def shape are covered here; the audio-thread wiring (setParam mirrors
// into ConstantSource offsets, inverted outputs track raw outputs) is
// exercised by the Playwright E2E (e2e/tests/joystick.spec.ts), which
// is the load-bearing integration test for this module.

import { describe, it, expect } from 'vitest';
import { joystickDef, clampJoy } from './joystick';

describe('joystick: module-def shape', () => {
  it('declares type=joystick, label=JOYSTICK, audio domain', () => {
    expect(joystickDef.type).toBe('joystick');
    expect(joystickDef.label).toBe('joystick');
    expect(joystickDef.domain).toBe('audio');
  });

  it('declares x/y/nx/ny CV outputs and no inputs', () => {
    expect(joystickDef.inputs).toEqual([]);
    const outIds = joystickDef.outputs.map((p) => p.id);
    expect(outIds).toEqual(['x', 'y', 'nx', 'ny']);
    for (const out of joystickDef.outputs) {
      expect(out.type).toBe('cv');
    }
  });

  it('declares pos_x + pos_y params with -1..+1 range, default 0', () => {
    const paramsById = new Map(joystickDef.params.map((p) => [p.id, p]));
    const x = paramsById.get('pos_x');
    const y = paramsById.get('pos_y');
    expect(x).toBeDefined();
    expect(y).toBeDefined();
    expect(x!.min).toBe(-1);
    expect(x!.max).toBe(1);
    expect(x!.defaultValue).toBe(0);
    expect(y!.min).toBe(-1);
    expect(y!.max).toBe(1);
    expect(y!.defaultValue).toBe(0);
  });
});

describe('clampJoy', () => {
  it('passes values inside [-1, +1] through unchanged', () => {
    expect(clampJoy(0)).toBe(0);
    expect(clampJoy(0.5)).toBe(0.5);
    expect(clampJoy(-0.7)).toBe(-0.7);
    expect(clampJoy(1)).toBe(1);
    expect(clampJoy(-1)).toBe(-1);
  });

  it('clamps to the project CV range', () => {
    expect(clampJoy(2)).toBe(1);
    expect(clampJoy(-3.5)).toBe(-1);
    expect(clampJoy(100)).toBe(1);
  });

  it('treats NaN / non-finite as 0', () => {
    expect(clampJoy(Number.NaN)).toBe(0);
    expect(clampJoy(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampJoy(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
