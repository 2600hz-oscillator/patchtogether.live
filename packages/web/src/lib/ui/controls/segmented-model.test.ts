import { describe, it, expect } from 'vitest';
import {
  activeSegmentIndex,
  segmentValueAt,
  ccFractionToSegmentIndex,
  type Segment,
} from './segmented-model';

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
