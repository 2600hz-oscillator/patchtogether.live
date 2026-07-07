// packages/web/src/lib/audio/modules/attenumix.test.ts
//
// Unit tests for ATTENUMIX — the simple 4-channel attenuating mixer.
// Pin per-channel attenuation, the 0..1 clamp at the channel level, the
// mix-sum identity, the master+tanh saturation curve, the CV+knob sum,
// and the module-def shape.

import { describe, expect, it } from 'vitest';
import { attenumixMath } from './attenumix';

describe('attenumixMath.channelAtt: per-channel attenuator clamp', () => {
  it('passes 0..1 through identically', () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 1.0]) {
      expect(attenumixMath.channelAtt(x, 0)).toBeCloseTo(x, 12);
    }
  });

  it('clamps negative knob+cv to 0 (attenuators never invert phase)', () => {
    for (const k of [-0.5, -1, -2]) {
      expect(attenumixMath.channelAtt(k, 0)).toBe(0);
    }
    // Negative net even when knob is positive (CV drives below 0).
    expect(attenumixMath.channelAtt(0.3, -0.5)).toBe(0);
  });

  it('clamps above-unity knob+cv to 1 (attenuators never boost)', () => {
    for (const c of [0.5, 1, 2]) {
      expect(attenumixMath.channelAtt(1.0, c)).toBe(1);
    }
    // CV-only over-drive caps at 1.
    expect(attenumixMath.channelAtt(0, 2)).toBe(1);
    // Knob+CV = 1.5 → caps at 1.
    expect(attenumixMath.channelAtt(0.7, 0.8)).toBe(1);
  });

  it('CV summed with knob in the 0..1 interior region', () => {
    expect(attenumixMath.channelAtt(0.3, 0.4)).toBeCloseTo(0.7, 12);
    expect(attenumixMath.channelAtt(0.0, 0.5)).toBeCloseTo(0.5, 12);
    expect(attenumixMath.channelAtt(0.6, -0.2)).toBeCloseTo(0.4, 12);
  });
});

describe('attenumixMath.channelSample: per-channel multiply', () => {
  it('att=1 passes audio through unchanged', () => {
    for (const x of [-0.9, -0.5, 0, 0.25, 0.7]) {
      expect(attenumixMath.channelSample(x, 1, 0)).toBeCloseTo(x, 12);
    }
  });

  it('att=0 mutes regardless of input', () => {
    // -1 * 0 yields -0 in IEEE-754; both ±0 are "muted" — compare magnitudes.
    for (const x of [-1, -0.5, 0, 0.5, 1]) {
      expect(Math.abs(attenumixMath.channelSample(x, 0, 0))).toBe(0);
    }
  });

  it('att=0.5 halves the audio', () => {
    expect(attenumixMath.channelSample(0.8, 0.5, 0)).toBeCloseTo(0.4, 12);
    expect(attenumixMath.channelSample(-0.6, 0.5, 0)).toBeCloseTo(-0.3, 12);
  });

  it('CV at +1V at knob=0 fully opens the channel (full-range sweep)', () => {
    // The whole point of PASSTHROUGH_BY_DESIGN on CV: ±1V already spans
    // the natural range of [0, 1]. Knob=0 + CV=+1 → att=1 → input passes.
    expect(attenumixMath.channelSample(0.4, 0, 1)).toBeCloseTo(0.4, 12);
  });
});

describe('attenumixMath.mixSample: master+tanh soft-clip', () => {
  it('master=1, small sum: nearly linear passthrough', () => {
    // tanh is ~linear near zero. Small sums get gentle saturation.
    expect(attenumixMath.mixSample(0, 1)).toBe(0);
    expect(attenumixMath.mixSample(0.1, 1)).toBeCloseTo(Math.tanh(0.1), 12);
    // tanh(0.05)/0.05 ≈ 0.999 — linear within 0.1%.
    expect(attenumixMath.mixSample(0.05, 1) / 0.05).toBeGreaterThan(0.99);
  });

  it('master=2 doubles the drive into the tanh — saturation onset earlier', () => {
    // sum=0.5 at master=1 → tanh(0.5) ≈ 0.462
    // sum=0.5 at master=2 → tanh(1.0) ≈ 0.762 — much warmer.
    expect(attenumixMath.mixSample(0.5, 2)).toBeCloseTo(Math.tanh(1.0), 6);
    expect(attenumixMath.mixSample(0.5, 2)).toBeGreaterThan(
      attenumixMath.mixSample(0.5, 1),
    );
  });

  it('master=0 fully mutes the mix', () => {
    // sum*0 may yield -0 in IEEE-754; both ±0 are "muted" — compare magnitudes.
    for (const sum of [-2, -0.5, 0, 0.5, 2]) {
      expect(Math.abs(attenumixMath.mixSample(sum, 0))).toBe(0);
    }
  });

  it('saturation bounded asymptotically at ±1 — no digital hard-clip', () => {
    // tanh approaches 1 at finite arguments — for double-precision floats
    // tanh(x) is < 1 for x < ~19.06 and rounds to exactly 1.0 above that.
    // Pin the asymptote within the audible range we'd actually reach.
    expect(attenumixMath.mixSample(3, 2)).toBeLessThan(1);
    expect(attenumixMath.mixSample(3, 2)).toBeGreaterThan(0.99);
    expect(attenumixMath.mixSample(-3, 2)).toBeGreaterThan(-1);
    expect(attenumixMath.mixSample(-3, 2)).toBeLessThan(-0.99);
  });

  it('symmetric around 0 — bipolar audio preserved at the mix', () => {
    for (const sum of [0.5, 1.0, 2.0, 5.0]) {
      for (const m of [0.5, 1, 2]) {
        expect(attenumixMath.mixSample(-sum, m)).toBeCloseTo(
          -attenumixMath.mixSample(sum, m),
          12,
        );
      }
    }
  });
});

