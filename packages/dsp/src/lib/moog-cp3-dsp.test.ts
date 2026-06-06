// packages/dsp/src/lib/moog-cp3-dsp.test.ts
//
// Pure-DSP unit tests for the Moog CP3 console-mixer core (own-code, forked
// from the repo `mixer`). Pins the math the worklet depends on so a refactor
// surfaces as a specific quantitative regression:
//   • cp3ChannelGain — 0..1 knob → 0..×2 gain (0.5 = unity, 1.0 = ×2).
//   • cp3Attenuator  — 0..1 attenuator, never boosts (1.0 = unity).
//   • cp3Mix         — 4-channel sum with per-channel gain; the (−) output is
//     the exact phase-inverse of (+); the attenuated 4th input (in4+ext4)×att;
//     mixes AC and/or DC (DC- and polarity-transparent).
//   • ±reference constants — +12V / −6V scaled into the normalized convention.

import { describe, it, expect } from 'vitest';
import {
  CP3_MAX_GAIN,
  cp3ChannelGain,
  cp3Attenuator,
  cp3Mix,
  CP3_PLUS_12V,
  CP3_MINUS_6V,
} from './moog-cp3-dsp';

describe('moog-cp3-dsp / cp3ChannelGain', () => {
  it('knob 0 = silence, 0.5 = unity, 1.0 = ×2 (max gain)', () => {
    expect(cp3ChannelGain(0)).toBe(0);
    expect(cp3ChannelGain(0.5)).toBeCloseTo(1, 10);
    expect(cp3ChannelGain(1)).toBe(CP3_MAX_GAIN);
    expect(CP3_MAX_GAIN).toBe(2);
  });

  it('clamps out-of-range knob values to [0, 1]', () => {
    expect(cp3ChannelGain(-1)).toBe(0);
    expect(cp3ChannelGain(5)).toBe(CP3_MAX_GAIN);
  });
});

describe('moog-cp3-dsp / cp3Attenuator', () => {
  it('attenuates only — 1.0 is unity, never boosts past 1', () => {
    expect(cp3Attenuator(0)).toBe(0);
    expect(cp3Attenuator(0.5)).toBe(0.5);
    expect(cp3Attenuator(1)).toBe(1);
    // Even an out-of-range value never exceeds unity.
    expect(cp3Attenuator(5)).toBe(1);
    expect(cp3Attenuator(-1)).toBe(0);
  });
});

describe('moog-cp3-dsp / cp3Mix', () => {
  it('sums four channels at their per-channel gains', () => {
    // unity gains (0.5 knob), no ext4, attenuator unity.
    const g = cp3ChannelGain(0.5); // = 1
    const { pos } = cp3Mix(1, 2, 3, 4, 0, g, g, g, g, 1);
    expect(pos).toBeCloseTo(1 + 2 + 3 + 4, 10);
  });

  it('applies per-channel gain independently', () => {
    // ch1 ×2, ch2..ch4 silent → only in1 reaches the bus, doubled.
    const { pos } = cp3Mix(0.5, 9, 9, 9, 0, cp3ChannelGain(1), 0, 0, 0, 1);
    expect(pos).toBeCloseTo(0.5 * 2, 10);
  });

  it('the (−) output is the exact phase-inverse of the (+) output', () => {
    const g = cp3ChannelGain(0.5);
    const { pos, neg } = cp3Mix(0.3, -0.7, 0.1, 0.2, 0.05, g, g, g, g, 0.5);
    expect(neg).toBe(-pos);
    expect(pos + neg).toBe(0);
  });

  it('the 4th input sums the panel jack + external jack, scaled by the attenuator', () => {
    // Only ch4 open (unity). in4=0.4, ext4=0.6, attenuator 0.5.
    // ch4 signal = (0.4 + 0.6) * 0.5 = 0.5; gain 1 → bus = 0.5.
    const { pos } = cp3Mix(0, 0, 0, 0.4, 0.6, 0, 0, 0, cp3ChannelGain(0.5), 0.5);
    expect(pos).toBeCloseTo(0.5, 10);
  });

  it('attenuator at "10" (1.0) is unity — a direct patch passes through unaltered', () => {
    // Only the external jack into ch4 at unity gain + unity attenuator.
    const { pos } = cp3Mix(0, 0, 0, 0, 0.42, 0, 0, 0, cp3ChannelGain(0.5), 1);
    expect(pos).toBeCloseTo(0.42, 10);
  });

  it('mixes DC voltages (not just AC) — DC- and polarity-transparent sum', () => {
    const g = cp3ChannelGain(0.5);
    // Two opposite DC rails should cancel; a third adds.
    const { pos } = cp3Mix(1, -1, 0.25, 0, 0, g, g, g, g, 1);
    expect(pos).toBeCloseTo(0.25, 10);
  });

  it('all-silent inputs produce silence on both outputs', () => {
    const g = cp3ChannelGain(0.5);
    const { pos, neg } = cp3Mix(0, 0, 0, 0, 0, g, g, g, g, 1);
    expect(pos).toBe(0);
    // neg = -pos; negating +0 yields -0, which IS silence (use closeTo to
    // avoid the Object.is(+0, -0) distinction).
    expect(neg).toBeCloseTo(0, 10);
  });
});

describe('moog-cp3-dsp / reference voltages', () => {
  it('+12V reference scales to +2.4 (±5V ≡ ±1 normalized)', () => {
    expect(CP3_PLUS_12V).toBeCloseTo(2.4, 10);
  });

  it('−6V reference scales to −1.2', () => {
    expect(CP3_MINUS_6V).toBeCloseTo(-1.2, 10);
  });

  it('−6V is exactly half the +12V rail and opposite sign', () => {
    expect(CP3_MINUS_6V).toBeCloseTo(-CP3_PLUS_12V / 2, 10);
  });
});
