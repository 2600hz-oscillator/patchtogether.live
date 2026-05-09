// art/scenarios/adsr-invert/env-invert.test.ts
//
// ART for ADSR's new env_inv output. The full ADSR DSP runs in a Faust
// AudioWorklet which node-web-audio-api can't host directly (see other
// ART scenarios that work around this), so we exercise the SAME
// inversion topology the adsr.ts factory builds — ConstantSource(+1)
// summed with GainNode(-1) on the env signal — using a synthesized
// envelope source. This validates the math, polarity, and DC-offset
// handling that the production code path relies on.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';

const SAMPLE_RATE = 48000;

interface RenderOpts {
  envelopeSamples: Float32Array;
  durationS: number;
}

interface RenderResult {
  env: Float32Array;
  envInv: Float32Array;
}

/**
 * Render env + envInv in parallel from a synthesized envelope buffer.
 * envInv is built with the SAME node topology adsr.ts uses:
 *   ConstantSource(+1) → GainNode(invBus, +1)
 *   envSrc → GainNode(-1) → GainNode(invBus, +1)
 *   invBus.output = 1 + (-env) = 1 - env
 */
async function renderEnvelopeAndInverse(opts: RenderOpts): Promise<RenderResult> {
  const length = Math.round(SAMPLE_RATE * opts.durationS);
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length,
    sampleRate: SAMPLE_RATE,
  });

  // Envelope source: AudioBufferSourceNode driven by the synthesized envelope.
  // Acts as a stand-in for Faust's adsr worklet output — for the inverter
  // chain it doesn't matter where the env signal comes from.
  const buf = ctx.createBuffer(1, length, SAMPLE_RATE);
  const channel = buf.getChannelData(0);
  channel.set(opts.envelopeSamples);
  const envSrc = ctx.createBufferSource();
  envSrc.buffer = buf;

  // Inverter topology — copied verbatim from adsr.ts factory.
  const oneSrc = ctx.createConstantSource();
  oneSrc.offset.value = 1;
  oneSrc.start();
  const invBus = ctx.createGain();
  invBus.gain.value = 1;
  const negEnv = ctx.createGain();
  negEnv.gain.value = -1;
  oneSrc.connect(invBus);
  envSrc.connect(negEnv);
  negEnv.connect(invBus);

  // Route both env and invBus into channels 0 and 1 of the destination via
  // a 2-channel merger.
  const merger = ctx.createChannelMerger(2);
  envSrc.connect(merger, 0, 0);
  invBus.connect(merger, 0, 1);
  merger.connect(ctx.destination);

  envSrc.start(0);

  const rendered = await ctx.startRendering();
  return {
    env: rendered.getChannelData(0).slice(),
    envInv: rendered.getChannelData(1).slice(),
  };
}

/** Synthetic ADSR envelope: linear A(0.05s) → D(0.05s) to S(0.6) → hold S
 *  → R(0.05s) on gate-off. Approximates the unipolar [0, 1] envelope shape
 *  the Faust ADSR produces. */
function synthEnvelope(durationS: number): Float32Array {
  const n = Math.round(SAMPLE_RATE * durationS);
  const env = new Float32Array(n);
  const aSamps = Math.round(SAMPLE_RATE * 0.05);
  const dSamps = Math.round(SAMPLE_RATE * 0.05);
  const sustain = 0.6;
  const rSamps = Math.round(SAMPLE_RATE * 0.05);
  const gateOnUntil = n - rSamps;
  for (let i = 0; i < n; i++) {
    if (i < aSamps) {
      env[i] = i / aSamps; // 0 → 1 attack
    } else if (i < aSamps + dSamps) {
      const t = (i - aSamps) / dSamps;
      env[i] = 1 - (1 - sustain) * t; // 1 → sustain decay
    } else if (i < gateOnUntil) {
      env[i] = sustain;
    } else {
      const t = (i - gateOnUntil) / rSamps;
      env[i] = sustain * (1 - t); // sustain → 0 release
    }
  }
  return env;
}

describe('ADSR.env_inv ART: inversion topology = 1 - env', () => {
  it('renders env and envInv with envInv = 1 - env at every sample', async () => {
    const durationS = 0.4; // covers attack + decay + sustain hold + release
    const envelope = synthEnvelope(durationS);
    const { env, envInv } = await renderEnvelopeAndInverse({
      envelopeSamples: envelope,
      durationS,
    });
    expect(env.length).toBe(envelope.length);
    expect(envInv.length).toBe(envelope.length);

    // Sample-wise check. Allow a tiny tolerance for floating-point noise
    // in the audio summing buses (typically < 1e-6).
    let worstDelta = 0;
    let worstIdx = 0;
    for (let i = 0; i < env.length; i++) {
      const expected = 1 - env[i];
      const delta = Math.abs(envInv[i] - expected);
      if (delta > worstDelta) {
        worstDelta = delta;
        worstIdx = i;
      }
    }
    expect(
      worstDelta,
      `worst sample mismatch at idx ${worstIdx}: env=${env[worstIdx].toFixed(6)} ` +
        `envInv=${envInv[worstIdx].toFixed(6)} expected=${(1 - env[worstIdx]).toFixed(6)}`,
    ).toBeLessThan(1e-4);
  });

  it('at envelope=0 (rest), envInv ≈ 1 (full unipolar inverse peak)', async () => {
    // 100ms of all-zero envelope → invBus should hold +1 the whole time.
    const n = Math.round(SAMPLE_RATE * 0.1);
    const flat = new Float32Array(n); // all zeros
    const { envInv } = await renderEnvelopeAndInverse({
      envelopeSamples: flat,
      durationS: 0.1,
    });
    // Skip the first ~64 samples (Web Audio rendering quantum) and check the tail.
    for (let i = 256; i < envInv.length; i++) {
      expect(envInv[i], `envInv[${i}]`).toBeCloseTo(1, 4);
    }
  });

  it('at envelope=1 (peak), envInv ≈ 0 (envelope-flipped to silence)', async () => {
    const n = Math.round(SAMPLE_RATE * 0.1);
    const flat = new Float32Array(n);
    flat.fill(1);
    const { envInv } = await renderEnvelopeAndInverse({
      envelopeSamples: flat,
      durationS: 0.1,
    });
    for (let i = 256; i < envInv.length; i++) {
      expect(envInv[i], `envInv[${i}]`).toBeCloseTo(0, 4);
    }
  });
});
