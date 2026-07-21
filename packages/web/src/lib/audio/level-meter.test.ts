import { describe, it, expect } from 'vitest';
import { rmsUnit } from './level-meter';

describe('rmsUnit', () => {
  it('is 0 for silence and for an empty buffer', () => {
    expect(rmsUnit(new Float32Array(0))).toBe(0);
    expect(rmsUnit(new Float32Array(256))).toBe(0);
  });
  it('reads ~0.707 for a full-scale sine', () => {
    const n = 4096;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = Math.sin((2 * Math.PI * i) / 64);
    expect(rmsUnit(buf)).toBeCloseTo(Math.SQRT1_2, 2);
  });
  it('reads ~1 for a full-scale square', () => {
    const buf = new Float32Array(256).map((_, i) => (i % 2 === 0 ? 1 : -1));
    expect(rmsUnit(buf)).toBeCloseTo(1, 6);
  });
  it('scales with amplitude', () => {
    const n = 1024;
    const quiet = new Float32Array(n);
    const loud = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.sin((2 * Math.PI * i) / 32);
      quiet[i] = 0.1 * s;
      loud[i] = 0.8 * s;
    }
    expect(rmsUnit(loud)).toBeGreaterThan(rmsUnit(quiet));
    expect(rmsUnit(quiet)).toBeCloseTo(0.1 * Math.SQRT1_2, 3);
  });
  it('clamps to 1 for an over-unity buffer', () => {
    const buf = new Float32Array(64).fill(3);
    expect(rmsUnit(buf)).toBe(1);
  });
});
