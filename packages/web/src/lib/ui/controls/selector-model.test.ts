import { describe, it, expect } from 'vitest';
import {
  findOptionIndex,
  currentOption,
  selectorLabel,
  cycleOptionValue,
  ccFractionToOptionValue,
  numericOptionRange,
  type SelectorOption,
} from './selector-model';

const NUM: SelectorOption<number>[] = [
  { value: 0, label: 'LP' },
  { value: 1, label: 'BP' },
  { value: 2, label: 'HP' },
  { value: 3, label: 'NOTCH' },
];

// A non-param preset roster (DX7-style, values by name).
const NAMED: SelectorOption<string>[] = [
  { value: 'epiano1', label: 'E.PIANO 1' },
  { value: 'brass', label: 'BRASS' },
  { value: 'bass', label: 'SYN-BASS' },
];

describe('findOptionIndex / currentOption / selectorLabel', () => {
  it('finds the exact option by value (numeric + named)', () => {
    expect(findOptionIndex(2, NUM)).toBe(2);
    expect(findOptionIndex('brass', NAMED)).toBe(1);
    expect(findOptionIndex(9, NUM)).toBe(-1);
  });
  it('falls back to the first option for an unknown value (never blank)', () => {
    expect(currentOption(2, NUM)?.label).toBe('HP');
    expect(currentOption(99, NUM)?.label).toBe('LP');
    expect(selectorLabel(99, NUM)).toBe('LP');
    expect(selectorLabel('bass', NAMED)).toBe('SYN-BASS');
  });
  it('returns undefined for an empty roster', () => {
    expect(currentOption(0, [])).toBeUndefined();
    expect(selectorLabel(0, [])).toBe('0');
  });
});

describe('cycleOptionValue', () => {
  it('steps forward and wraps', () => {
    expect(cycleOptionValue(0, NUM, +1)).toBe(1);
    expect(cycleOptionValue(3, NUM, +1)).toBe(0); // wrap top → bottom
  });
  it('steps backward and wraps', () => {
    expect(cycleOptionValue(0, NUM, -1)).toBe(3); // wrap bottom → top
    expect(cycleOptionValue(2, NUM, -1)).toBe(1);
  });
  it('starts from index 0 for an unknown current value', () => {
    expect(cycleOptionValue(99, NUM, +1)).toBe(1);
  });
  it('cycles a named roster', () => {
    expect(cycleOptionValue('brass', NAMED, +1)).toBe('bass');
    expect(cycleOptionValue('epiano1', NAMED, -1)).toBe('bass');
  });
});

describe('ccFractionToOptionValue', () => {
  it('maps the CC range across the whole roster by index', () => {
    expect(ccFractionToOptionValue(0, NUM)).toBe(0);
    expect(ccFractionToOptionValue(1, NUM)).toBe(3);
    expect(ccFractionToOptionValue(0.5, NUM)).toBe(2); // round(0.5*3)=2
  });
  it('clamps and handles a named roster', () => {
    expect(ccFractionToOptionValue(-1, NAMED)).toBe('epiano1');
    expect(ccFractionToOptionValue(2, NAMED)).toBe('bass');
    expect(ccFractionToOptionValue(0.5, NAMED)).toBe('brass');
  });
  it('is undefined for an empty roster', () => {
    expect(ccFractionToOptionValue(0.5, [])).toBeUndefined();
  });
});

describe('numericOptionRange', () => {
  it('spans a numeric roster', () => {
    expect(numericOptionRange(NUM)).toEqual({ min: 0, max: 3 });
  });
  it('is null for a named (non-param) roster — MIDI-assign disabled', () => {
    expect(numericOptionRange(NAMED)).toBeNull();
  });
  it('is null for an empty roster', () => {
    expect(numericOptionRange([])).toBeNull();
  });
});
