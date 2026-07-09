// packages/web/src/lib/audio/modules/clouds.test.ts
//
// Unit tests for CLOUDS:
//   - module-def shape (ports, params, cvScale annotations)
//   - grain envelope morph (rectangular → triangular → Hann)
//   - cloudsMath.render basic invariants: dry-only when blend=0,
//     wet contributes energy when blend > 0, freeze stops capture
//
// Worklet-level behaviour (rising-edge freeze gate, AudioWorklet message
// passing) is covered by the Playwright E2E + ART scenarios.

import { describe, expect, it } from 'vitest';
import { cloudsMath, type CloudsParams } from './clouds';

const SR = 48000;

function powerAt(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

function sineStereo(n: number, freq: number): { L: Float32Array; R: Float32Array } {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = Math.sin((2 * Math.PI * freq * i) / SR);
    R[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return { L, R };
}

describe('cloudsMath.grainEnvelope', () => {
  it('returns 0 outside [0..1)', () => {
    for (const tex of [0, 0.5, 1]) {
      expect(cloudsMath.grainEnvelope(-0.1, tex)).toBe(0);
      expect(cloudsMath.grainEnvelope(1.0, tex)).toBe(0);
      expect(cloudsMath.grainEnvelope(1.5, tex)).toBe(0);
    }
  });

  it('rectangular at texture=0: ~1.0 across the middle of the grain', () => {
    expect(cloudsMath.grainEnvelope(0.1, 0)).toBeCloseTo(1, 5);
    expect(cloudsMath.grainEnvelope(0.5, 0)).toBeCloseTo(1, 5);
    expect(cloudsMath.grainEnvelope(0.9, 0)).toBeCloseTo(1, 5);
  });

  it('triangular at texture=0.5: peak 1.0 at phase 0.5, drops to 0 at edges', () => {
    expect(cloudsMath.grainEnvelope(0.5, 0.5)).toBeCloseTo(1, 5);
    expect(cloudsMath.grainEnvelope(0.0, 0.5)).toBeCloseTo(0, 5);
    expect(cloudsMath.grainEnvelope(0.25, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('Hann at texture=1.0: 0 at edges, 1 at centre, smooth curve', () => {
    expect(cloudsMath.grainEnvelope(0.0, 1)).toBeCloseTo(0, 5);
    expect(cloudsMath.grainEnvelope(0.5, 1)).toBeCloseTo(1, 5);
    expect(cloudsMath.grainEnvelope(0.25, 1)).toBeCloseTo(0.5, 5);
  });

  it('every (phase, texture) sample stays in [0, 1.0001]', () => {
    for (let p = 0; p < 1; p += 0.05) {
      for (let t = 0; t <= 1; t += 0.1) {
        const v = cloudsMath.grainEnvelope(p, t);
        expect(v, `phase=${p}, tex=${t}`).toBeGreaterThanOrEqual(0);
        expect(v, `phase=${p}, tex=${t}`).toBeLessThanOrEqual(1.0001);
      }
    }
  });
});

describe('cloudsMath.render: dry/wet blend', () => {
  // Use position=0 (newest history) so grains read from the most-recently-
  // written buffer region. During warmup, position=0.5 would have grains
  // reading from pre-fill zeros.
  const baseParams: CloudsParams = {
    position: 0,
    size: 0.4,
    pitch: 0,
    density: 0.7,
    texture: 0.5,
    blend: 0.5,
  };

  it('blend=0: output equals dry input (full bypass)', () => {
    const n = SR / 4;
    const { L, R } = sineStereo(n, 440);
    const { outL, outR } = cloudsMath.render(L, R, SR, 0, { ...baseParams, blend: 0 });
    for (let i = 0; i < n; i += 100) {
      expect(outL[i]!).toBeCloseTo(L[i]!, 6);
      expect(outR[i]!).toBeCloseTo(R[i]!, 6);
    }
  });

  it('blend=1: full-wet output is non-silent (cloud carries energy)', () => {
    const n = SR;
    const { L, R } = sineStereo(n, 440);
    const { outL, outR } = cloudsMath.render(L, R, SR, 0, { ...baseParams, blend: 1 });
    const tail = outL.slice(Math.floor(n * 0.5));
    expect(rms(tail), `wet RMS ${rms(tail)} > 0.01`).toBeGreaterThan(0.01);
    expect(rms(outR.slice(Math.floor(n * 0.5)))).toBeGreaterThan(0.01);
  });

  it('blend=1 with 440 Hz sine in carries 440 Hz energy in the cloud', () => {
    const n = SR;
    const { L, R } = sineStereo(n, 440);
    const { outL } = cloudsMath.render(L, R, SR, 0, { ...baseParams, blend: 1 });
    const tail = outL.slice(Math.floor(n * 0.5));
    const p440 = powerAt(tail, 440, SR);
    const pOff = powerAt(tail, 1234, SR);
    expect(p440, `440 Hz ${p440} > off-bin 1234 Hz ${pOff}`).toBeGreaterThan(pOff * 3);
  });
});

describe('cloudsMath.render: density mapping', () => {
  it('density=0 (sparse) produces lower RMS than density=1 (dense)', () => {
    const n = SR;
    const { L, R } = sineStereo(n, 440);
    const sparse = cloudsMath.render(L, R, SR, 0, {
      position: 0, size: 0.5, pitch: 0, density: 0, texture: 0.5, blend: 1,
    }).outL;
    const dense = cloudsMath.render(L, R, SR, 0, {
      position: 0, size: 0.5, pitch: 0, density: 1, texture: 0.5, blend: 1,
    }).outL;
    const sparseRms = rms(sparse.slice(Math.floor(n * 0.5)));
    const denseRms = rms(dense.slice(Math.floor(n * 0.5)));
    expect(denseRms, `dense RMS ${denseRms} > sparse RMS ${sparseRms}`).toBeGreaterThan(sparseRms);
  });
});

describe('cloudsMath.render: freeze', () => {
  it('freeze preserves output energy after silent input takes over', () => {
    // Phase 1: 1.0 s of 440 Hz input. Freeze latches at 1.0 s.
    // Phase 2: silent input for 1.0 s more — but the frozen buffer keeps
    // the texture, so the cloud still produces output.
    const n = SR * 2;
    const half = SR;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < half; i++) {
      L[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
      R[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
    }
    const { outL } = cloudsMath.render(L, R, SR, 0, {
      position: 0.3, size: 0.5, pitch: 0, density: 0.8, texture: 0.7, blend: 1,
    }, { freezeAt: half });
    // 0.3-0.9 s after freeze: grains still feed from the 440 Hz texture.
    const postFreeze = outL.slice(half + Math.floor(SR * 0.3), n - Math.floor(SR * 0.1));
    expect(rms(postFreeze), `post-freeze RMS ${rms(postFreeze)} > 0.005`).toBeGreaterThan(0.005);
  });
});

describe('cloudsMath.render: numerical safety', () => {
  it('finite + bounded output at extreme params (no NaN/Inf, |peak| < 1.5)', () => {
    const n = SR / 2;
    const { L, R } = sineStereo(n, 440);
    for (const texture of [0, 0.5, 1]) {
      const { outL, outR } = cloudsMath.render(L, R, SR, 0, {
        position: 0.5, size: 1, pitch: 24, density: 1, texture, blend: 1,
      });
      let peakL = 0;
      let peakR = 0;
      for (let i = 0; i < n; i++) {
        expect(Number.isFinite(outL[i]!), `texture=${texture} L[${i}]`).toBe(true);
        expect(Number.isFinite(outR[i]!), `texture=${texture} R[${i}]`).toBe(true);
        const a = Math.abs(outL[i]!);
        const b = Math.abs(outR[i]!);
        if (a > peakL) peakL = a;
        if (b > peakR) peakR = b;
      }
      expect(peakL, `tex=${texture} L peak ${peakL}`).toBeLessThan(1.5);
      expect(peakR, `tex=${texture} R peak ${peakR}`).toBeLessThan(1.5);
    }
  });
});

describe('cloudsMath.render: V/oct on pitch', () => {
  it('pitchV=1 (1 V/oct up) doubles the grain playback rate vs pitchV=0', () => {
    const n = SR;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = Math.sin((2 * Math.PI * 220 * i) / SR);
      R[i] = Math.sin((2 * Math.PI * 220 * i) / SR);
    }
    const unityOut = cloudsMath.render(L, R, SR, 0, {
      position: 0, size: 0.5, pitch: 0, density: 0.8, texture: 0.7, blend: 1,
    }).outL.slice(Math.floor(n * 0.5));
    const octUpOut = cloudsMath.render(L, R, SR, 1, {
      position: 0, size: 0.5, pitch: 0, density: 0.8, texture: 0.7, blend: 1,
    }).outL.slice(Math.floor(n * 0.5));
    expect(powerAt(unityOut, 220, SR)).toBeGreaterThan(powerAt(unityOut, 440, SR));
    expect(powerAt(octUpOut, 440, SR)).toBeGreaterThan(powerAt(octUpOut, 220, SR));
  });
});
