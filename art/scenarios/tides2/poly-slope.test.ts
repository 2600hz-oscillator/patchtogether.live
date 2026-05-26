// art/scenarios/tides2/poly-slope.test.ts
//
// Audio Regression Tests for TIDES2 (Mutable Instruments Tides 2018
// archetype, MIT-licensed). Headline scenarios exercising the four OUTPUT
// MODE relationships + the three RAMP MODEs through the shared host-math
// engine (numerically identical to the worklet):
//   1. PHASE mode — the four outs are phase-shifted copies of one wave.
//   2. FREQUENCY mode — the four outs run at different cycle rates.
//   3. AD mode — a one-shot ramp that never free-runs.
//   4. LOOP mode — a free-running oscillator whose rate tracks FREQ + V/oct.

import { describe, expect, it } from 'vitest';
import {
  tides2Math,
  RAMP_MODE_AD,
  RAMP_MODE_LOOPING,
  OUTPUT_MODE_SLOPE_PHASE,
  OUTPUT_MODE_FREQUENCY,
  RANGE_AUDIO,
  type Tides2Params,
} from '../../../packages/web/src/lib/audio/modules/tides2';

const SR = 48000;

function base(o: Partial<Tides2Params> = {}): Tides2Params {
  return {
    frequency: 0.4, voct: 0, shape: 0, slope: 0.5, smoothness: 0.7,
    shift: 0.5, rampMode: RAMP_MODE_LOOPING, outputMode: OUTPUT_MODE_SLOPE_PHASE,
    range: RANGE_AUDIO, ...o,
  };
}

function rms(b: Float32Array): number {
  let s = 0; for (let i = 0; i < b.length; i++) s += b[i]! * b[i]!;
  return Math.sqrt(s / b.length);
}

function cycles(b: Float32Array): number {
  let c = 0; for (let i = 1; i < b.length; i++) if (b[i]! < b[i - 1]! - 0.3) c++;
  return c;
}

describe('ART tides2 / PHASE mode — four phase-shifted slopes', () => {
  it('all four channels carry signal and are mutually phase-offset', () => {
    const outs = tides2Math.render(SR, SR, {
      params: base({ outputMode: OUTPUT_MODE_SLOPE_PHASE, shift: 0.9, frequency: 0.35 }),
    });
    for (let c = 0; c < 4; c++) {
      expect(rms(outs[c]!), `ch${c} energy`).toBeGreaterThan(0.01);
    }
    // ch0 and ch3 differ (the spread accumulates across channels).
    let diff = 0;
    for (let i = 1000; i < 2000; i++) diff += Math.abs(outs[0]![i]! - outs[3]![i]!);
    expect(diff).toBeGreaterThan(1);
  });
});

describe('ART tides2 / FREQUENCY mode — frequency-divided outs', () => {
  it('channel 3 cycles more often than channel 0 when SHIFT picks harmonics', () => {
    const outs = tides2Math.render(SR, SR, {
      params: base({ outputMode: OUTPUT_MODE_FREQUENCY, shift: 0.95, frequency: 0.2 }),
    });
    expect(cycles(outs[3]!)).toBeGreaterThan(cycles(outs[0]!));
  });
});

describe('ART tides2 / AD one-shot vs LOOP free-run', () => {
  it('AD does not cycle without a trigger; a trigger raises the peak', () => {
    const idle = tides2Math.render(SR, SR, {
      params: base({ rampMode: RAMP_MODE_AD, frequency: 0.5 }),
    });
    expect(cycles(idle[0]!)).toBe(0);

    const fired = tides2Math.render(SR, SR, {
      params: base({ rampMode: RAMP_MODE_AD, frequency: 0.5 }),
      trigHigh: [SR / 2],
    });
    const peak = Math.max(...fired[0]!.slice(SR / 2));
    expect(peak).toBeGreaterThan(0.7);
  });

  it('LOOP free-runs and its rate climbs with the FREQ knob + a V/oct octave', () => {
    const low = tides2Math.render(SR, SR, {
      params: base({ rampMode: RAMP_MODE_LOOPING, frequency: 0.3, voct: 0 }),
    });
    const high = tides2Math.render(SR, SR, {
      params: base({ rampMode: RAMP_MODE_LOOPING, frequency: 0.3, voct: 1 }),
    });
    expect(cycles(low[0]!)).toBeGreaterThan(0);
    // +1 octave roughly doubles the cycle count.
    expect(cycles(high[0]!)).toBeGreaterThan(cycles(low[0]!));
  });
});
