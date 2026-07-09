// packages/web/src/lib/audio/modules/joystick.test.ts
//
// Unit tests for the standalone JOYSTICK module. Pure helpers + module-
// def shape are covered here; the audio-thread wiring (setParam mirrors
// into ConstantSource offsets, inverted outputs track raw outputs) is
// exercised by the Playwright E2E (e2e/tests/joystick.spec.ts), which
// is the load-bearing integration test for this module.

import { describe, it, expect } from 'vitest';
import { clampJoy } from './joystick';

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
