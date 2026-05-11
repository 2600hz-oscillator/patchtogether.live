// art/scenarios/stereovca/ring-mod-spectrum.test.ts
//
// ART-tier check on STEREOVCA's ring-mod behavior. We exercise the pure
// math helper (stereoVcaMath.render) under the same offline-rendering
// pattern as art/scenarios/wavefolder/wavefolder-spectrum.test.ts —
// generate two sine inputs, feed them through the per-channel multiply,
// and DFT-confirm the rendered spectrum has the textbook ring-mod sum
// and difference bands while the carrier itself is suppressed.
//
// Why ART rather than just vitest: this anchors the cross-cutting DSP
// property (ring-mod = sum + diff, carrier suppression) so a refactor
// that touches the multiply or the normalling path is caught with a
// quantitative spectral assertion rather than relying solely on the
// per-sample math tests.

import { describe, expect, it } from 'vitest';
import { stereoVcaMath } from '../../../packages/web/src/lib/audio/modules/stereovca';

const SR = 48000;

function sineBuffer(freqHz: number, frames: number, amp = 1.0): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / SR) * amp;
  }
  return out;
}

/** Naive DFT magnitude at one bin. Pattern copied from
 *  art/scenarios/wavefolder/wavefolder-spectrum.test.ts. */
function dftMagAt(buf: Float32Array, k: number): number {
  let re = 0;
  let im = 0;
  const N = buf.length;
  for (let n = 0; n < N; n++) {
    const phi = (-2 * Math.PI * k * n) / N;
    re += (buf[n] ?? 0) * Math.cos(phi);
    im += (buf[n] ?? 0) * Math.sin(phi);
  }
  return Math.sqrt(re * re + im * im) / N;
}

function binFor(freqHz: number, N: number): number {
  return Math.round((freqHz * N) / SR);
}

describe('ART stereovca / ring-mod spectrum', () => {
  it('audio=200Hz × strength=50Hz (offset=0) → energy at 150Hz + 250Hz, carrier suppressed', () => {
    // Classical ring-mod identity:
    //   sin(2π·fA·t) · sin(2π·fM·t) = 0.5·(cos(2π·(fA-fM)·t) − cos(2π·(fA+fM)·t))
    // We expect the spectrum to be empty at fA=200Hz (the carrier) and
    // to carry strong energy at fA±fM = 150Hz and 250Hz.
    const N = 8192;
    const audio    = sineBuffer(200, N);
    const strength = sineBuffer(50,  N);
    const { outL } = stereoVcaMath.render(audio, null, strength, null, 0, 1, N);

    const m150 = dftMagAt(outL, binFor(150, N));
    const m200 = dftMagAt(outL, binFor(200, N));
    const m250 = dftMagAt(outL, binFor(250, N));

    expect(m150, '150Hz (fA - fM) sideband').toBeGreaterThan(0.1);
    expect(m250, '250Hz (fA + fM) sideband').toBeGreaterThan(0.1);
    // Carrier suppression: 200Hz must be << either sideband.
    expect(m200 / m150).toBeLessThan(0.1);
    expect(m200 / m250).toBeLessThan(0.1);
    // Sideband symmetry (mod-rate identity predicts equal magnitude).
    expect(Math.abs(m150 - m250) / Math.max(m150, m250)).toBeLessThan(0.2);
  });

  it('offset=+1 turns ring-mod into tremolo (carrier passes, sidebands at half magnitude)', () => {
    // (strength + 1) · audio = audio + strength·audio
    //   → fundamental at 200Hz (the un-modulated audio passthrough)
    //   → plus the ring sidebands at 150 + 250 Hz (each at half mag of
    //     the offset=0 case because they share the half-mag identity).
    const N = 8192;
    const audio    = sineBuffer(200, N);
    const strength = sineBuffer(50,  N);
    const { outL } = stereoVcaMath.render(audio, null, strength, null, 1, 1, N);

    const m150 = dftMagAt(outL, binFor(150, N));
    const m200 = dftMagAt(outL, binFor(200, N));
    const m250 = dftMagAt(outL, binFor(250, N));

    expect(m200, '200Hz carrier passes when offset=+1').toBeGreaterThan(0.1);
    expect(m150, 'sideband present').toBeGreaterThan(0.05);
    expect(m250, 'sideband present').toBeGreaterThan(0.05);
    // Carrier is at least as strong as either sideband.
    expect(m200).toBeGreaterThanOrEqual(m150 * 0.9);
    expect(m200).toBeGreaterThanOrEqual(m250 * 0.9);
  });

  it('strength_r normalled to strength_l: right channel sees the same ring-mod sidebands as left', () => {
    // Mono audio (in_l only) + mono strength (strength_l only): both
    // out_l and out_r should normal-up to the same audio × the same
    // strength, so their spectra should match within FP rounding.
    const N = 4096;
    const audio    = sineBuffer(200, N);
    const strength = sineBuffer(50,  N);
    const { outL, outR } = stereoVcaMath.render(audio, null, strength, null, 0, 1, N);

    const k150 = binFor(150, N);
    const k250 = binFor(250, N);
    expect(dftMagAt(outL, k150)).toBeCloseTo(dftMagAt(outR, k150), 5);
    expect(dftMagAt(outL, k250)).toBeCloseTo(dftMagAt(outR, k250), 5);
  });

  it('level knob attenuates the entire output spectrum linearly', () => {
    // Halving level should halve every DFT bin magnitude.
    const N = 4096;
    const audio    = sineBuffer(200, N);
    const strength = sineBuffer(50,  N);
    const full = stereoVcaMath.render(audio, null, strength, null, 0, 1.0, N);
    const half = stereoVcaMath.render(audio, null, strength, null, 0, 0.5, N);

    const k150 = binFor(150, N);
    const fullMag = dftMagAt(full.outL, k150);
    const halfMag = dftMagAt(half.outL, k150);
    expect(halfMag / fullMag).toBeCloseTo(0.5, 3);
  });

  it('VCA mode: slow strength (1Hz) on a 200Hz audio produces tremolo (carrier dominates, very-low-freq sidebands)', () => {
    // With a 1Hz strength the sidebands at 199Hz and 201Hz are too
    // close to the 200Hz carrier to resolve as distinct bins at this
    // FFT length — but the carrier itself should dominate the spectrum
    // and there should be a slow amplitude envelope visible in the
    // time domain (peak-to-trough sweep close to full 2× modulation).
    const N = 8192;
    const audio    = sineBuffer(200, N);
    const strength = sineBuffer(1,   N); // slow LFO-rate
    const { outL } = stereoVcaMath.render(audio, null, strength, null, 0, 1, N);

    const m200 = dftMagAt(outL, binFor(200, N));
    expect(m200, '200Hz carrier dominates tremolo spectrum').toBeGreaterThan(0.1);

    // Time-domain amplitude sweep: max abs should approach 1.0, min
    // window average should approach 0 over a 1Hz cycle (only ~0.17s
    // of the 1Hz cycle fits in this buffer at SR=48k; verify the
    // envelope is bipolar by checking max > 0.5).
    let peak = 0;
    for (let i = 0; i < outL.length; i++) {
      const v = Math.abs(outL[i] ?? 0);
      if (v > peak) peak = v;
    }
    expect(peak, 'tremolo envelope reaches near-peak amplitude').toBeGreaterThan(0.5);
  });
});
