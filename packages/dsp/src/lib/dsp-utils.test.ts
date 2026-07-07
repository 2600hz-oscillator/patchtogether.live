// packages/dsp/src/lib/dsp-utils.test.ts
//
// Pins the shared per-sample utilities (extracted from the retired
// chowkick-dsp core; kickdrum / snaredrum / snare-roll import them).

import { describe, expect, it } from 'vitest';
import { clamp, dcBlockStep, makeDcBlockState } from './dsp-utils';

const SR = 48000;

describe('clamp', () => {
  it('clamps below, inside, and above the range', () => {
    expect(clamp(-2, -1, 1)).toBe(-1);
    expect(clamp(0.25, -1, 1)).toBe(0.25);
    expect(clamp(3, -1, 1)).toBe(1);
  });
});

describe('dcBlockStep — removes DC offset', () => {
  it('a constant input decays to ~0 (DC removed)', () => {
    const st = makeDcBlockState();
    let y = 0;
    for (let i = 0; i < 48000; i++) y = dcBlockStep(0.5, st, 25, SR);
    expect(Math.abs(y)).toBeLessThan(0.01);
  });

  it('passes an AC signal (80 Hz sine) near unity', () => {
    const st = makeDcBlockState();
    let peak = 0;
    for (let i = 0; i < SR; i++) {
      const y = dcBlockStep(Math.sin(2 * Math.PI * 80 * i / SR), st, 25, SR);
      if (i > SR / 2) peak = Math.max(peak, Math.abs(y));
    }
    expect(peak).toBeGreaterThan(0.9); // 80 Hz well above the 25 Hz cutoff
  });

  it('removes the DC component from a DC+AC mix', () => {
    const st = makeDcBlockState();
    let sum = 0; const N = SR;
    for (let i = 0; i < N; i++) {
      const x = 0.5 + 0.3 * Math.sin(2 * Math.PI * 80 * i / SR);
      const y = dcBlockStep(x, st, 25, SR);
      if (i > N / 2) sum += y;
    }
    expect(Math.abs(sum / (N / 2))).toBeLessThan(0.01); // mean ≈ 0
  });
});
