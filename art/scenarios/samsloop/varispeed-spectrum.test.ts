// art/scenarios/samsloop/varispeed-spectrum.test.ts
//
// Audio Regression Tests for SAMSLOOP. Drives the pure-math mirror
// (samsloopMath.render — same playback logic as the worklet) over a
// synthesised sine and asserts:
//   - forward unity playback reproduces the source pitch
//   - +2× playback shifts the fundamental up an octave
//   - reverse playback (negative rate) still produces a tone at the
//     same fundamental (reverse plays back the buffer backwards but
//     the spectral content is invariant for a steady sine)
//   - one-shot mode goes silent after one window pass
//   - loop mode keeps producing audio across many window crossings

import { describe, expect, it } from 'vitest';
import { samsloopMath } from '../../../packages/web/src/lib/audio/modules/samsloop';

const SR = 48000;

/** Goertzel single-bin magnitude. */
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

/** Build a 440 Hz sine buffer at the project sample rate. */
function sineBuffer(freqHz: number, lenSamples: number, sr = SR): Float32Array {
  const buf = new Float32Array(lenSamples);
  for (let i = 0; i < lenSamples; i++) {
    buf[i] = Math.sin((2 * Math.PI * freqHz * i) / sr) * 0.8;
  }
  return buf;
}

describe('ART samsloop / forward playback fundamental tracking', () => {
  it('rate=1 (unity forward) plays back the source pitch at the original Hz', () => {
    const src = sineBuffer(440, SR);
    const { out } = samsloopMath.render(src, SR, 1, 0, src.length, 'loop');
    const pFund = powerAt(out, 440, SR);
    const pOctaveUp = powerAt(out, 880, SR);
    const pHalfOctaveUp = powerAt(out, 220, SR);
    expect(pFund, `unity fund ${pFund} > octave-up ${pOctaveUp}`).toBeGreaterThan(pOctaveUp * 10);
    expect(pFund).toBeGreaterThan(pHalfOctaveUp * 10);
  });

  it('rate=2 (forward 2×) doubles the fundamental frequency', () => {
    const src = sineBuffer(440, SR);
    const { out } = samsloopMath.render(src, SR, 2, 0, src.length, 'loop');
    // Skip the wrap discontinuities by analysing only the steady-state tail.
    const tail = out.slice(SR / 4);
    const pOriginal = powerAt(tail, 440, SR);
    const pDoubled = powerAt(tail, 880, SR);
    expect(pDoubled, `2× shift: 880 Hz ${pDoubled} > 440 Hz ${pOriginal}`).toBeGreaterThan(
      pOriginal * 5,
    );
  });

  it('rate=0.5 (forward half-speed) halves the fundamental frequency', () => {
    const src = sineBuffer(440, SR);
    const { out } = samsloopMath.render(src, SR, 0.5, 0, src.length, 'loop');
    const tail = out.slice(SR / 4);
    const pOriginal = powerAt(tail, 440, SR);
    const pHalved = powerAt(tail, 220, SR);
    expect(pHalved, `half-speed: 220 Hz ${pHalved} > 440 Hz ${pOriginal}`).toBeGreaterThan(
      pOriginal * 3,
    );
  });
});

describe('ART samsloop / reverse playback', () => {
  it('rate=-1 (reverse unity) produces a tone at the same fundamental as forward', () => {
    // For a steady-state sine, reverse playback is just a phase-inverted
    // copy at the same pitch. The fundamental bin should be strong; the
    // octave bin should not be (no pitch-shift).
    const src = sineBuffer(440, SR);
    const { out } = samsloopMath.render(src, SR, -1, 0, src.length, 'loop');
    const tail = out.slice(SR / 4);
    const pFund = powerAt(tail, 440, SR);
    const pOctaveUp = powerAt(tail, 880, SR);
    expect(pFund, `reverse fund ${pFund} > octave-up ${pOctaveUp}`).toBeGreaterThan(pOctaveUp * 5);
  });

  it('rate=-2 (reverse 2×) doubles the fundamental (pitch direction is independent of playback direction)', () => {
    const src = sineBuffer(440, SR);
    const { out } = samsloopMath.render(src, SR, -2, 0, src.length, 'loop');
    const tail = out.slice(SR / 4);
    const pOriginal = powerAt(tail, 440, SR);
    const pDoubled = powerAt(tail, 880, SR);
    expect(pDoubled, `reverse 2×: 880 Hz ${pDoubled} > 440 Hz ${pOriginal}`).toBeGreaterThan(
      pOriginal * 5,
    );
  });
});

describe('ART samsloop / loop vs one-shot mode', () => {
  it('one-shot at unity rate goes silent after one buffer pass', () => {
    // Source is 0.1 s long; render 0.5 s. After sample 0.1*SR the output
    // should be silent in one-shot mode.
    const lenS = 0.1;
    const lenSamples = Math.floor(SR * lenS);
    const src = sineBuffer(440, lenSamples);
    const { out } = samsloopMath.render(src, SR / 2, 1, 0, lenSamples, 'one-shot');
    // Tail (after the buffer ran out) should be silent.
    const tailStart = lenSamples + 100;
    let tailRms = 0;
    for (let i = tailStart; i < out.length; i++) tailRms += out[i]! * out[i]!;
    tailRms = Math.sqrt(tailRms / (out.length - tailStart));
    expect(tailRms, `one-shot tail RMS ${tailRms}`).toBeLessThan(1e-6);
  });

  it('loop at unity rate keeps emitting non-silent samples across many wraps', () => {
    const lenS = 0.05;
    const lenSamples = Math.floor(SR * lenS);
    const src = sineBuffer(440, lenSamples);
    const { out } = samsloopMath.render(src, SR, 1, 0, lenSamples, 'loop');
    // The output must span 20 wraps (1 s / 0.05 s); each section should
    // carry the same fundamental.
    const earlyRms = rms(out.slice(0, lenSamples));
    const lateRms = rms(out.slice(SR - lenSamples));
    expect(lateRms, `loop tail RMS ${lateRms} ~ early RMS ${earlyRms}`).toBeGreaterThan(
      earlyRms * 0.5,
    );
  });
});

describe('ART samsloop / finite + bounded', () => {
  it('every rate from −2 to +2 produces finite, bounded output', () => {
    const src = sineBuffer(440, SR);
    for (const rate of [-2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2]) {
      const { out } = samsloopMath.render(src, SR / 2, rate, 0, src.length, 'loop');
      let peak = 0;
      for (let i = 0; i < out.length; i++) {
        expect(Number.isFinite(out[i]!), `rate=${rate} sample[${i}] finite`).toBe(true);
        const a = Math.abs(out[i]!);
        if (a > peak) peak = a;
      }
      expect(peak, `rate=${rate} peak ${peak}`).toBeLessThanOrEqual(1.0);
    }
  });
});

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}
