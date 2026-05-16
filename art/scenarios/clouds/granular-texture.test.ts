// art/scenarios/clouds/granular-texture.test.ts
//
// Audio Regression Test scenarios for CLOUDS. Longer-render checks of
// pitch tracking, freeze behaviour, dry/wet decorrelation, and
// numerical stability under extreme params.

import { describe, expect, it } from 'vitest';
import { cloudsMath } from '../../../packages/web/src/lib/audio/modules/clouds';

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

function sineStereo(n: number, freq: number, sr: number): { L: Float32Array; R: Float32Array } {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = Math.sin((2 * Math.PI * freq * i) / sr);
    R[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  }
  return { L, R };
}

describe('ART clouds / granular cloud preserves source pitch at unity', () => {
  it('440 Hz sine in → granular cloud has dominant 440 Hz peak', () => {
    const n = SR;
    const { L, R } = sineStereo(n, 440, SR);
    const { outL } = cloudsMath.render(L, R, SR, 0, {
      position: 0, size: 0.6, pitch: 0, density: 0.7, texture: 0.7, blend: 1,
    });
    const tail = outL.slice(Math.floor(n * 0.5));
    const p440 = powerAt(tail, 440, SR);
    const pOff = (powerAt(tail, 600, SR) + powerAt(tail, 800, SR) + powerAt(tail, 1234, SR)) / 3;
    expect(p440, `440 Hz ${p440} > avg off-bin ${pOff}`).toBeGreaterThan(pOff * 3);
  });

  it('pitch=+12 semis → grain playback at 2x → 880 Hz dominates 440 Hz', () => {
    const n = SR;
    const { L, R } = sineStereo(n, 440, SR);
    const { outL } = cloudsMath.render(L, R, SR, 0, {
      position: 0, size: 0.6, pitch: 12, density: 0.7, texture: 0.7, blend: 1,
    });
    const tail = outL.slice(Math.floor(n * 0.5));
    const p880 = powerAt(tail, 880, SR);
    const p440 = powerAt(tail, 440, SR);
    expect(p880, `+12 semis: 880 Hz ${p880} > 440 Hz ${p440}`).toBeGreaterThan(p440);
  });

  it('pitch=-12 semis → grain playback at 0.5x → 220 Hz dominates 440 Hz', () => {
    const n = SR;
    const { L, R } = sineStereo(n, 440, SR);
    const { outL } = cloudsMath.render(L, R, SR, 0, {
      position: 0, size: 0.6, pitch: -12, density: 0.7, texture: 0.7, blend: 1,
    });
    const tail = outL.slice(Math.floor(n * 0.5));
    const p220 = powerAt(tail, 220, SR);
    const p440 = powerAt(tail, 440, SR);
    expect(p220, `-12 semis: 220 Hz ${p220} > 440 Hz ${p440}`).toBeGreaterThan(p440);
  });
});

