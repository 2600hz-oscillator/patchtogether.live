// art/scenarios/attenumix/mix-saturation.test.ts
//
// ART-tier check on ATTENUMIX — sweeps the pure-math helper across the
// attenuator + master ranges to pin the per-channel attenuation linearity,
// the 0..1 clamp at the channel level, and the tanh saturation curve on
// the mix. Standard offline-render profile shape.
//
// Why ART rather than just vitest: the defining property of ATTENUMIX is
// "channel attenuates, master saturates" — a future refactor that lifts
// the channel clamp or moves the tanh ahead of the master multiply is
// caught here with quantitative assertions rather than relying on
// signal-shape eyeballs.

import { describe, expect, it } from 'vitest';
import { attenumixMath } from '../../../packages/web/src/lib/audio/modules/attenumix';

describe('ART attenumix / per-channel attenuator is a straight 0..1 line', () => {
  it('att = knob across the open interval (no compression, no boost)', () => {
    // 21-point sweep from 0 to 1. The attenuator is literally the identity
    // on the open interval, so the slope should be exactly 1.
    for (let i = 0; i <= 20; i++) {
      const k = i / 20;
      expect(attenumixMath.channelAtt(k, 0)).toBeCloseTo(k, 12);
    }
  });

  it('clamp pins endpoints: knob >1 → 1, knob <0 → 0', () => {
    expect(attenumixMath.channelAtt(1.5, 0)).toBe(1);
    expect(attenumixMath.channelAtt(2.0, 0)).toBe(1);
    expect(attenumixMath.channelAtt(-0.1, 0)).toBe(0);
    expect(attenumixMath.channelAtt(-1.0, 0)).toBe(0);
  });

  it('channel out is exactly in * knob across a knob sweep', () => {
    // Pin one audio level, sweep knob: out tracks knob linearly.
    const x = 0.4;
    for (let i = 0; i <= 10; i++) {
      const k = i / 10;
      expect(attenumixMath.channelSample(x, k, 0)).toBeCloseTo(x * k, 10);
    }
  });
});

describe('ART attenumix / master+tanh saturation curve', () => {
  it('mix(sum, 1) = tanh(sum) — master=1 is pass-through into tanh', () => {
    for (const sum of [-2, -1, -0.5, 0, 0.5, 1, 2]) {
      expect(attenumixMath.mixSample(sum, 1)).toBeCloseTo(Math.tanh(sum), 12);
    }
  });

  it('master doubles drive: mix(sum, 2) = tanh(2*sum)', () => {
    for (const sum of [-1, -0.3, 0, 0.3, 1]) {
      expect(attenumixMath.mixSample(sum, 2)).toBeCloseTo(Math.tanh(2 * sum), 12);
    }
  });

  it('derivative at zero approaches master (small-signal gain = master)', () => {
    // Around sum=0 tanh is linear with slope 1, so d/dsum tanh(sum * m) = m.
    const eps = 1e-5;
    for (const m of [0.5, 1, 1.5, 2]) {
      const slope = (attenumixMath.mixSample(eps, m) - attenumixMath.mixSample(0, m)) / eps;
      expect(slope).toBeCloseTo(m, 4);
    }
  });

  it('saturation strict-monotone in master: higher master → louder mix at fixed sum', () => {
    // For any fixed positive sum, the mix grows monotonically with master
    // until it asymptotes near 1. Pin the property at sum=0.5.
    const masters = [0.0, 0.5, 1.0, 1.5, 2.0];
    let prev = -Infinity;
    for (const m of masters) {
      const y = attenumixMath.mixSample(0.5, m);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
    // And bounded strictly below 1 even at master=2 + sum=0.5.
    expect(attenumixMath.mixSample(0.5, 2)).toBeLessThan(1);
  });
});

describe('ART attenumix / full mix path (4 channels + master)', () => {
  it('all 4 channels at unity attenuator + master=1: mix ≈ tanh(sum of inputs)', () => {
    // ch1..ch4: in = 0.2 each, knob = 1.0 each → sum = 0.8, mix = tanh(0.8).
    const N = 8;
    const ins = [0.2, 0.2, 0.2, 0.2].map(v => new Float32Array(N).fill(v));
    const { mix } = attenumixMath.render(
      ins, [null, null, null, null], [1, 1, 1, 1], 1, N,
    );
    for (let i = 0; i < N; i++) {
      expect(mix[i]).toBeCloseTo(Math.tanh(0.8), 6);
    }
  });

  it('boost via master: sum=0.8 + master=2 → mix saturates near 0.93', () => {
    // Same patch as above but master=2 → tanh(1.6) ≈ 0.9217 — into the
    // warm-saturation zone, well past the 1.0 hard-clip line.
    const N = 4;
    const ins = [0.2, 0.2, 0.2, 0.2].map(v => new Float32Array(N).fill(v));
    const { mix } = attenumixMath.render(
      ins, [null, null, null, null], [1, 1, 1, 1], 2, N,
    );
    for (let i = 0; i < N; i++) {
      expect(mix[i]).toBeCloseTo(Math.tanh(1.6), 5);
      expect(mix[i]).toBeLessThan(1);
    }
  });

  it('att=0 mutes the channel even with CV+knob over-driving the sum', () => {
    // ch1 driven hard (knob=1, CV=+1 → clamps att at 1.0) → out = 0.5
    // ch2..ch4 fully muted (knob=0, no CV) → out = 0
    // mix = tanh(0.5)
    const N = 4;
    const in1 = new Float32Array(N).fill(0.5);
    const cv1 = new Float32Array(N).fill(1.0);
    const { outs, mix } = attenumixMath.render(
      [in1, null, null, null],
      [cv1, null, null, null],
      [1.0, 0, 0, 0],
      1,
      N,
    );
    for (let i = 0; i < N; i++) {
      expect(outs[0]![i]).toBeCloseTo(0.5, 6);
      expect(outs[1]![i]).toBe(0);
      expect(outs[2]![i]).toBe(0);
      expect(outs[3]![i]).toBe(0);
      expect(mix[i]).toBeCloseTo(Math.tanh(0.5), 6);
    }
  });
});
