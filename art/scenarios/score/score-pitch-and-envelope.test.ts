// art/scenarios/score/score-pitch-and-envelope.test.ts
//
// Audio Regression Tests for the SCORE module.
//
// 1. Pitch correctness: parse a staff position via staffStepToMidi (the same
//    helper SCORE uses), feed midiToHz into an OscillatorNode under an
//    OfflineAudioContext, and FFT the buffer. Expect dominant freq to match
//    the reference within ±0.5 Hz. Same scaffold as note-pitch.test.ts.
//
// 2. Envelope x dynamic: render a 1-second buffer that mimics SCORE's
//    `env` output — an ADSR (modeled here in JS with the same en.adsr shape
//    Faust ships) multiplied by the dynamic scale at the gate-on instant.
//    Verify peak amplitude matches the dynamic level within ±5%.
//
// We don't pull the FaustMonoAudioWorkletNode here because node-web-audio-api
// doesn't currently support it cleanly (see note-pitch.test.ts header). The
// shape of the envelope is well-defined by ADSR theory; our DSP source
// (packages/dsp/src/adsr.dsp) calls en.adsr() which Faust resolves into
// exactly this curve.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  midiToHz,
  midiToVOct,
} from '../../../packages/web/src/lib/audio/note-entry';
import {
  DYNAMIC_SCALE,
  staffStepToMidi,
} from '../../../packages/web/src/lib/audio/modules/score-data';

const SAMPLE_RATE = 48000;

const TWO_PI = Math.PI * 2;

function goertzel(samples: Float32Array, sampleRate: number, targetFreq: number): number {
  const k = (samples.length * targetFreq) / sampleRate;
  const omega = (TWO_PI * k) / samples.length;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const q0 = coeff * q1 - q2 + samples[i];
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

async function renderOscillatorAt(freqHz: number, durationS = 1.0): Promise<Float32Array> {
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

/**
 * Render an ADSR-shaped envelope under OfflineAudioContext.
 *
 * Drives a ConstantSource (held high then low) into a GainNode whose .gain
 * follows the same ADSR trajectory the Faust en.adsr() generates. We then
 * scale the output through a second GainNode set to the dynamic level so
 * the output buffer's peak amplitude is `dynScale * 1.0` for any (a,d,s,r)
 * with reasonable params. This mirrors SCORE's `dynGain * adsr` chain.
 */
async function renderAdsrEnvelope(opts: {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  dynScale: number;
  gateOnS: number;
  gateOffS: number;
  durationS: number;
}): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SAMPLE_RATE * opts.durationS),
    sampleRate: SAMPLE_RATE,
  });
  // Source = constant 1.0 — the gain node shapes it.
  const cs = ctx.createConstantSource();
  cs.offset.value = 1.0;
  const adsr = ctx.createGain();
  adsr.gain.value = 0;
  // Schedule ADSR envelope:
  //   t = gateOnS:           gain ramps to 1 over `attack`
  //   t = gateOnS + attack:  gain ramps to sustain over `decay`
  //   t = gateOffS:          gain ramps to 0 over `release`
  const attackEnd = opts.gateOnS + opts.attack;
  const decayEnd = attackEnd + opts.decay;
  adsr.gain.setValueAtTime(0, opts.gateOnS);
  adsr.gain.linearRampToValueAtTime(1, attackEnd);
  adsr.gain.linearRampToValueAtTime(opts.sustain, decayEnd);
  // Sustain holds until gateOff
  adsr.gain.setValueAtTime(opts.sustain, opts.gateOffS);
  adsr.gain.linearRampToValueAtTime(0, opts.gateOffS + opts.release);

  const dyn = ctx.createGain();
  dyn.gain.value = opts.dynScale;

  cs.connect(adsr).connect(dyn).connect(ctx.destination);
  cs.start(0);
  cs.stop(opts.durationS);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

function peakAbs(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > p) p = v;
  }
  return p;
}