describe('attenumixMath.render: per-channel independence + mix sum', () => {
  it('silent (unpatched) channels do not leak into the mix', () => {
    // Only ch1 patched (in=0.5, knob=1). Other channels' outs must be 0
    // AND the mix must equal tanh(out1 * master) — proving no leakage.
    const N = 16;
    const in1 = new Float32Array(N).fill(0.5);
    const { outs, mix } = attenumixMath.render(
      [in1, null, null, null],
      [null, null, null, null],
      [1, 0, 0, 0],
      1,
      N,
    );
    for (let i = 0; i < N; i++) {
      expect(outs[1]![i]).toBe(0);
      expect(outs[2]![i]).toBe(0);
      expect(outs[3]![i]).toBe(0);
      expect(outs[0]![i]).toBeCloseTo(0.5, 12);
      expect(mix[i]).toBeCloseTo(Math.tanh(0.5), 6);
    }
  });

  it('mix = tanh((out1+out2+out3+out4) * master) sample-by-sample', () => {
    const N = 8;
    const in1 = new Float32Array(N).fill(0.1);
    const in2 = new Float32Array(N).fill(0.1);
    const in3 = new Float32Array(N).fill(0.1);
    const in4 = new Float32Array(N).fill(0.1);
    const { outs, mix } = attenumixMath.render(
      [in1, in2, in3, in4],
      [null, null, null, null],
      [1, 1, 1, 1],
      1.5,
      N,
    );
    for (let i = 0; i < N; i++) {
      const sum = (outs[0]![i] ?? 0) + (outs[1]![i] ?? 0) + (outs[2]![i] ?? 0) + (outs[3]![i] ?? 0);
      expect(mix[i]).toBeCloseTo(Math.tanh(sum * 1.5), 6);
    }
  });

  it('channels are fully independent — different knobs do not cross-talk', () => {
    const N = 4;
    const in1 = new Float32Array(N).fill(0.4);
    const in2 = new Float32Array(N).fill(-0.3);
    const in3 = new Float32Array(N).fill(0.2);
    const in4 = new Float32Array(N).fill(0.1);
    const cv1 = new Float32Array(N).fill(0);
    const cv2 = new Float32Array(N).fill(0.5);
    const cv3 = new Float32Array(N).fill(0);
    const cv4 = new Float32Array(N).fill(0);
    const { outs } = attenumixMath.render(
      [in1, in2, in3, in4],
      [cv1, cv2, cv3, cv4],
      [1.0, 0.3, 0.0, 0.5],
      1,
      N,
    );
    // ch1: 0.4 * clamp(1.0+0)=1.0   = 0.4
    // ch2: -0.3 * clamp(0.3+0.5)=0.8= -0.24
    // ch3: 0.2 * clamp(0+0)=0       = 0  (zero knob+CV mutes)
    // ch4: 0.1 * clamp(0.5+0)=0.5   = 0.05
    expect(outs[0]![0]).toBeCloseTo(0.4,   6);
    expect(outs[1]![0]).toBeCloseTo(-0.24, 6);
    expect(outs[2]![0]).toBe(0);
    expect(outs[3]![0]).toBeCloseTo(0.05,  6);
  });

  it('master>1 + 4 channels full open: mix saturates near ±1 (overdrive story)', () => {
    // 4 channels each at audio=0.5, knob=1.0 → each out = 0.5, sum = 2.0.
    // master=1.5 → tanh(3.0) ≈ 0.9951 — heavy saturation, but not clipped.
    const N = 4;
    const buf = new Float32Array(N).fill(0.5);
    const { mix } = attenumixMath.render(
      [buf, buf, buf, buf],
      [null, null, null, null],
      [1, 1, 1, 1],
      1.5,
      N,
    );
    for (let i = 0; i < N; i++) {
      expect(mix[i]).toBeCloseTo(Math.tanh(3.0), 5);
      expect(Math.abs(mix[i] ?? 0)).toBeLessThan(1);
    }
  });
});
