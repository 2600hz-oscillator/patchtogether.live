// art/scenarios/vca-invert/sign-flip.test.ts
//
// ART for VCA's new audio_inv output. We can't run the Faust VCA worklet
// under node-web-audio-api directly, so we exercise the SAME inverter
// topology vca.ts uses — a parallel GainNode(-1) tap of the main output
// — driven by a sine-wave audio source. Sample-accurate sign inversion
// at every position.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';

const SAMPLE_RATE = 48000;

interface RenderResult {
  audio: Float32Array;
  audioInv: Float32Array;
}

async function renderSineThroughInverter(freqHz: number, durationS: number): Promise<RenderResult> {
  const length = Math.round(SAMPLE_RATE * durationS);
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length,
    sampleRate: SAMPLE_RATE,
  });
  // Stand-in for the VCA's main audio output: a sine OscillatorNode.
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqHz, 0);

  // Inverter topology — copied verbatim from vca.ts factory.
  const inverter = ctx.createGain();
  inverter.gain.value = -1;
  osc.connect(inverter);

  // Both outputs → 2-channel destination.
  const merger = ctx.createChannelMerger(2);
  osc.connect(merger, 0, 0);
  inverter.connect(merger, 0, 1);
  merger.connect(ctx.destination);

  osc.start(0);
  osc.stop(durationS);
  const rendered = await ctx.startRendering();
  return {
    audio: rendered.getChannelData(0).slice(),
    audioInv: rendered.getChannelData(1).slice(),
  };
}

describe('VCA.audio_inv ART: sign-flip topology = -audio', () => {
  it('renders sine + inverted sine with sample-wise audioInv = -audio', async () => {
    const { audio, audioInv } = await renderSineThroughInverter(440, 0.05);
    expect(audio.length).toBe(audioInv.length);
    expect(audio.length).toBeGreaterThan(0);

    let worstDelta = 0;
    let worstIdx = 0;
    for (let i = 0; i < audio.length; i++) {
      const expected = -audio[i];
      const delta = Math.abs(audioInv[i] - expected);
      if (delta > worstDelta) {
        worstDelta = delta;
        worstIdx = i;
      }
    }
    expect(
      worstDelta,
      `worst sample mismatch at idx ${worstIdx}: audio=${audio[worstIdx].toFixed(6)} ` +
        `audioInv=${audioInv[worstIdx].toFixed(6)} expected=${(-audio[worstIdx]).toFixed(6)}`,
    ).toBeLessThan(1e-5);
  });

  it('full-cycle null-test: audio + audioInv sums to ≈ 0 at every sample', async () => {
    // Fundamental property of phase-flipped audio: x + (-x) = 0. Sums >
    // 1e-5 indicate the inverter chain has drift or DC offset.
    const { audio, audioInv } = await renderSineThroughInverter(220, 0.05);
    let worst = 0;
    for (let i = 0; i < audio.length; i++) {
      const sum = Math.abs(audio[i] + audioInv[i]);
      if (sum > worst) worst = sum;
    }
    expect(worst, `null-test peak abs sum: ${worst}`).toBeLessThan(1e-5);
  });

  it('inverter preserves amplitude (not attenuating, just flipping sign)', async () => {
    // Sine with amplitude ~1 → inverted sine with amplitude ~1.
    const { audio, audioInv } = await renderSineThroughInverter(1000, 0.02);
    let pkAudio = 0, pkInv = 0;
    for (let i = 0; i < audio.length; i++) {
      const a = Math.abs(audio[i]);
      const b = Math.abs(audioInv[i]);
      if (a > pkAudio) pkAudio = a;
      if (b > pkInv) pkInv = b;
    }
    expect(pkAudio).toBeGreaterThan(0.5);
    expect(Math.abs(pkInv - pkAudio)).toBeLessThan(1e-5);
  });
});
