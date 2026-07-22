import { describe, it, expect } from 'vitest';
import {
  knobValueToFrac,
  knobFracToValue,
  knobPointerAngle,
  KNOB_ARC_DEG,
  KNOB_START_DEG,
} from './knob-conic-model';

describe('knobValueToFrac', () => {
  it('pins the endpoints and centre (linear)', () => {
    expect(knobValueToFrac(0, 0, 1, 'linear')).toBe(0);
    expect(knobValueToFrac(1, 0, 1, 'linear')).toBe(1);
    expect(knobValueToFrac(0.5, 0, 1, 'linear')).toBeCloseTo(0.5, 6);
    expect(knobValueToFrac(50, 0, 100, 'linear')).toBeCloseTo(0.5, 6);
  });
  it('clamps out-of-range values into [0,1]', () => {
    expect(knobValueToFrac(-10, 0, 1, 'linear')).toBe(0);
    expect(knobValueToFrac(10, 0, 1, 'linear')).toBe(1);
  });
  it('is monotonic and bounded under log/exp', () => {
    for (const curve of ['log', 'exp'] as const) {
      let prev = -1;
      for (let v = 20; v <= 120; v += 5) {
        const f = knobValueToFrac(v, 20, 120, curve);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
        expect(f).toBeGreaterThanOrEqual(prev); // monotonic non-decreasing
        prev = f;
      }
    }
  });
  it('log falls back to linear when an endpoint is non-positive', () => {
    // min<=0 → linear normalization, still pins endpoints.
    expect(knobValueToFrac(-1, -1, 1, 'log')).toBe(0);
    expect(knobValueToFrac(1, -1, 1, 'log')).toBe(1);
    expect(knobValueToFrac(0, -1, 1, 'log')).toBeCloseTo(0.5, 6);
  });
  it('returns 0 for a degenerate range', () => {
    expect(knobValueToFrac(5, 5, 5, 'linear')).toBe(0);
  });
});

describe('knobFracToValue', () => {
  it('round-trips linear', () => {
    for (const v of [0, 25, 50, 75, 100]) {
      const f = knobValueToFrac(v, 0, 100, 'linear');
      expect(knobFracToValue(f, 0, 100, 'linear')).toBeCloseTo(v, 6);
    }
  });
  it('round-trips log', () => {
    for (const v of [20, 40, 80, 120]) {
      const f = knobValueToFrac(v, 20, 120, 'log');
      expect(knobFracToValue(f, 20, 120, 'log')).toBeCloseTo(v, 4);
    }
  });
  it('snaps discrete to integer steps', () => {
    // 5 steps across [0,4]; frac 0.6 → 2.4 → rounds to 2.
    expect(knobFracToValue(0.6, 0, 4, 'discrete')).toBe(2);
    expect(knobFracToValue(0, 0, 4, 'discrete')).toBe(0);
    expect(knobFracToValue(1, 0, 4, 'discrete')).toBe(4);
    expect(Number.isInteger(knobFracToValue(0.37, 0, 7, 'discrete'))).toBe(true);
  });
  it('clamps the fraction before mapping', () => {
    expect(knobFracToValue(-0.5, 0, 10, 'linear')).toBe(0);
    expect(knobFracToValue(2, 0, 10, 'linear')).toBe(10);
  });
});

describe('knobPointerAngle', () => {
  it('spans −135° → 0° → +135° across the arc', () => {
    expect(knobPointerAngle(0)).toBe(KNOB_START_DEG);
    expect(knobPointerAngle(0.5)).toBeCloseTo(0, 6);
    expect(knobPointerAngle(1)).toBe(KNOB_START_DEG + KNOB_ARC_DEG);
    expect(knobPointerAngle(1)).toBe(135);
  });
  it('clamps the fraction', () => {
    expect(knobPointerAngle(-1)).toBe(KNOB_START_DEG);
    expect(knobPointerAngle(2)).toBe(135);
  });
});
