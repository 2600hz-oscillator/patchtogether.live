// packages/web/src/lib/audio/modules/veils.test.ts
//
// Unit tests for VEILS — quad VCA + soft-clipped summing mix.
// Pin the gain curves (linear vs exponential), per-channel independence,
// the mix-sum identity, the soft-clip onset, and the module-def shape.

import { describe, expect, it } from 'vitest';
import { veilsDef, veilsMath } from './veils';

describe('veilsMath.shape: per-channel gain curve', () => {
  it('linear: 0 → 0, 0.5 → 0.5, 1 → 1, 2 → 2 (identity above zero)', () => {
    expect(veilsMath.shape(0,    'linear')).toBe(0);
    expect(veilsMath.shape(0.5,  'linear')).toBeCloseTo(0.5, 12);
    expect(veilsMath.shape(1,    'linear')).toBeCloseTo(1,   12);
    expect(veilsMath.shape(1.5,  'linear')).toBeCloseTo(1.5, 12);
    expect(veilsMath.shape(2,    'linear')).toBeCloseTo(2,   12);
  });

  it('exponential: 0.5 → 0.25, 1 → 1, 2 → 4 — squared above zero', () => {
    expect(veilsMath.shape(0,    'exponential')).toBe(0);
    expect(veilsMath.shape(0.5,  'exponential')).toBeCloseTo(0.25, 12);
    expect(veilsMath.shape(1,    'exponential')).toBeCloseTo(1,    12);
    expect(veilsMath.shape(1.5,  'exponential')).toBeCloseTo(2.25, 12);
    expect(veilsMath.shape(2,    'exponential')).toBeCloseTo(4,    12);
  });

  it('negative raw gain (knob+cv < 0) mutes in both curves', () => {
    // Veils is a unipolar VCA — phase-flip behaviour belongs to STEREOVCA's
    // bipolar carrier. A negative gain pre-multiplication is rectified to
    // 0 so a sub-zero CV doesn't fold the audio polarity.
    for (const raw of [-0.001, -0.5, -1, -2]) {
      expect(veilsMath.shape(raw, 'linear')).toBe(0);
      expect(veilsMath.shape(raw, 'exponential')).toBe(0);
    }
  });

  it('exp curve crosses the linear curve at gain=1 (the design pivot)', () => {
    // x*x = x → x ∈ {0, 1}. Below 1 expo < linear (slower attack), above 1
    // expo > linear (steeper drive). This is the "smooth fade" behaviour.
    expect(veilsMath.shape(0.8, 'exponential')).toBeLessThan(
      veilsMath.shape(0.8, 'linear'),
    );
    expect(veilsMath.shape(1.5, 'exponential')).toBeGreaterThan(
      veilsMath.shape(1.5, 'linear'),
    );
  });
});

describe('veilsMath.channelSample: per-channel multiply', () => {
  it('unity-gain knob + zero CV passes audio through unchanged in linear mode', () => {
    for (const x of [-0.9, -0.5, 0, 0.25, 0.7]) {
      expect(veilsMath.channelSample(x, 1, 0, 'linear')).toBeCloseTo(x, 12);
    }
  });

  it('zero knob + zero CV mutes', () => {
    expect(Math.abs(veilsMath.channelSample(0.7,  0, 0, 'linear'))).toBe(0);
    expect(Math.abs(veilsMath.channelSample(-0.3, 0, 0, 'exponential'))).toBe(0);
  });

  it('CV adds to the knob: 0.5 knob + 0.5 CV = unity in linear mode', () => {
    expect(veilsMath.channelSample(0.6, 0.5, 0.5, 'linear')).toBeCloseTo(0.6, 12);
  });

  it('CV pushes gain above unity (no clip at the channel level)', () => {
    // gain knob 1.0 + CV +1.0 = raw 2.0 → linear gain 2.0.
    // Per-channel out is NOT clipped (only the mix is), so x=0.5 * 2.0 = 1.0.
    expect(veilsMath.channelSample(0.5, 1.0, 1.0, 'linear')).toBeCloseTo(1.0, 12);
    // In expo the same drive lifts gain to 4.0 → x=0.5 * 4.0 = 2.0.
    expect(veilsMath.channelSample(0.5, 1.0, 1.0, 'exponential')).toBeCloseTo(2.0, 12);
  });
});

