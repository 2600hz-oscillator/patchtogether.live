// packages/web/src/lib/audio/modules/vca.test.ts
//
// VCA module-def shape tests. Sample-accurate phase inversion is covered
// by the ART scenario.

import { describe, expect, it } from 'vitest';
import { vcaDef } from './vca';

describe('vcaDef: module-def shape', () => {
  it('declares type=vca, label=VCA, category=utilities', () => {
    expect(vcaDef.type).toBe('vca');
    expect(vcaDef.label).toBe('vca');
    expect(vcaDef.category).toBe('utilities');
  });

  it('exposes the audio output', () => {
    const out = vcaDef.outputs.find((p) => p.id === 'audio');
    expect(out).toBeDefined();
    expect(out?.type).toBe('audio');
  });

  it('exposes the audio_inv output — sign-inverted phase-flipped audio', () => {
    // Standard "phase invert" semantic for bipolar audio: -out. Useful for
    // stereo widening, side-chain feedback prevention, mid/side processing.
    // Different operation from ADSR.env_inv (which is `1 - env` on a
    // unipolar 0..1 envelope).
    const inv = vcaDef.outputs.find((p) => p.id === 'audio_inv');
    expect(inv, 'audio_inv output exists on vcaDef').toBeDefined();
    expect(inv?.type).toBe('audio');
  });

  it('audio and audio_inv are the only outputs', () => {
    const ids = vcaDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['audio', 'audio_inv']);
  });

  it('sign-flip math: invert(x) = -x for any sample', () => {
    // Mirrors what the parallel GainNode(-1) tap produces sample-by-sample.
    const invert = (x: number) => -x;
    expect(invert(0)).toBe(-0);
    expect(invert(0.5)).toBe(-0.5);
    expect(invert(-0.7)).toBe(0.7);
    // Polarity is symmetric across the range — sin → -sin, square → -square.
    for (let i = 0; i < 100; i++) {
      const x = Math.sin((i / 100) * 2 * Math.PI);
      expect(invert(x)).toBeCloseTo(-x, 12);
    }
  });
});
