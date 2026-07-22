import { describe, it, expect } from 'vitest';
import {
  isToggleOn,
  toggledValue,
  coerceToggle,
  looksLikeToggle,
  TOGGLE_ON_THRESHOLD,
} from './toggle-model';
import type { ParamDef } from '$lib/graph/types';

describe('isToggleOn', () => {
  it('latches on at/above the threshold', () => {
    expect(isToggleOn(0)).toBe(false);
    expect(isToggleOn(0.49)).toBe(false);
    expect(isToggleOn(TOGGLE_ON_THRESHOLD)).toBe(true);
    expect(isToggleOn(0.5)).toBe(true);
    expect(isToggleOn(1)).toBe(true);
  });
});

describe('toggledValue', () => {
  it('flips 0 → 1 and 1 → 0', () => {
    expect(toggledValue(0)).toBe(1);
    expect(toggledValue(1)).toBe(0);
  });
  it('an on-ish value flips to 0, an off-ish value flips to 1', () => {
    expect(toggledValue(0.8)).toBe(0);
    expect(toggledValue(0.2)).toBe(1);
  });
});

describe('coerceToggle', () => {
  it('snaps any scaled value (e.g. a MIDI CC) to a clean 0/1', () => {
    expect(coerceToggle(0)).toBe(0);
    expect(coerceToggle(0.3)).toBe(0);
    expect(coerceToggle(0.7)).toBe(1);
    expect(coerceToggle(1)).toBe(1);
  });
});

describe('looksLikeToggle (shared detector)', () => {
  const mk = (o: Partial<ParamDef>): ParamDef => ({
    id: 'x',
    label: 'X',
    defaultValue: 0,
    min: 0,
    max: 1,
    curve: 'discrete',
    ...o,
  });
  it('accepts a discrete 0..1 param', () => {
    expect(looksLikeToggle(mk({}))).toBe(true);
  });
  it('rejects a continuous 0..1 param', () => {
    expect(looksLikeToggle(mk({ curve: 'linear' }))).toBe(false);
  });
  it('rejects a discrete param with a wider range', () => {
    expect(looksLikeToggle(mk({ max: 3 }))).toBe(false);
    expect(looksLikeToggle(mk({ min: -1 }))).toBe(false);
  });
});
