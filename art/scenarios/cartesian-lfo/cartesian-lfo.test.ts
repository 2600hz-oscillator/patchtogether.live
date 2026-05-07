// art/scenarios/cartesian-lfo/cartesian-lfo.test.ts
//
// ART for the Cartesian-embedded LFO. Verifies that the LFO division
// multiplier produces the expected ratio of LFO cycles to clock pulses.
//
// The LFO logic in cartesian.ts measures `lfoMeasuredHz` from the spacing
// between rising edges on lfo_clock and emits a waveform at
// `lfoMeasuredHz * LFO_DIVISIONS[divIdx].mult`. We exercise the same math
// here in isolation (without spinning up the full audio module) to keep the
// ART fast + free of WebAudio plumbing the headless ART runner doesn't have.

import { describe, it, expect } from 'vitest';
import { LFO_DIVISIONS, lfoMorph } from '../../../packages/web/src/lib/audio/lfo-divisions';

describe('Cartesian LFO: division ratios', () => {
  it('exposes the spec-mandated 8 snap points in order', () => {
    expect(LFO_DIVISIONS.map((d) => d.label)).toEqual([
      '1/8', '1/4', '1/2', '1/1', 'x1.5', 'x2', 'x4', 'x8',
    ]);
  });

  it('multipliers walk monotonically from < 1 (slow) to > 1 (fast)', () => {
    const mults = LFO_DIVISIONS.map((d) => d.mult);
    for (let i = 1; i < mults.length; i++) {
      expect(mults[i], `${LFO_DIVISIONS[i]?.label} must be > ${LFO_DIVISIONS[i - 1]?.label}`)
        .toBeGreaterThan(mults[i - 1] ?? 0);
    }
  });

  it('1/1 division produces an LFO at exactly the clock rate', () => {
    const idx = LFO_DIVISIONS.findIndex((d) => d.label === '1/1');
    const clockHz = 4;
    const lfoHz = clockHz * (LFO_DIVISIONS[idx]?.mult ?? 0);
    expect(lfoHz).toBe(clockHz);
  });

  it('1/8 division produces 1 LFO cycle per 8 clock pulses', () => {
    const idx = LFO_DIVISIONS.findIndex((d) => d.label === '1/8');
    const clockHz = 8;
    const lfoHz = clockHz * (LFO_DIVISIONS[idx]?.mult ?? 0);
    // In 1 second of clock at 8Hz: 8 pulses, 1 LFO cycle.
    const cyclesPerSec = lfoHz;
    const pulsesPerSec = clockHz;
    expect(cyclesPerSec).toBe(1);
    expect(pulsesPerSec / cyclesPerSec).toBe(8);
  });

  it('x4 division produces 4 LFO cycles per clock pulse', () => {
    const idx = LFO_DIVISIONS.findIndex((d) => d.label === 'x4');
    const clockHz = 1;
    const lfoHz = clockHz * (LFO_DIVISIONS[idx]?.mult ?? 0);
    expect(lfoHz).toBe(4);
  });

  it('x1.5 division produces a 3:2 ratio of LFO cycles to clock pulses', () => {
    const idx = LFO_DIVISIONS.findIndex((d) => d.label === 'x1.5');
    const clockHz = 2;
    const lfoHz = clockHz * (LFO_DIVISIONS[idx]?.mult ?? 0);
    // 2 Hz clock * 1.5 = 3 Hz LFO; in 1 second: 3 LFO cycles, 2 pulses.
    expect(lfoHz).toBe(3);
    expect(lfoHz / clockHz).toBeCloseTo(1.5, 9);
  });
});

describe('Cartesian LFO: morph waveform sanity', () => {
  it('all four anchor shapes produce values in [-1, 1] across a full cycle', () => {
    for (const shape of [0, 1, 2, 3]) {
      for (let i = 0; i < 1000; i++) {
        const v = lfoMorph(i / 1000, shape);
        expect(v).toBeGreaterThanOrEqual(-1.001);
        expect(v).toBeLessThanOrEqual(1.001);
      }
    }
  });

  it('sine (shape=0) at phase 0 = 0; phase 0.25 = 1; phase 0.5 = 0', () => {
    expect(lfoMorph(0, 0)).toBeCloseTo(0, 6);
    expect(lfoMorph(0.25, 0)).toBeCloseTo(1, 6);
    expect(lfoMorph(0.5, 0)).toBeCloseTo(0, 6);
  });

  it('square (shape=3) is +1 for phase < 0.5, -1 for phase >= 0.5', () => {
    expect(lfoMorph(0, 3)).toBe(1);
    expect(lfoMorph(0.25, 3)).toBe(1);
    expect(lfoMorph(0.5, 3)).toBe(-1);
    expect(lfoMorph(0.75, 3)).toBe(-1);
  });

  it('intermediate shape (1.5) = mix of tri + saw, bounded', () => {
    for (let i = 0; i < 100; i++) {
      const v = lfoMorph(i / 100, 1.5);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.001);
    }
  });

  it('LFO_X (phase 0) and LFO_Y (phase 90 = phase + 0.25) trace a circle when shape=sine', () => {
    // Sine + cosine are perpendicular; sum of squares of their unit-amplitude
    // values is ~1 across a full cycle. Verify a circle (within tiny drift).
    for (let i = 0; i < 256; i++) {
      const phase = i / 256;
      const x = lfoMorph(phase, 0);
      const y = lfoMorph((phase + 0.25) % 1, 0);
      expect(x * x + y * y).toBeCloseTo(1, 6);
    }
  });
});
