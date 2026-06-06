// packages/web/src/lib/electra/curve.test.ts
import { describe, it, expect } from 'vitest';
import {
  valueToCc7,
  cc7ToValue,
  valueToFrac,
  fracToValue,
  dbToMeterCc,
  ampToDb,
  ampToMeterCc,
  rmsOf,
} from './curve';

describe('linear value ↔ cc7', () => {
  it('maps endpoints + midpoint', () => {
    expect(valueToCc7(0, 0, 1, 'linear')).toBe(0);
    expect(valueToCc7(1, 0, 1, 'linear')).toBe(127);
    expect(valueToCc7(0.5, 0, 1, 'linear')).toBe(64); // round(63.5)
  });
  it('clamps out-of-range', () => {
    expect(valueToCc7(-5, 0, 1, 'linear')).toBe(0);
    expect(valueToCc7(5, 0, 1, 'linear')).toBe(127);
  });
  it('round-trips ±12 dB EQ', () => {
    const v = cc7ToValue(valueToCc7(6, -12, 12, 'linear'), -12, 12, 'linear');
    expect(v).toBeCloseTo(6, 0);
  });
});

describe('log curve (BPM 10..300)', () => {
  it('endpoints map to 0 / 127', () => {
    expect(valueToCc7(10, 10, 300, 'log')).toBe(0);
    expect(valueToCc7(300, 10, 300, 'log')).toBe(127);
  });
  it('geometric midpoint sits at the center', () => {
    // sqrt(10*300) ≈ 54.77 BPM → frac 0.5 → cc 64 (round 63.5).
    const mid = Math.sqrt(10 * 300);
    expect(valueToFrac(mid, 10, 300, 'log')).toBeCloseTo(0.5, 5);
    expect(valueToCc7(mid, 10, 300, 'log')).toBe(64);
  });
  it('a mid-pot cc decodes to a sub-150 BPM (log, not 155)', () => {
    const v = cc7ToValue(64, 10, 300, 'log');
    expect(v).toBeGreaterThan(50);
    expect(v).toBeLessThan(60); // log curve, NOT the linear ~155
  });
  it('fracToValue inverts valueToFrac', () => {
    const f = valueToFrac(120, 10, 300, 'log');
    expect(fracToValue(f, 10, 300, 'log')).toBeCloseTo(120, 5);
  });
});

describe('discrete curve snaps', () => {
  it('rounds to integer steps', () => {
    expect(cc7ToValue(0, 0, 10, 'discrete')).toBe(0);
    expect(cc7ToValue(127, 0, 10, 'discrete')).toBe(10);
    expect(Number.isInteger(cc7ToValue(70, 0, 10, 'discrete'))).toBe(true);
  });
});

describe('meter helpers', () => {
  it('0 dBFS → full scale, floor → 0', () => {
    expect(dbToMeterCc(0)).toBe(127);
    expect(dbToMeterCc(-60)).toBe(0);
    expect(dbToMeterCc(-120)).toBe(0); // below floor clamps
  });
  it('ampToDb floors silence', () => {
    expect(ampToDb(0)).toBe(-60);
    expect(ampToDb(1)).toBeCloseTo(0, 5);
  });
  it('ampToMeterCc full-scale amp → 127', () => {
    expect(ampToMeterCc(1)).toBe(127);
    expect(ampToMeterCc(0)).toBe(0);
  });
  it('rmsOf computes RMS', () => {
    const buf = new Float32Array([1, -1, 1, -1]);
    expect(rmsOf(buf)).toBeCloseTo(1, 5);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });
});
