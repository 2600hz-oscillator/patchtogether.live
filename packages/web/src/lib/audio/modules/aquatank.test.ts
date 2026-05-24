// packages/web/src/lib/audio/modules/aquatank.test.ts
//
// Unit-test the AQUATANK module-def shape. Worklet behavior (FDN stability,
// audible chorus shimmer) is exercised by the Atlantis-patch E2E.

import { describe, it, expect } from 'vitest';
import { aquaTankDef } from './aquatank';

describe('aquaTankDef shape', () => {
  it('declares 4 audio inputs + 4 fb cv inputs + tilt cv', () => {
    const ids = aquaTankDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'fb1_cv', 'fb2_cv', 'fb3_cv', 'fb4_cv',
      'in1', 'in2', 'in3', 'in4',
      'tilt_cv',
    ]);
  });

  it('declares 4 per-channel outs + stereo mix_l / mix_r', () => {
    const ids = aquaTankDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['mix_l', 'mix_r', 'out1', 'out2', 'out3', 'out4']);
  });

  it('declares the mix_l/mix_r stereo pair for the engine normaling rule', () => {
    expect(aquaTankDef.stereoPairs).toBeDefined();
    expect(aquaTankDef.stereoPairs).toEqual([['mix_l', 'mix_r']]);
  });

  it('feedback params are clamped to 0..0.95 for stability', () => {
    for (const k of ['fb1', 'fb2', 'fb3', 'fb4'] as const) {
      const p = aquaTankDef.params.find((x) => x.id === k)!;
      expect(p.min).toBe(0);
      expect(p.max).toBe(0.95);
    }
  });

  it('tilt is signed (-1..+1) and damp / crossMix / spread / outLevel are 0..1', () => {
    expect(aquaTankDef.params.find((p) => p.id === 'tilt')?.min).toBe(-1);
    expect(aquaTankDef.params.find((p) => p.id === 'tilt')?.max).toBe(1);
    for (const k of ['damp', 'crossMix', 'spread', 'outLevel'] as const) {
      const p = aquaTankDef.params.find((x) => x.id === k)!;
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
    }
  });

  it('fb cv inputs each declare their paramTarget', () => {
    for (const k of ['fb1_cv', 'fb2_cv', 'fb3_cv', 'fb4_cv'] as const) {
      const p = aquaTankDef.inputs.find((x) => x.id === k)!;
      expect(p.paramTarget).toBe(k.replace('_cv', ''));
    }
  });
});
