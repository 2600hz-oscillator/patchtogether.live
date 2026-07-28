import { describe, it, expect } from 'vitest';
import {
  activeSegmentIndex,
  nearestSegmentValue,
  segmentValueAt,
  ccFractionToSegmentIndex,
  type Segment,
} from './segmented-model';
import { nearestByValue } from './knob-vocabulary-model';

const WAVES: Segment<number>[] = [
  { value: 0, label: 'SAW' },
  { value: 1, label: 'BLEND' },
  { value: 2, label: 'SQ' },
  { value: 3, label: 'PULSE' },
];

describe('activeSegmentIndex', () => {
  it('lights the exact matching segment', () => {
    expect(activeSegmentIndex(0, WAVES)).toBe(0);
    expect(activeSegmentIndex(3, WAVES)).toBe(3);
  });
  it('lights nothing for an unmatched value (no nearest-snap)', () => {
    expect(activeSegmentIndex(1.5, WAVES)).toBe(-1);
    expect(activeSegmentIndex(9, WAVES)).toBe(-1);
  });
});

describe('nearestSegmentValue', () => {
  it('returns the exact value when it is on a detent', () => {
    expect(nearestSegmentValue(2, WAVES)).toBe(2);
  });
  it('snaps an OFF-DETENT value to its nearest segment', () => {
    // The read-side companion to activeSegmentIndex's deliberate exact match:
    // a saved rack predating the param's `options`, or a CV-motorized read.
    expect(nearestSegmentValue(1.6, WAVES)).toBe(2);
    expect(nearestSegmentValue(-3, WAVES)).toBe(0);
    expect(nearestSegmentValue(99, WAVES)).toBe(3);
  });
  it('resolves a TIE to the EARLIER segment', () => {
    expect(nearestSegmentValue(1.5, WAVES)).toBe(1);
  });
  it('AGREES with the dial resolver — the dock and the lane must not disagree', () => {
    // The dock paints a Segmented and the lane paints a KnobConic readout for
    // the SAME param. If these two answered differently, the same module would
    // report two different modes depending on which tier you were looking at.
    for (const v of [-1, 0, 0.4, 0.5, 0.6, 1, 1.5, 2.2, 3, 7]) {
      expect(nearestSegmentValue(v, WAVES), `value ${v}`).toBe(nearestByValue(v, WAVES)!.value);
    }
  });
  it('skips non-numeric segments and falls back to the first', () => {
    const presets: Segment<string>[] = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
    expect(nearestSegmentValue(1, presets)).toBe('a');
  });
  it('returns the value unchanged for an empty roster', () => {
    expect(nearestSegmentValue(4, [])).toBe(4);
  });
});

describe('segmentValueAt', () => {
  it('returns the pressed segment value', () => {
    expect(segmentValueAt(WAVES, 2)).toBe(2);
  });
  it('is undefined out of bounds', () => {
    expect(segmentValueAt(WAVES, -1)).toBeUndefined();
    expect(segmentValueAt(WAVES, 4)).toBeUndefined();
  });
});

describe('ccFractionToSegmentIndex', () => {
  it('steps across the row and clamps', () => {
    expect(ccFractionToSegmentIndex(0, 4)).toBe(0);
    expect(ccFractionToSegmentIndex(1, 4)).toBe(3);
    expect(ccFractionToSegmentIndex(0.5, 4)).toBe(2);
    expect(ccFractionToSegmentIndex(-1, 4)).toBe(0);
    expect(ccFractionToSegmentIndex(5, 4)).toBe(3);
  });
  it('is -1 for an empty row', () => {
    expect(ccFractionToSegmentIndex(0.5, 0)).toBe(-1);
  });
});
