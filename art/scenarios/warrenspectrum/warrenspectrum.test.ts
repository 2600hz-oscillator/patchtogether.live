// art/scenarios/warrenspectrum/warrenspectrum.test.ts
//
// Toolchain validation + math-anchored behavior tests for WARRENSPECTRUM.
// Mirrors the wavecel pattern: build artifact + SHA pin, plus offline
// reference-model assertions for the bandpass peak + ping-impulse ring.
//
// The pure-math assertions (bleed matrix, vactrol envelope) live in
// packages/web/src/lib/audio/warrenspectrum-math.test.ts. Here we run
// the math through enough samples to demonstrate end-to-end signal
// behavior (filter peak near 640Hz for band-3-only, ring decays after
// ping at band 5) without standing up the AudioWorkletGlobalScope.

import { describe, it, expect } from 'vitest';
import {
  builtSha,
  moduleSourceSha,
  render,
} from '../../setup/render';
import {
  WARRENSPECTRUM_CENTER_HZ,
  WARRENSPECTRUM_Q,
  WARRENSPECTRUM_NUM_BANDS,
  biquadBpfCoeffs,
  makeEnv,
  applyPing,
  stepEnv,
  stepClick,
  type BiquadCoeffs,
  type VactrolEnv,
} from '$lib/audio/warrenspectrum-math';

describe('warrenspectrum / toolchain', () => {
  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({ moduleName: 'warrenspectrum', durationS: 0.5 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at ${badIdx}`).toBe(-1);
  });

  it('SHA matches between source and built artifact', async () => {
    const srcSha = await moduleSourceSha('warrenspectrum');
    const built = await builtSha('warrenspectrum');
    expect(built).toBe(srcSha);
  });
});

/**
 * Offline reference: run a bandpass biquad on a buffer, scaled by a
 * per-sample gain. Returns the output buffer. Mirrors the worklet's
 * per-band signal path (minus the cross-band sum).
 */
function runBpf(
  input: Float32Array,
  coeffs: BiquadCoeffs,
  gainFn: (i: number) => number,
): Float32Array {
  const out = new Float32Array(input.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i]!;
    const y = coeffs.b0 * x + z1;
    z1 = coeffs.b1 * x - coeffs.a1 * y + z2;
    z2 = coeffs.b2 * x - coeffs.a2 * y;
    out[i] = y * gainFn(i);
  }
  return out;
}

/** Compute DFT magnitude at a single frequency for a fixed-length buffer. */
function dftMag(buf: Float32Array, freq: number, sr: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    const phase = (2 * Math.PI * freq * i) / sr;
    re += buf[i]! * Math.cos(phase);
    im -= buf[i]! * Math.sin(phase);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

describe('warrenspectrum / band-3 (640 Hz) isolates around its center freq', () => {
  it('white noise → only band-3 active → output spectrum peaks near 640 Hz', () => {
    const sr = 48000;
    const N = 8192;
    // White noise input.
    const input = new Float32Array(N);
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 0xffffffff) * 2 - 1;
    };
    for (let i = 0; i < N; i++) input[i] = rand() * 0.5;

    // Band 3 is the 4th band (index 3) — centered at 640 Hz.
    const fc = WARRENSPECTRUM_CENTER_HZ[3]!;
    const coeffs = biquadBpfCoeffs(fc, WARRENSPECTRUM_Q, sr);
    const out = runBpf(input, coeffs, () => 1);

    // Spectrum: bandpass output magnitude at fc should dominate the
    // out-of-band magnitudes (2 octaves above/below).
    const magFc = dftMag(out, fc, sr);
    const magLow = dftMag(out, fc / 4, sr);
    const magHigh = dftMag(out, fc * 4, sr);
    expect(
      magFc,
      `at fc=${fc} mag=${magFc}, 2oct-low mag=${magLow}, 2oct-high mag=${magHigh}`,
    ).toBeGreaterThan(magLow * 3);
    expect(magFc).toBeGreaterThan(magHigh * 3);
  });
});

describe('warrenspectrum / ping at band 5 produces ringing near 2560 Hz', () => {
  it('with no input audio, a ping injects an impulse and the filter rings', () => {
    const sr = 48000;
    const N = 16384;
    const dryInput = new Float32Array(N); // silence — only the ping drives ringing

    // Compute the ping envelope at band 5 (index 5 — 2560 Hz). We run
    // applyPing on the canonical 8-element env array so the bleed
    // distribution is accurate (band 5 gets 1.0, 4/6 get 0.35, etc).
    const envs: VactrolEnv[] = Array.from({ length: WARRENSPECTRUM_NUM_BANDS }, () => makeEnv());
    applyPing(envs, 5, 0.3, 20, sr, () => 0.5);

    const e = envs[5]!;
    // Generate the impulse-driver sequence: stepClick gives the fast
    // ~1ms broadband click that drives the bandpass into ringing
    // (matches the worklet's `ring = clickAmp` injection). We still
    // step the slow vactrol envelope each sample so the click is in
    // sync with what the worklet does.
    const drive = 4;
    const ringSignal = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      stepEnv(e, drive); // slow envelope advances (output unused here)
      const v = stepClick(e);
      ringSignal[i] = dryInput[i]! + v;
    }

    const fc = WARRENSPECTRUM_CENTER_HZ[5]!;
    const coeffs = biquadBpfCoeffs(fc, WARRENSPECTRUM_Q, sr);
    const out = runBpf(ringSignal, coeffs, () => 1);

    // The bandpass output should contain energy at fc, and significantly
    // less at frequencies far away. We measure across the full
    // post-attack window so the bandpass's ring tail is captured.
    // Click decays in ~1ms; the BPF's own ringing (Q=6) extends well
    // beyond — that's the energy we DFT.
    const slice = out.subarray(512);
    const magFc = dftMag(slice, fc, sr);
    const magOff1 = dftMag(slice, fc / 4, sr);
    const magOff2 = dftMag(slice, fc * 4, sr);
    expect(magFc, `ping ring mag at fc=${fc} = ${magFc}, off1=${magOff1}, off2=${magOff2}`).toBeGreaterThan(magOff1 * 2);
    expect(magFc).toBeGreaterThan(magOff2 * 2);

    // Sanity: the very tail (after the bandpass ring has decayed) is
    // near silent. With Q=6 at 2560Hz the ring time is ~Q/(π*fc) ≈
    // 0.75ms — by sample N-1024 (after several hundred ms) we're done.
    const tail = out.subarray(N - 1024);
    let rms = 0;
    for (let i = 0; i < tail.length; i++) rms += tail[i]! * tail[i]!;
    rms = Math.sqrt(rms / tail.length);
    expect(rms, `tail rms=${rms}`).toBeLessThan(0.05);
  });
});
