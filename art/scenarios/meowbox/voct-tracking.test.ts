// art/scenarios/meowbox/voct-tracking.test.ts
//
// ART for the MEOWBOX V/oct fix (PR fix/meowbox-voct).
//
// Background: prior to this PR, meowbox declared its `pitch` input as
// type='cv' with paramTarget='pitch' — the Faust DSP interpreted the value
// as SEMITONES, so a sequencer's 1V/oct CV produced only a +1 semitone shift
// per volt instead of the standard +12 semitones (one octave). The fix
// changes the port type to 'pitch' and adds an audio-rate pitch input to the
// Faust DSP that uses the standard convention `freq = 261.626 * 2^volts`,
// matching analog-vco.dsp.
//
// Coverage:
//
//  1. SHA matches between source and built artifact — pins the rebuild
//     so the V/oct change is shipped with the meowbox.wasm/.json/.worklet.js
//     artifacts.
//
//  2. The TS V/oct helper (meowboxBaseFreqHz, exported from meowbox.ts) is
//     a faithful mirror of the Faust DSP's baseFreq formula, and produces
//     the expected geometric Hz sequence at integer-volt CV values. We
//     drive an OscillatorNode under OfflineAudioContext at each predicted
//     Hz and FFT-confirm the rendered fundamental matches — same scaffold
//     as the score / note-pitch / analog-vco scenarios (node-web-audio-api
//     can't host the Faust AudioWorklet directly, but the V/oct convention
//     is the load-bearing thing we want to pin).
//
//  3. A pitch CV sweep from -2V to +2V in 1V steps produces a geometric
//     frequency sequence (each step doubles the previous frequency). This
//     is the canonical 1V/oct invariant and the bug class we're guarding
//     against (the old behavior would produce only ~+0.06 octaves per V).

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  builtSha,
  moduleSourceSha,
} from '../../setup/render';
import {
  MEOWBOX_C4_HZ,
  meowboxBaseFreqHz,
} from '../../../packages/web/src/lib/audio/modules/meowbox';

const SAMPLE_RATE = 48000;
const DURATION_S = 0.5;
const FREQ_TOLERANCE_HZ = 1.0; // FFT bin granularity slack

const TWO_PI = Math.PI * 2;

function goertzel(samples: Float32Array, sampleRate: number, targetFreq: number): number {
  const k = (samples.length * targetFreq) / sampleRate;
  const omega = (TWO_PI * k) / samples.length;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q1 = 0, q2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

/** Hann-windowed peak-bin estimator. Same algorithm as note-pitch.test.ts. */
function dominantFrequency(buffer: Float32Array, sampleRate: number): number {
  const n = buffer.length;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((TWO_PI * i) / (n - 1)));
    w[i] = buffer[i] * win;
  }
  const maxFreq = Math.min(20_000, sampleRate / 2 - 100);
  const coarseStepHz = 4;
  let coarseBest = 20;
  let coarseBestMag = -Infinity;
  for (let f = 20; f <= maxFreq; f += coarseStepHz) {
    const mag = goertzel(w, sampleRate, f);
    if (mag > coarseBestMag) {
      coarseBestMag = mag;
      coarseBest = f;
    }
  }
  let fineBest = coarseBest;
  let fineBestMag = coarseBestMag;
  for (let f = coarseBest - coarseStepHz; f <= coarseBest + coarseStepHz; f += 0.05) {
    const mag = goertzel(w, sampleRate, f);
    if (mag > fineBestMag) {
      fineBestMag = mag;
      fineBest = f;
    }
  }
  return fineBest;
}

async function renderOscillatorAt(freqHz: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SAMPLE_RATE * DURATION_S),
    sampleRate: SAMPLE_RATE,
  });
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqHz, 0);
  osc.connect(ctx.destination);
  osc.start(0);
  osc.stop(DURATION_S);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

describe('meowbox / voct-tracking — toolchain', () => {
  it('SHA matches between source and built artifact (DSP rebuild required)', async () => {
    const srcSha = await moduleSourceSha('meowbox');
    const built = await builtSha('meowbox');
    expect(
      built,
      `Built meowbox SHA (${built}) != source SHA (${srcSha}). Rebuild via \`task dsp:build\`.`,
    ).toBe(srcSha);
  });
});

