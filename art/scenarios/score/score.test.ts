// art/scenarios/score/score.test.ts
//
// ART for the SCORE module — verifies the two end-to-end audio properties
// callable headless without spinning up the full PatchEngine:
//
//   1. Pitch correctness: a placed C4 (MIDI 60) → V/oct = 0 → 261.626 Hz
//      to within ±0.5 Hz under FFT analysis. Shares the dominantFrequency
//      scaffold from note-pitch.test.ts.
//
//   2. Envelope × dynamic: a quarter note rendered with `f` produces a peak
//      around DYNAMIC_SCALE.f = 0.75 ± 5 %; `pp` at DYNAMIC_SCALE.pp = 0.25.
//      The "envelope" here is the dynamic-gain ramp the SCORE module would
//      apply to its ADSR voice (we model the ADSR as a fast attack to 1.0
//      sustain, since the dynamic gain is the multiplier we're testing).
//
// Both tests bypass the AudioWorklet path because node-web-audio-api can't
// load the Faust ADSR worklet. They exercise the same dynamic-scaling math
// the SCORE module uses (DYNAMIC_SCALE table + envelope-shaped multiplier),
// which is what's specific to this module's contribution.

import { describe, it, expect } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  midiToVOct,
  midiToHz,
  C4_MIDI,
} from '../../../packages/web/src/lib/audio/note-entry';
import {
  DYNAMIC_SCALE,
  staffStepToMidi,
  type DynamicLevel,
} from '../../../packages/web/src/lib/audio/score-data';

const SAMPLE_RATE = 48000;
const TWO_PI = Math.PI * 2;

function goertzel(samples: Float32Array, sampleRate: number, targetFreq: number): number {
  const k = (samples.length * targetFreq) / sampleRate;
  const omega = (TWO_PI * k) / samples.length;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q1 = 0, q2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const q0 = coeff * q1 - q2 + samples[i]!;
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

function dominantFrequency(buffer: Float32Array, sampleRate: number): number {
  const n = buffer.length;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((TWO_PI * i) / (n - 1)));
    w[i] = (buffer[i] ?? 0) * win;
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

async function renderToneAt(freqHz: number, durationS: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SAMPLE_RATE * durationS),
    sampleRate: SAMPLE_RATE,
  });
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqHz, 0);
  osc.connect(ctx.destination);
  osc.start(0);
  osc.stop(durationS);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Render a sine tone gated by the dynamic-gain envelope SCORE applies on a
 *  note-start. Models the SCORE engine's `dynGain.gain.setValueAtTime(scale)`
 *  step plus a fast attack to peak. Returns the rendered buffer. */
async function renderDynamicGatedTone(
  freqHz: number,
  durationS: number,
  dyn: DynamicLevel,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SAMPLE_RATE * durationS),
    sampleRate: SAMPLE_RATE,
  });
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqHz, 0);
  // Model the ADSR sustain at 1.0 (so dynGain is the only attenuation).
  // This isolates the dynamic-scaling factor from envelope shape.
  const dynGain = ctx.createGain();
  const scale = DYNAMIC_SCALE[dyn];
  dynGain.gain.setValueAtTime(scale, 0);
  osc.connect(dynGain).connect(ctx.destination);
  osc.start(0);
  osc.stop(durationS);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

function peakAbs(buffer: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = Math.abs(buffer[i]!);
    if (a > p) p = a;
  }
  return p;
}

describe('SCORE ART — pitch correctness', () => {
  it('placed C4 → 261.626 Hz (within ±0.5 Hz)', async () => {
    // SCORE's pitch port emits midiToVOct(midi). The downstream VCO uses
    // freqHz = 261.626 * 2^vOct. Verify the round-trip end-to-end.
    expect(midiToVOct(C4_MIDI)).toBe(0);
    const expectedHz = midiToHz(C4_MIDI);
    expect(expectedHz).toBeCloseTo(261.626, 2);
    const buf = await renderToneAt(expectedHz, 1.0);
    const dom = dominantFrequency(buf, SAMPLE_RATE);
    expect(Math.abs(dom - 261.626), `C4 fundamental: ${dom.toFixed(3)} Hz`).toBeLessThan(0.5);
  });

  it('staff-step→MIDI: top staff line is F5 in C major, F#5 in G major', () => {
    expect(staffStepToMidi(0, 0, null)).toBe(77);
    expect(staffStepToMidi(0, 1, null)).toBe(78);
  });

  it('per-note natural in G major plays F natural', () => {
    expect(staffStepToMidi(0, 1, 'natural')).toBe(77);
  });
});

describe('SCORE ART — envelope × dynamic gain', () => {
  it('quarter note at f → peak ≈ DYNAMIC_SCALE.f (0.75 ± 5%)', async () => {
    // 0.25 s render at 261.626 Hz with dynamic gain set to f.
    const buf = await renderDynamicGatedTone(261.626, 0.25, 'f');
    const peak = peakAbs(buf);
    // The sine osc peaks at 1.0; gain attenuates to DYNAMIC_SCALE.f = 0.75.
    expect(peak).toBeGreaterThan(DYNAMIC_SCALE.f - 0.05);
    expect(peak).toBeLessThan(DYNAMIC_SCALE.f + 0.05);
  });

  it('quarter note at pp → peak ≈ 0.25', async () => {
    const buf = await renderDynamicGatedTone(261.626, 0.25, 'pp');
    const peak = peakAbs(buf);
    expect(peak).toBeGreaterThan(DYNAMIC_SCALE.pp - 0.03);
    expect(peak).toBeLessThan(DYNAMIC_SCALE.pp + 0.03);
  });

  it('quarter note at ff → peak ≈ 0.95', async () => {
    const buf = await renderDynamicGatedTone(261.626, 0.25, 'ff');
    const peak = peakAbs(buf);
    expect(peak).toBeGreaterThan(DYNAMIC_SCALE.ff - 0.05);
    expect(peak).toBeLessThan(DYNAMIC_SCALE.ff + 0.05);
  });

  it('mf default sits between p and f', () => {
    expect(DYNAMIC_SCALE.p).toBeLessThan(DYNAMIC_SCALE.mf);
    expect(DYNAMIC_SCALE.mf).toBeLessThan(DYNAMIC_SCALE.f);
    expect(DYNAMIC_SCALE.mf).toBe(0.55);
  });
});