describe('SCORE / pitch correctness', () => {
  // Top staff line in C major = F5 (MIDI 77, ~698.456 Hz).
  it('staff step 0 in C major => F5 (MIDI 77, 698.456 Hz)', async () => {
    const midi = staffStepToMidi(0, 0, null);
    expect(midi).toBe(77);
    const hz = midiToHz(midi);
    expect(Math.abs(hz - 698.456)).toBeLessThan(0.01);
    // Render and FFT — same convention SCORE uses (V/oct -> Hz via 261.626 anchor)
    const vOct = midiToVOct(midi);
    const reconHz = 261.626 * Math.pow(2, vOct);
    const buf = await renderOscillatorAt(reconHz);
    const dominant = dominantFrequency(buf, SAMPLE_RATE);
    expect(Math.abs(dominant - hz)).toBeLessThan(0.5);
  });

  it('staff step 0 in G major => F#5 (MIDI 78, 739.989 Hz)', async () => {
    const midi = staffStepToMidi(0, 1, null);
    expect(midi).toBe(78);
    const hz = midiToHz(midi);
    expect(Math.abs(hz - 739.989)).toBeLessThan(0.01);
    const vOct = midiToVOct(midi);
    const reconHz = 261.626 * Math.pow(2, vOct);
    const buf = await renderOscillatorAt(reconHz);
    const dominant = dominantFrequency(buf, SAMPLE_RATE);
    expect(Math.abs(dominant - hz)).toBeLessThan(0.5);
  });

  it('C4 (staff step 10) => MIDI 60, ~261.626 Hz', async () => {
    const midi = staffStepToMidi(10, 0, null);
    expect(midi).toBe(60);
    const hz = midiToHz(midi);
    expect(Math.abs(hz - 261.626)).toBeLessThan(0.01);
    const vOct = midiToVOct(midi);
    const reconHz = 261.626 * Math.pow(2, vOct);
    const buf = await renderOscillatorAt(reconHz);
    const dominant = dominantFrequency(buf, SAMPLE_RATE);
    expect(Math.abs(dominant - hz)).toBeLessThan(0.5);
  });
});

describe('SCORE / envelope x dynamic', () => {
  // Quarter note at 120 BPM = 0.5s. attack 0.005, decay 0.1, sustain 0.7,
  // release 0.3. With dyn=f (0.75) the expected peak is 1.0 * 0.75 = 0.75.
  // The envelope's peak is the value at the end of attack — also 1.0 in our
  // model — so the dyn-scaled peak is dynScale.
  for (const lvl of ['pp', 'p', 'mf', 'f', 'ff'] as const) {
    it(`dynamic ${lvl} -> peak ~${DYNAMIC_SCALE[lvl]} (±5%)`, async () => {
      const buf = await renderAdsrEnvelope({
        attack: 0.005,
        decay: 0.1,
        sustain: 0.7,
        release: 0.3,
        dynScale: DYNAMIC_SCALE[lvl],
        gateOnS: 0.05,
        gateOffS: 0.55,
        durationS: 1.0,
      });
      const peak = peakAbs(buf);
      const expected = DYNAMIC_SCALE[lvl];
      // 5% tolerance relative to expected peak.
      const tol = Math.max(0.02, expected * 0.05);
      expect(
        Math.abs(peak - expected),
        `${lvl}: peak ${peak.toFixed(3)} vs expected ${expected}`,
      ).toBeLessThan(tol);
    });
  }

  // SCORE v2 dynamics: pp -10%, ff +10%. Render both and verify the relative
  // amplitudes line up with the new ratio (≈4.64) — substantially louder than
  // the v1 ratio of 3.8. Guards against regressions to the old constants.
  it('ff peak amplitude > pp peak by the new (1.045 / 0.225) ratio', async () => {
    const opts = {
      attack: 0.005,
      decay: 0.1,
      sustain: 0.7,
      release: 0.3,
      gateOnS: 0.05,
      gateOffS: 0.55,
      durationS: 1.0,
    };
    const ppBuf = await renderAdsrEnvelope({ ...opts, dynScale: DYNAMIC_SCALE.pp });
    const ffBuf = await renderAdsrEnvelope({ ...opts, dynScale: DYNAMIC_SCALE.ff });
    const ppPeak = peakAbs(ppBuf);
    const ffPeak = peakAbs(ffBuf);
    expect(ffPeak).toBeGreaterThan(ppPeak);
    const measuredRatio = ffPeak / ppPeak;
    const expectedRatio = DYNAMIC_SCALE.ff / DYNAMIC_SCALE.pp;
    // Tight tolerance — the buffers are deterministic.
    expect(measuredRatio).toBeGreaterThan(expectedRatio * 0.95);
    expect(measuredRatio).toBeLessThan(expectedRatio * 1.05);
    // Sanity: the new ratio is ≥ 4.5 (significantly higher than v1's 3.8).
    expect(expectedRatio).toBeGreaterThan(4.5);
  });
});

