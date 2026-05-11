// art/scenarios/warrenspectrum/ping-rings.test.ts
//
// End-to-end ping behavior test — loads the BUILT worklet, mocks
// AudioWorkletGlobalScope, drives the worklet's process() with a gate
// signal on a specific band's ping channel, asserts the audio output
// rings at that band's center frequency.
//
// This complements warrenspectrum.test.ts (which tests the pure math
// in isolation) by exercising the full worklet — the bug previously
// fixed in this scenario was that a gate-rising-edge produced no
// audible ringing because the bandpass excitation decayed (~1ms) much
// faster than the bandpass could ring (~3ms at Q=6). The fix added
// envelope-modulated noise to keep the bandpass excited through the
// full vactrol envelope.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DSP_DIST_DIR } from '../../setup/render';

const SR = 48000;
const BLOCK = 128;
const BANDS = [80, 160, 320, 640, 1280, 2560, 5120, 10240];

interface WorkletNodeLike {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
type WorkletCtor = new (opts?: { processorOptions?: unknown }) => WorkletNodeLike;

let WarrenspectrumProcessor: WorkletCtor;

beforeAll(() => {
  // Mock the AudioWorkletGlobalScope and load the built worklet.
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (name: string, ctor: unknown) => void;
  };
  g.sampleRate = SR;
  const processors = new Map<string, WorkletCtor>();
  g.AudioWorkletProcessor = class {
    port = { postMessage: () => undefined, onmessage: null };
  };
  g.registerProcessor = (name: string, ctor: unknown) => {
    processors.set(name, ctor as WorkletCtor);
  };

  const src = readFileSync(join(DSP_DIST_DIR, 'warrenspectrum.js'), 'utf8');
  const code = src.replace(/^export /gm, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(code)();

  const cls = processors.get('warrenspectrum');
  if (!cls) throw new Error('warrenspectrum did not register');
  WarrenspectrumProcessor = cls;
});

/** Run the worklet end-to-end with a HIGH gate on `pingBand` for blocks
 *  5..15 (rising edge at block 5, falls at block 15). Returns the mono-summed
 *  output buffer (length = numBlocks*BLOCK). */
function renderPing(pingBand: number, numBlocks = 384): Float32Array {
  const node = new WarrenspectrumProcessor();
  const out = new Float32Array(BLOCK * numBlocks);

  const params: Record<string, Float32Array> = {};
  for (let i = 1; i <= 8; i++) params[`level${i}`] = new Float32Array([1.0]);
  params.master = new Float32Array([1.0]);
  params.pingDecay = new Float32Array([0.5]);

  for (let blk = 0; blk < numBlocks; blk++) {
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    const pings: Float32Array[] = [];
    for (let b = 0; b < 8; b++) pings.push(new Float32Array(BLOCK));
    if (blk >= 5 && blk < 15) {
      for (let i = 0; i < BLOCK; i++) pings[pingBand]![i] = 1.0;
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    node.process(
      [[inL], [inR], pings],
      [[outL], [outR]],
      params,
    );
    for (let i = 0; i < BLOCK; i++) out[blk * BLOCK + i] = outL[i]!;
  }
  return out;
}

/** DFT magnitude in a ±5% window around freq (averaged across 21 bins). */
function dftBand(buf: Float32Array, fc: number): number {
  let sum = 0;
  for (let i = 0; i < 21; i++) {
    const f = fc * (0.95 + (i / 20) * 0.1);
    let re = 0, im = 0;
    for (let n = 0; n < buf.length; n++) {
      const ph = (2 * Math.PI * f * n) / SR;
      re += buf[n]! * Math.cos(ph);
      im -= buf[n]! * Math.sin(ph);
    }
    sum += Math.sqrt(re * re + im * im) / buf.length;
  }
  return sum / 21;
}

describe('warrenspectrum / ping rings the band', () => {
  it('ping band 3 (640Hz) — output spectrum peaks near 640Hz', () => {
    const out = renderPing(3);
    // Skip the silent pre-ping blocks.
    const slice = out.subarray(BLOCK * 6);
    const mags = BANDS.map((f) => dftBand(slice, f));
    const peakIdx = mags.indexOf(Math.max(...mags));
    expect(
      peakIdx,
      `ping band 3 should peak at fc=640 (idx 3); mags=${mags.map((m) => m.toExponential(2)).join(', ')}`,
    ).toBe(3);
    // Center band magnitude should be at least 2x the n±2 bleed magnitude.
    expect(mags[3]!).toBeGreaterThan(mags[1]! * 2);
    expect(mags[3]!).toBeGreaterThan(mags[5]! * 2);
  });

  it('ping band 5 (2560Hz) — output spectrum peaks near 2560Hz', () => {
    const out = renderPing(5);
    const slice = out.subarray(BLOCK * 6);
    const mags = BANDS.map((f) => dftBand(slice, f));
    const peakIdx = mags.indexOf(Math.max(...mags));
    expect(
      peakIdx,
      `ping band 5 should peak at fc=2560 (idx 5); mags=${mags.map((m) => m.toExponential(2)).join(', ')}`,
    ).toBe(5);
  });

  it('ping is audible (peak output > -25 dBFS = 0.056)', () => {
    const out = renderPing(3);
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const v = Math.abs(out[i]!);
      if (v > peak) peak = v;
    }
    // The previous (broken) behavior produced peak ~0.005 (-46 dBFS) —
    // effectively silent. The fix should give >0.1 (-20 dBFS) at master=1.
    expect(peak, `peak output ${peak.toFixed(4)} should be clearly audible`).toBeGreaterThan(0.1);
    expect(peak, `peak output ${peak.toFixed(4)} should not clip`).toBeLessThan(1.0);
  });

  it('bleed: ping band 4 (1280Hz) excites n±1 bands as well, less so n±2', () => {
    const out = renderPing(4);
    const slice = out.subarray(BLOCK * 6);
    const mags = BANDS.map((f) => dftBand(slice, f));
    // Center band (4 = 1280Hz) is the loudest.
    expect(mags[4]!).toBe(Math.max(...mags));
    // n±1 bands have some energy (bleed weight 0.35).
    expect(mags[3]!, 'n-1 band 3 should have audible bleed energy').toBeGreaterThan(mags[4]! * 0.1);
    expect(mags[5]!, 'n+1 band 5 should have audible bleed energy').toBeGreaterThan(mags[4]! * 0.1);
    // n±3 bands (distance > 2 from band 4) have nearly zero energy.
    expect(mags[0]!, 'n-4 band 0 should have negligible energy').toBeLessThan(mags[4]! * 0.1);
    expect(mags[7]!, 'n+3 band 7 should have negligible energy').toBeLessThan(mags[4]! * 0.1);
  });

  it('ping decays — tail is much quieter than the peak ring', () => {
    // Default pingDecay=0.5 → 0.1 + 0.5*0.7 = 0.45s vactrol decay.
    // Compare peak RMS (during ring) vs tail RMS (after envelope decays).
    const out = renderPing(3, 1024); // ~2.7s of audio
    // Peak window: blocks 10..30 (just after attack completes, ring is full).
    const peakSlice = out.subarray(10 * BLOCK, 30 * BLOCK);
    let peakRms = 0;
    for (let i = 0; i < peakSlice.length; i++) peakRms += peakSlice[i]! * peakSlice[i]!;
    peakRms = Math.sqrt(peakRms / peakSlice.length);
    // Tail window: blocks 800..1000 (~2.1s after trigger — well past 4×τ at default decay).
    const tailSlice = out.subarray(800 * BLOCK, 1000 * BLOCK);
    let tailRms = 0;
    for (let i = 0; i < tailSlice.length; i++) tailRms += tailSlice[i]! * tailSlice[i]!;
    tailRms = Math.sqrt(tailRms / tailSlice.length);
    expect(
      tailRms,
      `tail RMS ${tailRms.toFixed(4)} should be much quieter than peak ${peakRms.toFixed(4)}`,
    ).toBeLessThan(peakRms * 0.1);
  });
});
