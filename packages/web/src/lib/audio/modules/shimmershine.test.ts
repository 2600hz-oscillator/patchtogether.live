// packages/web/src/lib/audio/modules/shimmershine.test.ts
//
// Unit tests for SHIMMERSHINE:
//   - module-def shape (ports, params, cvScale annotations)
//   - pitch-shifter math: a 440Hz sine driven through the pure-TS pitch
//     shifter exposed via shimmershineMath.renderPitchShifter produces
//     significant 880Hz energy (i.e. the granular-fade scheme actually
//     shifts an octave up).
//
// Worklet-level behavior (tank routing, feedback cap) is covered by the
// ART scenario which runs against a real OfflineAudioContext.

import { describe, expect, it } from 'vitest';
import { shimmershineDef, shimmershineMath } from './shimmershine';

describe('shimmershineDef shape', () => {
  it('declares the expected ports (2 audio + 4 cv in, 2 audio out)', () => {
    const inputs = shimmershineDef.inputs;
    const outputs = shimmershineDef.outputs;
    expect(inputs.map((p) => p.id)).toEqual([
      'in_l', 'in_r', 'decay_cv', 'shimmer_cv', 'size_cv', 'mix_cv',
    ]);
    expect(outputs.map((p) => p.id)).toEqual(['out_l', 'out_r']);
    expect(inputs.filter((p) => p.type === 'audio')).toHaveLength(2);
    expect(inputs.filter((p) => p.type === 'cv')).toHaveLength(4);
  });

  it('every cv input has cvScale + paramTarget (no PASSTHROUGH_BY_DESIGN cases)', () => {
    for (const p of shimmershineDef.inputs) {
      if (p.type !== 'cv') continue;
      expect(p.cvScale, `${p.id} cvScale`).toBeDefined();
      expect(p.paramTarget, `${p.id} paramTarget`).toBeDefined();
    }
  });

  it('all 5 params live in [0..1] linear', () => {
    expect(shimmershineDef.params.map((p) => p.id)).toEqual([
      'decay', 'shimmer', 'size', 'damp', 'mix',
    ]);
    for (const p of shimmershineDef.params) {
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.curve).toBe('linear');
    }
  });
});

describe('shimmershineMath.hannWindow', () => {
  it('phase 0 and phase 1 both return 0 (window endpoints)', () => {
    expect(shimmershineMath.hannWindow(0)).toBeCloseTo(0, 6);
    expect(shimmershineMath.hannWindow(1)).toBeCloseTo(0, 6);
  });

  it('phase 0.5 returns the peak (= 1)', () => {
    expect(shimmershineMath.hannWindow(0.5)).toBeCloseTo(1, 6);
  });

  it('window stays in [0..1] across the full phase domain', () => {
    for (let i = 0; i <= 64; i++) {
      const phase = i / 64;
      const v = shimmershineMath.hannWindow(phase);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('granular pitch shifter: 440Hz → 880Hz octave-up shift', () => {
  it('output spectrum at rate=2 concentrates energy around 880Hz (octave up), not 440Hz', () => {
    const sr = 48000;
    const f0 = 440;
    const durS = 1.0;
    const n = Math.round(sr * durS);
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = Math.sin((2 * Math.PI * f0 * i) / sr);
    }

    const out = shimmershineMath.renderPitchShifter(input, sr, 2.0, 25);

    // Use the second half of the output to skip pitch-shifter warmup.
    const slice = out.slice(Math.floor(out.length * 0.5));

    // Goertzel-style power at a target frequency.
    function powerAt(freq: number): number {
      const w = (2 * Math.PI * freq) / sr;
      let re = 0;
      let im = 0;
      for (let i = 0; i < slice.length; i++) {
        re += slice[i]! * Math.cos(w * i);
        im += slice[i]! * Math.sin(w * i);
      }
      return Math.sqrt(re * re + im * im) / slice.length;
    }

    // Band-sum power in a ±60Hz region around a target. The granular-fade
    // shifter's Hann window produces AM sidebands at f ± (1/windowMs), so
    // the octave-up energy appears in a small cluster around 880Hz rather
    // than at exactly 880Hz. Test by integrating the band instead.
    function bandPower(centre: number, bandHz: number): number {
      let total = 0;
      // 10Hz step is fine for a ±60Hz band — that's 12+ samples per band.
      for (let f = centre - bandHz; f <= centre + bandHz; f += 10) {
        total += powerAt(f);
      }
      return total;
    }

    const bandAt440 = bandPower(440, 60);
    const bandAt880 = bandPower(880, 60);
    const bandAt220 = bandPower(220, 60);

    // Octave-up band must dominate fundamental band by a clear margin.
    expect(
      bandAt880,
      `880Hz band ${bandAt880}, 440Hz band ${bandAt440}, 220Hz band ${bandAt220}`,
    ).toBeGreaterThan(bandAt440 * 5);
    // 220Hz (sub-octave) should be the smallest of the three.
    expect(bandAt220).toBeLessThan(bandAt880);
  });
});