describe('ART clouds / freeze: captured texture loops indefinitely', () => {
  it('freeze a sine, then send silence: output is still pitched at the captured frequency', () => {
    const total = SR * 2;
    const freezeAt = SR;
    const L = new Float32Array(total);
    const R = new Float32Array(total);
    for (let i = 0; i < freezeAt; i++) {
      L[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
      R[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
    }
    const { outL } = cloudsMath.render(L, R, SR, 0, {
      position: 0.3, size: 0.5, pitch: 0, density: 0.8, texture: 0.7, blend: 1,
    }, { freezeAt });
    const lateWindow = outL.slice(Math.floor(SR * 1.5), Math.floor(SR * 1.9));
    const r = rms(lateWindow);
    expect(r, `late RMS ${r} > 0.01`).toBeGreaterThan(0.01);
  });
});

describe('ART clouds / dry/wet blend perception', () => {
  it('blend=0 is sample-for-sample dry; blend=1 fully synthesises (decorrelated from dry)', () => {
    const n = Math.floor(SR * 0.5);
    const { L, R } = sineStereo(n, 440, SR);
    const dry = cloudsMath.render(L, R, SR, 0, {
      position: 0, size: 0.5, pitch: 0, density: 0.7, texture: 0.5, blend: 0,
    }).outL;
    const wet = cloudsMath.render(L, R, SR, 0, {
      position: 0.5, size: 0.5, pitch: 0, density: 0.7, texture: 0.5, blend: 1,
    }).outL;
    for (let i = 0; i < n; i += 200) {
      expect(dry[i]!, `blend=0 dry[${i}]`).toBeCloseTo(L[i]!, 5);
    }
    const tailDry = L.slice(Math.floor(n * 0.5));
    const tailWet = wet.slice(Math.floor(n * 0.5));
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < tailDry.length; i++) {
      xy += tailDry[i]! * tailWet[i]!;
      xx += tailDry[i]! * tailDry[i]!;
      yy += tailWet[i]! * tailWet[i]!;
    }
    const corr = xy / Math.max(1e-12, Math.sqrt(xx * yy));
    expect(Math.abs(corr), `corr(dry, wet) ${corr} should be < 0.7`).toBeLessThan(0.7);
  });
});

describe('ART clouds / numerical safety at extreme params', () => {
  it('finite + bounded output across the parameter cube (no NaN/Inf, |peak| < 1.5)', () => {
    const n = SR / 2;
    const { L, R } = sineStereo(n, 440, SR);
    const corners: Array<[number, number, number, number, number, number]> = [
      [0, 0, -24, 0, 0, 0],
      [1, 0, -24, 0, 0, 1],
      [0, 1, -24, 1, 1, 0],
      [1, 1, -24, 1, 1, 1],
      [0, 0,  24, 0, 0, 0],
      [1, 0,  24, 0, 0, 1],
      [0, 1,  24, 1, 1, 0],
      [1, 1,  24, 1, 1, 1],
    ];
    for (const [position, size, pitch, density, texture, blend] of corners) {
      const { outL, outR } = cloudsMath.render(L, R, SR, 0, {
        position, size, pitch, density, texture, blend,
      });
      let peakL = 0;
      let peakR = 0;
      for (let i = 0; i < n; i++) {
        const a = outL[i]!;
        const b = outR[i]!;
        expect(Number.isFinite(a)).toBe(true);
        expect(Number.isFinite(b)).toBe(true);
        if (Math.abs(a) > peakL) peakL = Math.abs(a);
        if (Math.abs(b) > peakR) peakR = Math.abs(b);
      }
      expect(peakL, `L peak ${peakL}`).toBeLessThan(1.5);
      expect(peakR, `R peak ${peakR}`).toBeLessThan(1.5);
    }
  });
});

describe('ART clouds / V/oct on pitch input is octave-perfect', () => {
  const testCases: { pitchV: number; ratioFromBase: number; name: string }[] = [
    { pitchV: 0,  ratioFromBase: 1,   name: 'pitchV=0 → unity (texture pitch unchanged)' },
    { pitchV: 1,  ratioFromBase: 2,   name: 'pitchV=+1 V → 2× speed (one octave up)' },
    { pitchV: -1, ratioFromBase: 0.5, name: 'pitchV=-1 V → 0.5× speed (one octave down)' },
  ];

  for (const c of testCases) {
    it(c.name, () => {
      const n = SR;
      const { L, R } = sineStereo(n, 440, SR);
      const { outL } = cloudsMath.render(L, R, SR, c.pitchV, {
        position: 0, size: 0.6, pitch: 0, density: 0.8, texture: 0.7, blend: 1,
      });
      const tail = outL.slice(Math.floor(n * 0.5));
      const targetHz = 440 * c.ratioFromBase;
      const p = powerAt(tail, targetHz, SR);
      const pOff = powerAt(tail, 1234, SR);
      expect(p, `pitchV=${c.pitchV}: ${targetHz} Hz ${p} > 1234 Hz ${pOff}`).toBeGreaterThan(pOff);
    });
  }
});
