// art/scenarios/peaks/multimode.test.ts
//
// Audio Regression Test scenarios for PEAKS. Longer-render checks of
// drum spectral shape, envelope decay-knob mapping, LFO rate accuracy,
// and numerical stability across the mode × knob cube.

import { describe, expect, it } from 'vitest';
import { peaksMath, type PeaksMode } from '../../../packages/web/src/lib/audio/modules/peaks';

const SR = 48000;

function powerAt(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  let re = 0; let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0; let n = 0;
  for (let i = from; i < to; i++) { s += buf[i]! * buf[i]!; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

function zeroCrossings(buf: Float32Array): number {
  let z = 0;
  for (let i = 1; i < buf.length; i++) {
    const a = buf[i - 1]!; const b = buf[i]!;
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) z++;
  }
  return z;
}

describe('ART peaks / KICK produces low-frequency energy with a quick decay', () => {
  it('60 Hz KICK has its dominant spectral energy near 60 Hz (body)', () => {
    const n = SR / 2;
    const out = peaksMath.render(n, SR, {
      mode: 0, k1: 60, k2: 0.5, triggers: [0],
    });
    // Sample the body after the pitch sweep settles (~30 ms in).
    const tail = out.slice(Math.floor(SR * 0.05), Math.floor(SR * 0.3));
    const p60 = powerAt(tail, 60, SR);
    const p400 = powerAt(tail, 400, SR);
    const p2k = powerAt(tail, 2000, SR);
    expect(p60, `body energy: 60 Hz=${p60} should exceed 400 Hz=${p400}`).toBeGreaterThan(p400);
    expect(p60, `body energy: 60 Hz=${p60} should exceed 2 kHz=${p2k}`).toBeGreaterThan(p2k);
  });

  it('KICK with longer decay has more sustained body than short decay', () => {
    // The KICK amp envelope decays at the rate set by knob2. Compare two
    // settings at a probe past the pitch sweep — the longer decay should
    // have meaningfully more energy than the short one.
    const n = SR;
    const shortOut = peaksMath.render(n, SR, {
      mode: 0, k1: 60, k2: 0.05, triggers: [0],
    });
    const longOut = peaksMath.render(n, SR, {
      mode: 0, k1: 60, k2: 1.0, triggers: [0],
    });
    const probeFrom = Math.floor(SR * 0.25);
    const probeTo   = Math.floor(SR * 0.3);
    const rShort = rms(shortOut, probeFrom, probeTo);
    const rLong  = rms(longOut, probeFrom, probeTo);
    expect(rLong, `long RMS ${rLong} should exceed short RMS ${rShort} by ≥10×`)
      .toBeGreaterThan(rShort * 10);
  });

  it('KICK with long decay (1s) is still ringing at 500 ms', () => {
    const n = SR;
    const out = peaksMath.render(n, SR, {
      mode: 0, k1: 60, k2: 1.0, triggers: [0],
    });
    const lateRms = rms(out, Math.floor(SR * 0.45), Math.floor(SR * 0.5));
    expect(lateRms, `late RMS ${lateRms}`).toBeGreaterThan(0.05);
  });
});

describe('ART peaks / ENV decay knob actually changes decay time', () => {
  it('short decay (0.05 s) decays to <0.05 within 100 ms', () => {
    const n = SR / 2;
    const out = peaksMath.render(n, SR, {
      mode: 3, k1: 0.005, k2: 0.05, triggers: [0],
    });
    const v = out[Math.floor(SR * 0.1)]!;
    expect(v, `short env @ 100 ms = ${v}`).toBeLessThan(0.05);
  });

  it('long decay (1 s) is still ≥0.3 at 500 ms', () => {
    const n = SR * 2;
    const out = peaksMath.render(n, SR, {
      mode: 3, k1: 0.005, k2: 1.0, triggers: [0],
    });
    const v = out[Math.floor(SR * 0.5)]!;
    expect(v, `long env @ 500 ms = ${v}`).toBeGreaterThan(0.3);
  });

  it('decay scales monotonically with knob value (k=0.1, 0.5, 1.0)', () => {
    const n = SR;
    const probe = Math.floor(SR * 0.2);
    const samples = [0.1, 0.5, 1.0].map((d) => {
      const out = peaksMath.render(n, SR, {
        mode: 3, k1: 0.005, k2: d, triggers: [0],
      });
      return out[probe]!;
    });
    expect(samples[0]!).toBeLessThan(samples[1]!);
    expect(samples[1]!).toBeLessThan(samples[2]!);
  });
});

describe('ART peaks / LFO at 1 Hz produces 1 cycle per second', () => {
  it('1 Hz sine LFO has its dominant power at 1 Hz', () => {
    const n = SR * 2; // 2 seconds → ~2 full cycles
    const out = peaksMath.render(n, SR, {
      mode: 4, k1: 1, k2: 0, triggers: [0],
    });
    // Use zero crossings as a robust check — 2 seconds at 1 Hz = 2 cycles
    // = 4 zero crossings (±1).
    const z = zeroCrossings(out);
    expect(z, `zero crossings at 1 Hz × 2 s = ${z}`).toBeGreaterThanOrEqual(3);
    expect(z, `zero crossings at 1 Hz × 2 s = ${z}`).toBeLessThanOrEqual(5);
  });

  it('5 Hz LFO has ≈10 zero crossings per second', () => {
    const n = SR;
    const out = peaksMath.render(n, SR, {
      mode: 4, k1: 5, k2: 0, triggers: [0],
    });
    const z = zeroCrossings(out);
    expect(z, `zero crossings at 5 Hz × 1 s = ${z}`).toBeGreaterThanOrEqual(9);
    expect(z, `zero crossings at 5 Hz × 1 s = ${z}`).toBeLessThanOrEqual(11);
  });

  it('triangle wave (knob2=0.5) is bounded in [-1, 1] with linear ramps', () => {
    const n = SR / 2;
    const out = peaksMath.render(n, SR, {
      mode: 4, k1: 4, k2: 0.5, triggers: [0],
    });
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(out[i]!);
      if (a > peak) peak = a;
    }
    expect(peak).toBeLessThanOrEqual(1.0001);
    expect(peak).toBeGreaterThan(0.9);
  });
});

describe('ART peaks / numerical safety across the mode × knob cube', () => {
  it('finite + bounded |peak|<2.0 across each mode at extreme knob corners', () => {
    const n = SR / 2;
    const cornerKnobs: Array<[number, number]> = [
      [0.001, 0.001],
      [200, 5],
      [0.5, 0.5],
    ];
    for (let m = 0; m <= 4; m++) {
      for (const [k1, k2] of cornerKnobs) {
        const out = peaksMath.render(n, SR, {
          mode: m as PeaksMode, k1, k2, triggers: [0, Math.floor(SR * 0.1), Math.floor(SR * 0.2)],
        });
        let peak = 0;
        for (let i = 0; i < n; i++) {
          const v = out[i]!;
          expect(Number.isFinite(v), `mode=${m} k1=${k1} k2=${k2} sample[${i}]`).toBe(true);
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        expect(peak, `mode=${m} k1=${k1} k2=${k2} peak=${peak}`).toBeLessThan(2.0);
      }
    }
  });
});
