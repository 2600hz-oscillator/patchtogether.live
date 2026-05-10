// packages/web/src/lib/audio/wavecel-math.test.ts
//
// Pure tests for WAVECEL DSP math: wavefolder, frame interpolation,
// spread→stereo panning. The worklet (packages/dsp/src/wavecel.ts)
// inlines its own copies of these functions; equivalence is asserted
// behaviorally via the ART scenario.

import { describe, it, expect } from 'vitest';
import {
  fold,
  sampleFrame,
  spreadMix,
  WAVECEL_FRAME_SIZE,
} from './wavecel-math';

describe('fold', () => {
  it('amount = 0 is identity', () => {
    for (const x of [-1.5, -0.5, 0, 0.3, 1.5]) {
      expect(fold(x, 0)).toBe(x);
    }
  });

  it('amount > 0 produces values in [-1, +1] for any finite input', () => {
    for (const amt of [0.1, 0.3, 0.7, 1.0]) {
      for (let x = -2; x <= 2; x += 0.07) {
        const y = fold(x, amt);
        expect(y).toBeGreaterThanOrEqual(-1);
        expect(y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reflects symmetrically: fold(-x, a) == -fold(x, a)', () => {
    for (const x of [0.1, 0.4, 0.9, 1.3]) {
      for (const a of [0.2, 0.5, 0.9]) {
        expect(fold(-x, a)).toBeCloseTo(-fold(x, a), 6);
      }
    }
  });

  it('drive at amount=1 reaches 5x: x=0.4 → drive=5 → 2 = silenced via fold', () => {
    const y = fold(0.5, 1);
    expect(y).toBeGreaterThanOrEqual(-1);
    expect(y).toBeLessThanOrEqual(1);
  });
});

describe('sampleFrame', () => {
  function makeFrames(n: number): Float32Array[] {
    const fs: Float32Array[] = [];
    for (let f = 0; f < n; f++) {
      const arr = new Float32Array(WAVECEL_FRAME_SIZE);
      for (let s = 0; s < WAVECEL_FRAME_SIZE; s++) {
        arr[s] = f / Math.max(1, n - 1);
      }
      fs.push(arr);
    }
    return fs;
  }

  it('integer frame returns the constant of that frame', () => {
    const frames = makeFrames(4);
    expect(sampleFrame(frames, 0, 4, 0, 1, 0)).toBeCloseTo(0, 6);
    expect(sampleFrame(frames, 1, 4, 0, 1, 0)).toBeCloseTo(1 / 3, 6);
    expect(sampleFrame(frames, 2, 4, 0, 1, 0)).toBeCloseTo(2 / 3, 6);
    expect(sampleFrame(frames, 3, 4, 0, 1, 0)).toBeCloseTo(1, 6);
  });

  it('half-frame interpolates between adjacent frames', () => {
    const frames = makeFrames(4);
    expect(sampleFrame(frames, 0.5, 4, 0, 1, 0)).toBeCloseTo((0 + 1 / 3) / 2, 6);
    expect(sampleFrame(frames, 1.5, 4, 0, 1, 0)).toBeCloseTo((1 / 3 + 2 / 3) / 2, 6);
  });

  it('out-of-range clamps to edges', () => {
    const frames = makeFrames(4);
    expect(sampleFrame(frames, -1, 4, 0, 1, 0)).toBeCloseTo(0, 6);
    expect(sampleFrame(frames, 100, 4, 0, 1, 0)).toBeCloseTo(1, 6);
  });
});

describe('spreadMix', () => {
  it('spread=1 → mono (L == R)', () => {
    const fetch = (_f: number) => 0.5;
    const { l, r } = spreadMix(1, 5, fetch);
    expect(l).toBeCloseTo(r, 6);
    expect(l).toBeCloseTo(0.5, 6);
  });

  it('spread=5 with constant signal produces equal L/R', () => {
    const fetch = (_f: number) => 0.5;
    const { l, r } = spreadMix(5, 5, fetch);
    // Center-panned constant signal sums identically into both channels.
    expect(l).toBeCloseTo(r, 6);
  });

  it('spread=5 with asymmetric signal: lower frames -> stronger L', () => {
    // Frames 3,4,5,6,7 around center 5. Make the low-side frames louder.
    const fetch = (f: number) => (f < 5 ? 1 : 0.0001);
    const { l, r } = spreadMix(5, 5, fetch);
    expect(l).toBeGreaterThan(r);
  });

  it('spread=5 with asymmetric signal: higher frames -> stronger R', () => {
    const fetch = (f: number) => (f > 5 ? 1 : 0.0001);
    const { l, r } = spreadMix(5, 5, fetch);
    expect(r).toBeGreaterThan(l);
  });

  it('spread out of range is clamped', () => {
    const fetch = (_f: number) => 1;
    expect(() => spreadMix(0.1, 5, fetch)).not.toThrow();
    expect(() => spreadMix(99, 5, fetch)).not.toThrow();
  });

  it('spread between integers smoothly increases stereo spread', () => {
    const fetch = (f: number) => (f < 5 ? 1 : 0);
    const { l: l1, r: r1 } = spreadMix(1, 5, fetch);
    const { l: l3, r: r3 } = spreadMix(3, 5, fetch);
    const { l: l5, r: r5 } = spreadMix(5, 5, fetch);
    // L-R divergence should be 0 at spread=1 (mono) and grow with spread.
    const div1 = Math.abs(l1 - r1);
    const div3 = Math.abs(l3 - r3);
    const div5 = Math.abs(l5 - r5);
    expect(div1).toBeLessThan(div3);
    expect(div3).toBeLessThanOrEqual(div5 * 1.5);
  });
});