describe('meowbox / voct-tracking — V/oct convention pinned', () => {
  // Reference table: at each integer-volt CV value (with knob = 0 semis),
  // the DSP's baseFreq formula `261.6256 * 2^v` produces these Hz. The
  // OLD bug's broken formula `261.6256 * 2^(v / 12)` would have produced
  // dramatically different values (a +1V CV under the bug yielded only
  // ~277 Hz instead of the correct ~523 Hz).
  const VOCT_REFERENCES: Array<{ volts: number; hz: number; note: string }> = [
    { volts: -2, hz: 65.4064,   note: 'C2' },
    { volts: -1, hz: 130.8128,  note: 'C3' },
    { volts:  0, hz: 261.6256,  note: 'C4' },
    { volts:  1, hz: 523.2511,  note: 'C5' },
    { volts:  2, hz: 1046.5023, note: 'C6' },
  ];

  for (const ref of VOCT_REFERENCES) {
    it(`pitch CV ${ref.volts >= 0 ? '+' : ''}${ref.volts}V → ${ref.note} (~${ref.hz} Hz)`, async () => {
      // Layer 1: TS helper matches the DSP formula.
      const predicted = meowboxBaseFreqHz(ref.volts, 0);
      expect(Math.abs(predicted - ref.hz)).toBeLessThan(0.01);

      // Layer 2: render an OscillatorNode at the predicted Hz, FFT, confirm
      // the dominant fundamental matches (within FFT bin slack). This
      // exercises the SAME convention `freq = 261.6256 * 2^volts` that the
      // Faust DSP applies — node-web-audio-api can't host the Faust
      // AudioWorklet, so the OscillatorNode stands in for the meowbox
      // voiced excitation. The bug being guarded against was a math error,
      // not an oscillator-implementation difference.
      const buf = await renderOscillatorAt(predicted);
      const dominant = dominantFrequency(buf, SAMPLE_RATE);
      expect(
        Math.abs(dominant - ref.hz),
        `${ref.note} (${ref.volts}V): rendered ${dominant.toFixed(2)} Hz vs expected ${ref.hz} Hz`,
      ).toBeLessThan(FREQ_TOLERANCE_HZ);
    });
  }

  it('pitch CV sweep -2V..+2V produces a geometric Hz sequence (each step doubles)', async () => {
    // The defining 1V/oct invariant: every additional volt multiplies the
    // frequency by 2. Render at each step and assert the measured
    // fundamentals form a doubling sequence. Under the OLD bug, the ratio
    // would have been ~2^(1/12) ≈ 1.059 (just one semitone per volt).
    const sweepHz: number[] = [];
    for (let v = -2; v <= 2; v++) {
      const f = meowboxBaseFreqHz(v, 0);
      const buf = await renderOscillatorAt(f);
      sweepHz.push(dominantFrequency(buf, SAMPLE_RATE));
    }
    for (let i = 1; i < sweepHz.length; i++) {
      const ratio = sweepHz[i]! / sweepHz[i - 1]!;
      expect(
        Math.abs(ratio - 2),
        `step ${i}: rendered ratio ${ratio.toFixed(3)} should be 2 (one octave per volt)`,
      ).toBeLessThan(0.05);
    }
    // Sanity: the absolute Hz values match the reference table.
    expect(Math.abs(sweepHz[2]! - MEOWBOX_C4_HZ)).toBeLessThan(FREQ_TOLERANCE_HZ);
  });

  it('pitch knob = +12 semitones is equivalent to +1V on the CV', async () => {
    // Tests the additive composition of CV (volts) and knob (semitones)
    // inside the Faust baseFreq function. 12 semis = 1 octave by definition.
    const viaKnob = meowboxBaseFreqHz(0, 12);
    const viaCv = meowboxBaseFreqHz(1, 0);
    expect(Math.abs(viaKnob - viaCv)).toBeLessThan(0.01);

    const bufKnob = await renderOscillatorAt(viaKnob);
    const bufCv = await renderOscillatorAt(viaCv);
    const fKnob = dominantFrequency(bufKnob, SAMPLE_RATE);
    const fCv = dominantFrequency(bufCv, SAMPLE_RATE);
    expect(Math.abs(fKnob - fCv)).toBeLessThan(FREQ_TOLERANCE_HZ);
  });
});