describe('veilsMath.render: per-channel independence', () => {
  it('silent (unpatched) channels do not leak into the mix', () => {
    // Only ch1 is patched (audio in1 = 0.5, knob1 = 1, linear). ch2..ch4
    // have null audio + null CV + zero knobs. Their outs must be silent
    // AND the mix must equal tanh(out1) — proving no leakage.
    const N = 32;
    const in1 = new Float32Array(N).fill(0.5);
    const { outs, mix } = veilsMath.render(
      [in1, null, null, null],
      [null, null, null, null],
      [1, 0, 0, 0],
      ['linear', 'linear', 'linear', 'linear'],
      N,
    );
    for (let i = 0; i < N; i++) {
      expect(outs[1]![i]).toBe(0);
      expect(outs[2]![i]).toBe(0);
      expect(outs[3]![i]).toBe(0);
      expect(outs[0]![i]).toBeCloseTo(0.5, 12);
      // mix = tanh(0.5 + 0 + 0 + 0) ≈ 0.4621
      expect(mix[i]).toBeCloseTo(Math.tanh(0.5), 6);
    }
  });

  it('channels are fully independent — different knobs + CVs do not cross-talk', () => {
    const N = 16;
    const in1 = new Float32Array(N).fill(0.4);
    const in2 = new Float32Array(N).fill(-0.3);
    const in3 = new Float32Array(N).fill(0.2);
    const in4 = new Float32Array(N).fill(0.1);
    const cv1 = new Float32Array(N).fill(0);
    const cv2 = new Float32Array(N).fill(0.5);
    const cv3 = new Float32Array(N).fill(0);
    const cv4 = new Float32Array(N).fill(0);
    const { outs } = veilsMath.render(
      [in1, in2, in3, in4],
      [cv1, cv2, cv3, cv4],
      [1.0, 0.5, 0.0, 1.0],
      ['linear', 'linear', 'linear', 'linear'],
      N,
    );
    // ch1: 0.4 * (1.0 + 0)   = 0.4
    // ch2: -0.3 * (0.5 + 0.5)= -0.3
    // ch3: 0.2 * (0 + 0)     = 0  (zero knob mutes regardless of CV/audio)
    // ch4: 0.1 * (1.0 + 0)   = 0.1
    expect(outs[0]![0]).toBeCloseTo(0.4,  6);
    expect(outs[1]![0]).toBeCloseTo(-0.3, 6);
    expect(outs[2]![0]).toBe(0);
    expect(outs[3]![0]).toBeCloseTo(0.1,  6);
  });
});

describe('veilsMath.render: mix-sum identity', () => {
  it('mix = tanh(out1 + out2 + out3 + out4) sample-by-sample', () => {
    // Use small enough values that tanh is roughly linear (saves a separate
    // soft-clip assertion); we just want to verify the summation path.
    const N = 8;
    const in1 = new Float32Array(N).fill(0.1);
    const in2 = new Float32Array(N).fill(0.1);
    const in3 = new Float32Array(N).fill(0.1);
    const in4 = new Float32Array(N).fill(0.1);
    const { outs, mix } = veilsMath.render(
      [in1, in2, in3, in4],
      [null, null, null, null],
      [1, 1, 1, 1],
      ['linear', 'linear', 'linear', 'linear'],
      N,
    );
    for (let i = 0; i < N; i++) {
      const sum = (outs[0]![i] ?? 0) + (outs[1]![i] ?? 0) + (outs[2]![i] ?? 0) + (outs[3]![i] ?? 0);
      expect(mix[i]).toBeCloseTo(Math.tanh(sum), 6);
    }
  });
});

