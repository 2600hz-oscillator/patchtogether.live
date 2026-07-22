import { describe, it, expect } from 'vitest';
import { formatReadout } from './readout-model';

describe('formatReadout — numbers', () => {
  it('tightens decimals as magnitude grows', () => {
    expect(formatReadout(0.4)).toBe('0.40');
    expect(formatReadout(12.34)).toBe('12.3');
    expect(formatReadout(123.4)).toBe('123');
  });
  it('uses a k-suffix at ≥1000', () => {
    expect(formatReadout(1234)).toBe('1.23k');
    expect(formatReadout(12345)).toBe('12.3k');
  });
  it('appends units with a space', () => {
    expect(formatReadout(440, { units: 'Hz' })).toBe('440 Hz');
    expect(formatReadout(-6, { units: 'dB' })).toBe('-6.00 dB');
  });
  it('honours a fixed precision override', () => {
    expect(formatReadout(2.4, { precision: 0 })).toBe('2');
    expect(formatReadout(1.23456, { precision: 3 })).toBe('1.235');
  });
  it('renders non-finite as an em dash', () => {
    expect(formatReadout(NaN)).toBe('—');
    expect(formatReadout(Infinity, { units: 'Hz' })).toBe('— Hz');
  });
});

describe('formatReadout — strings (label-style readouts)', () => {
  it('passes a string through untouched', () => {
    expect(formatReadout('ALG 05')).toBe('ALG 05');
    expect(formatReadout('unipolar')).toBe('unipolar');
  });
  it('still appends units to a string', () => {
    expect(formatReadout('4', { units: 'ops' })).toBe('4 ops');
  });
});
