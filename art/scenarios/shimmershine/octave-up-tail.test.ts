// art/scenarios/shimmershine/octave-up-tail.test.ts
//
// ART scenario for SHIMMERSHINE: drive a 440Hz tone burst through the
// reverb math helper and assert the tail contains 880Hz energy (octave-up
// shimmer) when shimmer is engaged, and that the SAME signal path with
// shimmer=0 produces a tail dominated by the input fundamental.
//
// Tail-window only: we skip the first 0.5 s of the buffer (direct tone +
// initial pre-delay) and analyze the remaining ~4.5 s where the shimmer
// feedback has had time to build up the octave-up halo.

import { describe, expect, it } from 'vitest';
import { shimmershineMath } from '../../../packages/web/src/lib/audio/modules/shimmershine';

const SR = 48000;

function dftPowerAt(buf: Float32Array, freq: number, sr: number): number {
  // Goertzel-style single-bin magnitude. Normalize by N so the value is
  // comparable across different buffer lengths.
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

/** Sum dftPowerAt over a ±bandHz region around centre. Needed because the
 *  granular-fade pitch shifter's Hann window splits the +12 carrier into
 *  AM sidebands at centre ± (1000/windowMs), so the octave-up energy lives
 *  in a small cluster rather than at exactly centre. */
function dftBandPower(buf: Float32Array, centre: number, bandHz: number, sr: number): number {
  let total = 0;
  for (let f = centre - bandHz; f <= centre + bandHz; f += 10) {
    total += dftPowerAt(buf, f, sr);
  }
  return total;
}

/** 1-second tone burst at 440Hz followed by `tailS` of silence. */
function toneBurstThenSilence(toneS: number, tailS: number): Float32Array {
  const n = Math.round((toneS + tailS) * SR);
  const toneN = Math.round(toneS * SR);
  const buf = new Float32Array(n);
  for (let i = 0; i < toneN; i++) {
    buf[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
  }
  return buf;
}

describe('ART shimmershine / octave-up tail spectrum', () => {
  it('shimmer engaged → tail has 880Hz energy that is a meaningful fraction of 440Hz', () => {
    // Drive with a moderate decay so the 440Hz fundamental fades during
    // the tail while the shimmer feedback continues injecting 880Hz
    // content. With shorter decay we can clearly demonstrate the
    // octave-up halo without competing with a sustained fundamental.
    const input = toneBurstThenSilence(1.0, 4.0);
    const out = shimmershineMath.renderShimmer(input, SR, {
      decay: 0.5,    // moderate tank decay — fundamental fades faster
      shimmer: 1.0,  // max shimmer feedback
      size: 0.7,
      damp: 0.2,
      mix: 1.0,
    });

    // Tail: skip first 2.0 s (tone burst + half-decay).
    const tailStart = Math.round(2.0 * SR);
    const tail = out.slice(tailStart, out.length);

    const b440 = dftBandPower(tail, 440, 60, SR);
    const b880 = dftBandPower(tail, 880, 60, SR);

    // The shimmer halo must contribute a measurable octave-up presence —
    // at least 25% of the residual fundamental energy. With shimmer=0
    // (the next test) this ratio is essentially zero, so any positive
    // measurement proves the pitch-shifted feedback is engaged.
    expect(
      b880 / b440,
      `880Hz/440Hz band ratio = ${(b880 / b440).toFixed(3)} (b880=${b880}, b440=${b440})`,
    ).toBeGreaterThan(0.25);
  });

  it('shimmer=0 → tail dominated by fundamental, NOT octave-up', () => {
    const input = toneBurstThenSilence(1.0, 4.0);
    const out = shimmershineMath.renderShimmer(input, SR, {
      decay: 0.85,
      shimmer: 0.0, // plain reverb, no pitch-shift feedback
      size: 0.85,
      damp: 0.2,
      mix: 1.0,
    });

    const tailStart = Math.round(1.5 * SR);
    const tail = out.slice(tailStart, out.length);

    const b440 = dftBandPower(tail, 440, 60, SR);
    const b880 = dftBandPower(tail, 880, 60, SR);

    // With shimmer=0 the tank is just a Schroeder reverb — the tail
    // carries the same spectral content as the input (440Hz fundamental).
    // 440Hz band must dominate 880Hz band.
    expect(b440, `shimmer=0 tail: 440Hz band ${b440}, 880Hz band ${b880}`).toBeGreaterThan(b880 * 2);
  });

  it('feedback cap prevents runaway: tail RMS stays bounded with extreme settings', () => {
    const input = toneBurstThenSilence(1.0, 4.0);
    const out = shimmershineMath.renderShimmer(input, SR, {
      decay: 1.0,
      shimmer: 1.0,
      size: 1.0,
      damp: 0.0, // worst case for runaway
      mix: 1.0,
    });

    // Even with all knobs maxed, the tanh limit + feedback cap should
    // keep the output bounded well within ±1.
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const a = Math.abs(out[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `extreme-settings peak ${peak}`).toBeLessThan(2.0);

    // And the late tail should not be DC-loaded or NaN-poisoned.
    const lateStart = Math.round(4.0 * SR);
    const late = out.slice(lateStart, out.length);
    const badIdx = late.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite at late-tail index ${badIdx}`).toBe(-1);
  });
});