describe('veilsMath.softClip: tanh saturation onset', () => {
  it('small signals pass nearly linearly (derivative at 0 = 1)', () => {
    expect(veilsMath.softClip(0)).toBe(0);
    expect(veilsMath.softClip(0.1)).toBeCloseTo(Math.tanh(0.1), 6);
    // ratio of out/in approaches 1 as in → 0; tanh(0.05)/0.05 ≈ 0.9992
    expect(veilsMath.softClip(0.05) / 0.05).toBeGreaterThan(0.99);
    expect(veilsMath.softClip(0.05) / 0.05).toBeLessThan(1);
  });

  it('saturation kicks in above unity: clip(1.0) ≈ 0.762, clip(2.0) ≈ 0.964', () => {
    // tanh(1) = 0.7615941...
    expect(veilsMath.softClip(1)).toBeCloseTo(0.7615941, 5);
    // tanh(2) = 0.9640275...
    expect(veilsMath.softClip(2)).toBeCloseTo(0.9640275, 5);
    // Large signals are bounded asymptotically below 1; no digital hard-clip.
    expect(veilsMath.softClip(10)).toBeLessThan(1);
    expect(veilsMath.softClip(10)).toBeGreaterThan(0.99);
  });

  it('symmetric around 0 — soft-clip preserves audio bipolarity at the mix', () => {
    for (const x of [0.5, 1.0, 1.5, 2.0, 5.0]) {
      expect(veilsMath.softClip(-x)).toBeCloseTo(-veilsMath.softClip(x), 12);
    }
  });

  it('overdrive: 4 channels each at unity (sum=4) saturate the mix to near ±1', () => {
    // Render: 4 channels with audio=0.5 + knob=1, linear → each out = 0.5,
    // sum = 2.0, tanh(2) ≈ 0.964. Verify the worklet's "pushing past 1.0
    // gets warm overdrive" story end-to-end.
    const N = 4;
    const buf = new Float32Array(N).fill(0.5);
    const { mix } = veilsMath.render(
      [buf, buf, buf, buf],
      [null, null, null, null],
      [1, 1, 1, 1],
      ['linear', 'linear', 'linear', 'linear'],
      N,
    );
    for (let i = 0; i < N; i++) {
      expect(mix[i]).toBeCloseTo(Math.tanh(2), 5);
      expect(Math.abs(mix[i] ?? 0)).toBeLessThan(1);
    }
  });
});

describe('veilsDef: module-def shape', () => {
  it('declares type=veils, label=VEILS, category=utilities, domain=audio', () => {
    expect(veilsDef.type).toBe('veils');
    expect(veilsDef.label).toBe('VEILS');
    expect(veilsDef.category).toBe('utilities');
    expect(veilsDef.domain).toBe('audio');
  });

  it('exposes 8 inputs: in1..in4 (audio) + cv1..cv4 (cv)', () => {
    const ids = veilsDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['cv1', 'cv2', 'cv3', 'cv4', 'in1', 'in2', 'in3', 'in4']);
    const byId = Object.fromEntries(veilsDef.inputs.map((p) => [p.id, p]));
    for (let ch = 1; ch <= 4; ch++) {
      expect(byId[`in${ch}`]!.type).toBe('audio');
      expect(byId[`cv${ch}`]!.type).toBe('cv');
      // CV ports are PASSTHROUGH_BY_DESIGN (raw bipolar carrier consumed
      // in the multiply, no cvScale needed; gain range [0,2] already
      // accommodates ±1V CV at unity-knob).
      expect(byId[`cv${ch}`]!.cvScale).toBeUndefined();
      expect(byId[`cv${ch}`]!.paramTarget).toBeUndefined();
    }
  });

  it('exposes 5 audio outputs: out1..out4 + mix', () => {
    const ids = veilsDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['mix', 'out1', 'out2', 'out3', 'out4']);
    for (const p of veilsDef.outputs) {
      expect(p.type).toBe('audio');
    }
  });

  it('exposes 8 params: gain1..gain4 (0..2, default 0) + resp1..resp4 (0|1)', () => {
    const ids = veilsDef.params.map((p) => p.id).sort();
    expect(ids).toEqual([
      'gain1', 'gain2', 'gain3', 'gain4',
      'resp1', 'resp2', 'resp3', 'resp4',
    ]);
    for (let ch = 1; ch <= 4; ch++) {
      const g = veilsDef.params.find((p) => p.id === `gain${ch}`);
      expect(g?.min).toBe(0);
      // [0, 2] range means knob-at-unity + CV-at-+1V can reach the
      // soft-clip onset — the whole point of Veils.
      expect(g?.max).toBe(2);
      expect(g?.defaultValue).toBe(0);

      const r = veilsDef.params.find((p) => p.id === `resp${ch}`);
      expect(r?.min).toBe(0);
      expect(r?.max).toBe(1);
      expect(r?.curve).toBe('discrete');
    }
    // Mix of curve defaults: first two linear, last two expo so a fresh
    // module covers both use cases out of the box.
    expect(veilsDef.params.find((p) => p.id === 'resp1')!.defaultValue).toBe(0);
    expect(veilsDef.params.find((p) => p.id === 'resp2')!.defaultValue).toBe(0);
    expect(veilsDef.params.find((p) => p.id === 'resp3')!.defaultValue).toBe(1);
    expect(veilsDef.params.find((p) => p.id === 'resp4')!.defaultValue).toBe(1);
  });

  it('has handle count 13 (8 inputs + 5 outputs)', () => {
    const total = veilsDef.inputs.length + veilsDef.outputs.length;
    expect(total).toBe(13);
  });
});
