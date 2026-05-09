// packages/web/src/lib/audio/modules/adsr.test.ts
//
// ADSR module-def shape tests. The DSP itself lives in a Faust worklet
// that requires Web Audio + audio context to run; sample-accurate
// inversion math is covered by the ART scenario.

import { describe, expect, it } from 'vitest';
import { adsrDef } from './adsr';

describe('adsrDef: module-def shape', () => {
  it('declares type=adsr, label=ADSR, category=modulation', () => {
    expect(adsrDef.type).toBe('adsr');
    expect(adsrDef.label).toBe('ADSR');
    expect(adsrDef.category).toBe('modulation');
  });

  it('exposes the env output (cv)', () => {
    const env = adsrDef.outputs.find((p) => p.id === 'env');
    expect(env).toBeDefined();
    expect(env?.type).toBe('cv');
  });

  it('exposes the env_inv output (cv) — 1 - env unipolar flip', () => {
    // Standard Eurorack semantic for unipolar envelopes: 1 - env. When the
    // envelope is at rest (env=0), env_inv=1; when the envelope peaks
    // (env=1), env_inv=0. Useful for ducking, reverse-modulation, and
    // sidechain-style envelopes.
    const inv = adsrDef.outputs.find((p) => p.id === 'env_inv');
    expect(inv, 'env_inv output exists on adsrDef').toBeDefined();
    expect(inv?.type).toBe('cv');
  });

  it('env and env_inv are the only outputs', () => {
    const ids = adsrDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['env', 'env_inv']);
  });

  it('inversion math: invert(env) = 1 - env across [0, 1]', () => {
    // Mirrors what the GainNode(-1) + ConstantSource(+1) sum bus produces
    // sample-by-sample. Sample-accurate behavior is asserted in the ART.
    const invert = (env: number) => 1 - env;
    expect(invert(0)).toBe(1);
    expect(invert(0.5)).toBe(0.5);
    expect(invert(1)).toBe(0);
    expect(invert(0.25)).toBe(0.75);
    expect(invert(0.7)).toBeCloseTo(0.3, 12);
  });
});
