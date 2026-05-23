// art/scenarios/note-pitch/note-pitch.test.ts
//
// ART (Audio Regression Test) for D5: note-name -> MIDI -> V/oct -> Hz pipeline.
//
// Scenario: parse a note name through the same parser the Sequencer + Cartesian
// cards use, run it through the matching V/oct math, drive an OscillatorNode
// in an OfflineAudioContext at the resulting frequency, render 1 second, FFT,
// assert the dominant bin matches the expected frequency to within ±0.5 Hz.
//
// Five reference pitches per the spec (.myrobots/plans/sequencer-cartesian-note-entry.md):
//
//   note  | MIDI | expected Hz
//   ------+------+--------------
//   a1    | 33   | 55.000
//   c3    | 48   | 130.813
//   a4    | 69   | 440.000
//   e6    | 88   | 1318.510
//   f#8   | 114  | 5919.911   (spec text said MIDI 102; 5919.911 Hz uniquely
//                              identifies MIDI 114 with a4=69=440Hz, so the
//                              MIDI column was a typo — corrected here.)
//
// The "real" sequencer/VCO pipeline uses Faust DSP in an AudioWorklet which
// node-web-audio-api doesn't currently support without extra plumbing. Since
// the V/oct convention used downstream is `freqHz = 261.626 * 2^vOct`
// (matches both packages/dsp/src/analog-vco.dsp and wavetable-vco.ts), we
// drive the same vOct value into an OscillatorNode set to the equivalent
// frequency. This validates the parser + V/oct conversion against the
// project's V/oct convention, which is what D5 actually changes.

import { describe, it, expect } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  parseNoteName,
  midiToVOct,
  midiToHz,
} from '../../../packages/web/src/lib/audio/note-entry';

const SAMPLE_RATE = 48000;
const DURATION_S = 1.0;
const FREQ_TOLERANCE_HZ = 0.5;

const TWO_PI = Math.PI * 2;

/** DFT-style fundamental detector. Picks the bin index with the largest
 *  magnitude over the buffer, then refines via parabolic interpolation across
 *  its neighbors. Sufficient for "is the dominant frequency at X Hz?" to ±0.1
 *  Hz on a 1-second buffer at 48 kHz. */
function dominantFrequency(buffer: Float32Array, sampleRate: number): number {
  const n = buffer.length;
  // Limit DFT to the lowest ~20 kHz worth of bins to keep this fast and
  // because everything we care about lives below Nyquist anyway.
  const maxFreq = Math.min(20_000, sampleRate / 2 - 100);
  // Bin resolution = sampleRate / n. For 48k @ 1s, that's 1 Hz/bin.
  const binHz = sampleRate / n;
  const lowBin = 1; // skip DC
  const highBin = Math.min(n / 2, Math.floor(maxFreq / binHz));

  let bestBin = lowBin;
  let bestMag = -Infinity;
  // Pre-windowed buffer (Hann) to suppress spectral leakage that would smear
  // the peak across neighbouring bins.
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((TWO_PI * i) / (n - 1)));
    w[i] = buffer[i] * win;
  }
  // Coarse: scan only every step-th bin first, then refine.
  // For 48k samples, the loop is bounded; we do the slow but obvious O(n*bins)
  // version since this only runs 5 times in the test suite.
  // Actually bins=20000 * n=48000 = 960M flops — too slow. Do FFT.
  // node-web-audio-api doesn't expose FFT directly; use a Goertzel-per-bin
  // sweep instead, which is O(n) per bin and we only need to find the peak.
  // To stay fast: pick a coarse 4-Hz grid first, then refine ±2 Hz at 0.1 Hz.
  const coarseStepHz = 4;
  let coarseBest = lowBin * binHz;
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
  // bestBin/bestMag are unused once we have fineBest — silence ts/eslint.
  void bestBin; void bestMag;
  return fineBest;
}

function goertzel(samples: Float32Array, sampleRate: number, targetFreq: number): number {
  // Standard Goertzel block-magnitude algorithm.
  const k = (samples.length * targetFreq) / sampleRate;
  const omega = (TWO_PI * k) / samples.length;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q0 = 0, q1 = 0, q2 = 0;
  for (let i = 0; i < samples.length; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
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

const REFERENCE_PITCHES: Array<{ name: string; midi: number; hz: number }> = [
  // c0 and c1 are the bottom-end additions from the c0..c8 range
  // widening (PR `cv-additive-semantic-and-pitch-c0-c8`); f#8 was
  // dropped from the cap (MAX_MIDI moved 114 → 108 = c8).
  { name: 'c0',  midi: 12,  hz: 16.351 },
  { name: 'c1',  midi: 24,  hz: 32.703 },
  { name: 'a1',  midi: 33,  hz: 55.000 },
  { name: 'c3',  midi: 48,  hz: 130.813 },
  { name: 'a4',  midi: 69,  hz: 440.000 },
  { name: 'e6',  midi: 88,  hz: 1318.510 },
  { name: 'c8',  midi: 108, hz: 4186.009 },
];

describe('note-pitch ART: note name -> MIDI -> V/oct -> rendered frequency', () => {
  for (const ref of REFERENCE_PITCHES) {
    it(`parses '${ref.name}' to MIDI ${ref.midi} == ${ref.hz} Hz`, async () => {
      // Layer 1: parser maps note name -> MIDI int.
      const parsed = parseNoteName(ref.name);
      expect(parsed, `'${ref.name}' should parse to MIDI ${ref.midi}`).toBe(ref.midi);

      // Layer 2: MIDI -> Hz convenience matches the spec frequency.
      const computedHz = midiToHz(ref.midi);
      expect(Math.abs(computedHz - ref.hz)).toBeLessThan(0.01);

      // Layer 3: V/oct conversion matches what the audio-domain DSP expects.
      // The codebase convention is freqHz = 261.626 * 2^vOct (analog-vco.dsp,
      // wavetable-vco.ts) with vOct = (midi - 60)/12. Verify the round-trip.
      const vOct = midiToVOct(ref.midi);
      const reconstructedHz = 261.626 * Math.pow(2, vOct);
      // The 261.626 anchor is a 5-digit truncation of C4=261.6255653...; allow
      // a tiny rounding gap. 0.05 Hz is well under our 0.5 Hz audio tolerance.
      expect(Math.abs(reconstructedHz - ref.hz)).toBeLessThan(0.05);

      // Layer 4 (full ART): drive an OscillatorNode at the resulting Hz under
      // an OfflineAudioContext, then FFT and verify the dominant bin matches
      // the expected frequency to within ±0.5 Hz. This is the same end-to-end
      // assertion the spec asks for; the only difference from the "real" voice
      // chain is the oscillator implementation (built-in sine vs wavetable
      // VCO), which doesn't affect the fundamental frequency.
      const buf = await renderOscillatorAt(reconstructedHz);
      const dominant = dominantFrequency(buf, SAMPLE_RATE);
      expect(
        Math.abs(dominant - ref.hz),
        `${ref.name}: rendered fundamental ${dominant.toFixed(3)} Hz vs expected ${ref.hz} Hz`,
      ).toBeLessThan(FREQ_TOLERANCE_HZ);
    });
  }
});