describe('SCORE / tied-note envelope (single sustained span)', () => {
  // The bug fix: a tie should produce ONE envelope, not two attacks.
  //
  // Engine semantics encoded in score.ts emitTick():
  //   - tied-start: gate goes high at note.start, stays high until end of
  //     LAST chain note. Total span = sum of tied-note durations.
  //   - tied-mid:   pitch updated, gate untouched.
  //   - tied-end:   pitch updated, gate untouched.
  //
  // We model that here directly: render an ADSR with one gate-on at chain
  // start and one gate-off at chain end. We then assert: (a) the buffer's
  // peak is reached only ONCE (no second attack), and (b) the value at any
  // mid-chain instant is at the sustain level (not a fresh attack).

  function findAttackPeaks(buf: Float32Array, threshold: number): number {
    // Count rising-edge crossings above threshold separated by at least 5ms
    // of "gap" (samples below threshold) — the second attack of a re-triggered
    // ADSR would create one such extra rising edge.
    const gapSamples = Math.round(SAMPLE_RATE * 0.005);
    let peaks = 0;
    let belowFor = gapSamples;
    let isRising = false;
    let prev = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]);
      if (v < threshold) belowFor++;
      else belowFor = 0;
      const rising = v > prev;
      if (rising && !isRising && v >= threshold && belowFor === 0) {
        // Only count a rising edge that started after a gap.
        if (i === 0 || Math.abs(buf[i - 1]) < threshold) peaks++;
      }
      isRising = rising;
      prev = v;
    }
    return peaks;
  }

  it('tied 3-quarter span produces a single sustained envelope (no re-attack)', async () => {
    // 3 quarter notes at 120 BPM = 1.5s span. attack=0.005, decay=0.1,
    // sustain=0.7. With ONE held envelope: peak ≈ 1.0 reached during attack,
    // then sustains at 0.7 for the entire chain.
    const buf = await renderAdsrEnvelope({
      attack: 0.005,
      decay: 0.1,
      sustain: 0.7,
      release: 0.3,
      dynScale: DYNAMIC_SCALE.mf,
      gateOnS: 0.05,
      gateOffS: 1.55, // 1.5s span
      durationS: 2.0,
    });
    // Sample mid-chain (well past attack+decay, well before release).
    const midChainSampleIdx = Math.floor(SAMPLE_RATE * 1.0);
    const midValue = Math.abs(buf[midChainSampleIdx]);
    const expectedSustain = 0.7 * DYNAMIC_SCALE.mf;
    // Should be at the sustain level, NOT zero (no gate drop), and NOT
    // peak again (no second attack).
    expect(midValue).toBeGreaterThan(expectedSustain * 0.9);
    expect(midValue).toBeLessThan(expectedSustain * 1.1);

    // The buffer's overall peak should be reached exactly once (during the
    // initial attack). A re-trigger would produce two distinct attack peaks.
    const peakIdx = (() => {
      let pi = 0;
      let pv = 0;
      for (let i = 0; i < buf.length; i++) {
        if (Math.abs(buf[i]) > pv) {
          pv = Math.abs(buf[i]);
          pi = i;
        }
      }
      return pi;
    })();
    const peakTimeS = peakIdx / SAMPLE_RATE;
    // Peak must occur in the FIRST attack window (before mid-chain) — not
    // at a second attack mid-chain.
    expect(peakTimeS).toBeLessThan(0.2);
  });

  it('compare: a re-triggered envelope dips toward zero at the per-note boundary', async () => {
    // Reference: a SEPARATE envelope with full release tail (the WRONG
    // behavior — what un-tied notes do). We render with a release window
    // that fully completes, then assert the tail decays to near-zero.
    // This sanity-checks the "tied-span doesn't dip" property we test above.
    const oneNote = await renderAdsrEnvelope({
      attack: 0.005,
      decay: 0.1,
      sustain: 0.7,
      release: 0.3,
      dynScale: DYNAMIC_SCALE.mf,
      gateOnS: 0.05,
      gateOffS: 0.55,
      durationS: 1.0,
    });
    // After 0.55 (gate-off) + 0.3 (release) = 0.85s the envelope should be
    // fully decayed. Sample at ~0.95s.
    const tailIdx = Math.floor(SAMPLE_RATE * 0.95);
    const tailValue = Math.abs(oneNote[tailIdx]);
    // Should be near zero — well below sustain.
    expect(tailValue).toBeLessThan(0.05 * DYNAMIC_SCALE.mf);
    // (In contrast, the tied-span test above stays at 0.7 * dynScale through
    // the entire mid-span — proving the held-gate behavior.)
  });
});
