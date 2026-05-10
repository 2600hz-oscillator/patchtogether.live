// art/scenarios/noise/spectral-shape.test.ts
//
// ART for NOISE. Drives the actual noiseDef.factory(ctx, node) under
// node-web-audio-api's OfflineAudioContext (no Faust DSP — NOISE is
// pure JS Math.random + buffer playback), then asserts the spectral
// shape of each output:
//
//   white  → spectrum is approximately flat (≈ 0 dB/oct slope)
//   pink   → spectrum slopes ≈ -3 dB/oct
//   brown  → spectrum slopes ≈ -6 dB/oct
//
// Unit tests already check the same shape on the underlying
// noiseGenerators (offline Float32Array). The ART value-add is
// asserting the WIRING — buffer playback through GainNode produces
// the same spectrum as the raw generator.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { noiseDef } from '../../../packages/web/src/lib/audio/modules/noise';

const SAMPLE_RATE = 48000;
const DURATION_S = 1.0;
const N_DFT = 4096; // dft window size for spectral analysis

/** Render one of the noise outputs through the actual factory.
 *  Returns the channel-0 Float32Array of the rendered destination. */
async function renderNoise(outputId: 'white' | 'pink' | 'brown'): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SAMPLE_RATE * DURATION_S),
    sampleRate: SAMPLE_RATE,
  });

  const node = {
    id: 'noise-1',
    type: 'noise',
    domain: 'audio' as const,
    position: { x: 0, y: 0 },
    params: { level: 1.0 },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = await noiseDef.factory(ctx as any, node);

  const out = handle.outputs.get(outputId);
  if (!out) throw new Error(`no ${outputId} output on noiseDef`);
  out.node.connect(ctx.destination, out.output, 0);

  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

/** Naive O(N²) DFT magnitude on a window of the rendered buffer.
 *  Use the middle of the buffer to skip the first-block warm-up. */
function magnitudeSpectrum(x: Float32Array, n = N_DFT, offset = 4096): Float32Array {
  const half = n >> 1;
  const out = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    let re = 0, im = 0;
    const w = (-2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      const s = x[offset + i] ?? 0;
      re += s * Math.cos(w * i);
      im += s * Math.sin(w * i);
    }
    out[k] = Math.sqrt(re * re + im * im);
  }
  return out;
}

function octaveBandPower(spec: Float32Array, centreBin: number): number {
  const lo = Math.max(1, Math.floor(centreBin / Math.SQRT2));
  const hi = Math.min(spec.length - 1, Math.floor(centreBin * Math.SQRT2));
  let sum = 0;
  let count = 0;
  for (let k = lo; k <= hi; k++) {
    sum += spec[k]! * spec[k]!;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function octaveSlopeDb(spec: Float32Array, lowBin: number, highBin: number): number {
  const lowPower = octaveBandPower(spec, lowBin);
  const highPower = octaveBandPower(spec, highBin);
  const octaves = Math.log2(highBin / lowBin);
  return (10 * Math.log10(highPower / lowPower)) / octaves;
}

describe('NOISE ART: white spectrum is flat', () => {
  it('measured slope across centre frequencies is within ±2 dB/oct of 0', async () => {
    const x = await renderNoise('white');
    const spec = magnitudeSpectrum(x);
    const slope = octaveSlopeDb(spec, N_DFT / 32, N_DFT / 4);
    expect(Math.abs(slope), `white slope=${slope.toFixed(2)} dB/oct`).toBeLessThan(2);
    // Sanity: there's actually energy in the signal.
    let peak = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `white peak=${peak}`).toBeGreaterThan(0.1);
  });
});

describe('NOISE ART: pink spectrum slopes ≈ -3 dB/oct', () => {
  it('measured slope sits in [-5, -1] dB/oct (target -3, ±2 dB tolerance)', async () => {
    const x = await renderNoise('pink');
    const spec = magnitudeSpectrum(x);
    const slope = octaveSlopeDb(spec, N_DFT / 32, N_DFT / 4);
    expect(slope, `pink slope=${slope.toFixed(2)} dB/oct`).toBeGreaterThan(-5);
    expect(slope, `pink slope=${slope.toFixed(2)} dB/oct`).toBeLessThan(-1);
  });
});

describe('NOISE ART: brown spectrum slopes ≈ -6 dB/oct', () => {
  it('measured slope sits in [-8, -4] dB/oct (target -6, ±2 dB tolerance)', async () => {
    const x = await renderNoise('brown');
    const spec = magnitudeSpectrum(x);
    const slope = octaveSlopeDb(spec, N_DFT / 32, N_DFT / 4);
    expect(slope, `brown slope=${slope.toFixed(2)} dB/oct`).toBeGreaterThan(-8);
    expect(slope, `brown slope=${slope.toFixed(2)} dB/oct`).toBeLessThan(-4);
  });
});

describe('NOISE ART: LEVEL knob scales output amplitude', () => {
  it('level=0.5 produces ~half the RMS of level=1.0', async () => {
    async function rmsAt(level: number): Promise<number> {
      const ctx = new OfflineAudioContext({
        numberOfChannels: 1,
        length: Math.round(SAMPLE_RATE * 0.2),
        sampleRate: SAMPLE_RATE,
      });
      const node = {
        id: 'n', type: 'noise', domain: 'audio' as const,
        position: { x: 0, y: 0 }, params: { level },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = await noiseDef.factory(ctx as any, node);
      const out = handle.outputs.get('white')!;
      out.node.connect(ctx.destination, out.output, 0);
      const r = await ctx.startRendering();
      const buf = r.getChannelData(0);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) sumSq += buf[i]! * buf[i]!;
      return Math.sqrt(sumSq / buf.length);
    }
    const half = await rmsAt(0.5);
    const full = await rmsAt(1.0);
    // Allow ±15% slack — different PRNG realisations between runs.
    expect(half / full, `half/full = ${(half / full).toFixed(3)}`).toBeGreaterThan(0.4);
    expect(half / full, `half/full = ${(half / full).toFixed(3)}`).toBeLessThan(0.6);
  });
});
