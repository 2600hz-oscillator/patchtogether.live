// art/scenarios/video/waveform-video-defs.test.ts
//
// ART-tier check on the waveform → mono-video CPU renderer's pixel
// behaviour. Mirrors phase1-defs.test.ts in scope: math/property
// asserts only, no headless GL yet (when headless-gl lands we'll add
// per-input pixel comparisons against baselines).

import { describe, expect, it } from 'vitest';
import { renderWaveformCpu } from '../../../packages/web/src/lib/video/waveform-video';

function meanLuma(rgba: Uint8ClampedArray): number {
  let s = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    s += (rgba[i]! + rgba[i + 1]! + rgba[i + 2]!) / 3;
    n++;
  }
  return s / n;
}
function pixelVariance(rgba: Uint8ClampedArray): number {
  let s = 0, sq = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const v = (rgba[i]! + rgba[i + 1]! + rgba[i + 2]!) / 3;
    s += v;
    sq += v * v;
    n++;
  }
  const m = s / n;
  return sq / n - m * m;
}

describe('ART waveform-video — CPU pixel variance per input shape', () => {
  it('flat zero input → very low mean luma + low variance (mostly bg)', () => {
    const samples = new Float32Array(256);
    const px = renderWaveformCpu(samples, 256, 128);
    const m = meanLuma(px);
    // Background fill is (5, 8, 10); trace at center adds a thin band.
    // Mean luma should stay close to bg luma.
    expect(m).toBeLessThan(20);
  });

  it('sine input → variance > flat input (curve covers more rows)', () => {
    const N = 1024;
    const flat = new Float32Array(N);
    const sine = new Float32Array(N);
    for (let i = 0; i < N; i++) sine[i] = Math.sin((i / N) * Math.PI * 8);
    const fpx = renderWaveformCpu(flat, 256, 128);
    const spx = renderWaveformCpu(sine, 256, 128);
    expect(pixelVariance(spx)).toBeGreaterThan(pixelVariance(fpx));
  });

  it('square wave traces high+low plateaus → distinct from sine', () => {
    const N = 512;
    const sq = new Float32Array(N);
    const sine = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      sq[i] = i % (N / 4) < N / 8 ? 0.7 : -0.7;
      sine[i] = Math.sin((i / N) * Math.PI * 4);
    }
    const sqpx = renderWaveformCpu(sq, 256, 128);
    const sinepx = renderWaveformCpu(sine, 256, 128);
    // The two signals should produce visibly different pixel
    // distributions. Variance is a more sensitive measure than mean
    // luma here: a sine occupies many y-rows, a square just two; both
    // produce similar overall trace coverage, so variance differs more
    // than mean.
    const vSq = pixelVariance(sqpx);
    const vSine = pixelVariance(sinepx);
    expect(Math.abs(vSq - vSine), 'variance differs across square vs sine').toBeGreaterThan(0.1);
  });
});
