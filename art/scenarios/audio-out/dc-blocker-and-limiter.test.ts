// art/scenarios/audio-out/dc-blocker-and-limiter.test.ts
//
// ART for audio-out's two new safety stages (added in feat/audio-fidelity-...):
//   1. 5Hz BiquadFilter highpass on each channel (DC blocker)
//   2. Stereo DynamicsCompressorNode (master limiter)
//
// We don't drive the actual audioOutDef factory (it terminates in
// ctx.destination, so the OfflineAudioContext rendered output IS what we
// see). Instead we measure the destination output for known input
// patterns: DC offset → blocked; transient peak above limiter threshold
// → reduced.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { audioOutDef } from '../../../packages/web/src/lib/audio/modules/audio-out';

const SAMPLE_RATE = 48000;

interface RenderOpts {
  /** Constant DC offset to feed into both L and R inputs (linear amplitude). */
  dcOffset?: number;
  /** Optional sine wave to add ON TOP of the DC, at this frequency / amp. */
  sineHz?: number;
  sineAmp?: number;
  /** Optional: an impulse spike of this peak amplitude inserted at sample 1000.
   *  Used to test the limiter's transient response. */
  impulseAmp?: number;
  durationS?: number;
}

/** Drive both L+R inputs with a controlled signal, measure the stereo
 *  destination output. */
async function renderAudioOutDestination(opts: RenderOpts): Promise<{
  left: Float32Array;
  right: Float32Array;
}> {
  const durationS = opts.durationS ?? 0.5;
  const length = Math.round(SAMPLE_RATE * durationS);
  // OfflineAudioContext is stereo by default; ctx.destination has 2
  // channels. The audio-out module's master limiter writes to
  // ctx.destination directly, so the rendered output IS what speakers
  // would hear.
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length,
    sampleRate: SAMPLE_RATE,
  });

  const node = {
    id: 'audioOut-1',
    type: 'audioOut',
    domain: 'audio' as const,
    position: { x: 0, y: 0 },
    params: { master: 1.0 }, // unity gain — we want to see the protection stages
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = await audioOutDef.factory(ctx as any, node);

  // Build the input signal: sine + DC + optional impulse.
  // We can't send a JS-computed sample buffer through the audioOut's input
  // ports unless we use AudioBufferSourceNode. Build a buffer.
  const inputBuf = ctx.createBuffer(1, length, SAMPLE_RATE);
  const data = inputBuf.getChannelData(0);
  const dc = opts.dcOffset ?? 0;
  const sineHz = opts.sineHz ?? 0;
  const sineAmp = opts.sineAmp ?? 0;
  for (let i = 0; i < length; i++) {
    let v = dc;
    if (sineHz > 0) v += sineAmp * Math.sin((2 * Math.PI * sineHz * i) / SAMPLE_RATE);
    data[i] = v;
  }
  if (opts.impulseAmp !== undefined && length > 1000) {
    data[1000] = opts.impulseAmp;
  }

  const srcL = ctx.createBufferSource();
  srcL.buffer = inputBuf;
  const srcR = ctx.createBufferSource();
  srcR.buffer = inputBuf;
  const lIn = handle.inputs.get('L');
  const rIn = handle.inputs.get('R');
  if (lIn) srcL.connect(lIn.node, 0, lIn.input);
  if (rIn) srcR.connect(rIn.node, 0, rIn.input);
  srcL.start(0);
  srcR.start(0);

  const rendered = await ctx.startRendering();
  return {
    left:  rendered.getChannelData(0).slice(),
    right: rendered.getChannelData(1).slice(),
  };
}

describe('audio-out ART: DC blocker', () => {
  it('blocks pure DC offset (input 0.5 DC → output ≈ 0 after settling)', async () => {
    const { left } = await renderAudioOutDestination({ dcOffset: 0.5 });
    // Allow the highpass to settle (5Hz cutoff → ~50ms group delay).
    // Sample well after settling — at sample 24000 (0.5s into a 0.5s
    // render → end). Use the last 1000 samples for the steady-state
    // assertion.
    const steady = left.slice(left.length - 1000);
    let avg = 0;
    for (const v of steady) avg += v;
    avg /= steady.length;
    expect(Math.abs(avg), `steady-state DC residual ${avg}`).toBeLessThan(0.01);
  });

  it('passes a 200Hz sine through largely unattenuated', async () => {
    // 200Hz is well above the 5Hz cutoff. Output amplitude should match
    // input (within limiter's permissive range — sine peak 0.3 stays well
    // below threshold).
    const { left } = await renderAudioOutDestination({
      sineHz: 200,
      sineAmp: 0.3,
      durationS: 0.2,
    });
    // Measure peak of the steady-state portion.
    const steady = left.slice(5000); // skip transient
    let peak = 0;
    for (const v of steady) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    // 5Hz HP attenuates 200Hz by < 0.1 dB. Limiter at -6dB is inactive
    // for amp 0.3 (= -10.5 dBFS). DynamicsCompressorNode applies a small
    // amount of automatic makeup even when not actively compressing —
    // expect peak in 0.27..0.40 range.
    expect(peak, `200Hz sine peak ${peak}`).toBeGreaterThan(0.27);
    expect(peak).toBeLessThan(0.40);
  });

  it('attenuates a 1Hz sine (well below the 5Hz cutoff)', async () => {
    // At 1Hz, the 5Hz HP attenuates by ~14 dB (5x below cutoff). Render
    // 0.5s — half a 1Hz cycle is enough to see attenuation.
    const { left } = await renderAudioOutDestination({
      sineHz: 1,
      sineAmp: 0.5,
      durationS: 0.5,
    });
    let peak = 0;
    for (const v of left) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    // 14 dB attenuation → peak ≈ 0.5 × 0.2 = 0.1. Be lenient (0.2) to
    // accommodate filter ringing and limiter leakage.
    expect(peak, `1Hz sine attenuated peak ${peak}`).toBeLessThan(0.25);
  });
});

describe('audio-out ART: master limiter', () => {
  it('caps a transient that exceeds the -6dB threshold', async () => {
    // Feed a sine at amplitude 1.5 (well above the limiter's -6dB ≈ 0.5
    // threshold). The output peak should be limited.
    const { left } = await renderAudioOutDestination({
      sineHz: 500,
      sineAmp: 1.5,
      durationS: 0.2,
    });
    // Measure the steady-state peak (skip first 50ms for compressor settling).
    const steady = left.slice(Math.round(SAMPLE_RATE * 0.05));
    let peak = 0;
    for (const v of steady) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    // Without limiting, peak would be 1.5. With 4:1 ratio above -6dB +
    // makeup gain, the output should still be meaningfully below 1.5 —
    // we just need to confirm the limiter is making a difference. Allow
    // peak up to 1.2 (= 20% reduction from 1.5).
    expect(peak, `limited peak ${peak} for input amp 1.5`).toBeLessThan(1.2);
  });

  it('passes a quiet sine through transparently', async () => {
    const { left } = await renderAudioOutDestination({
      sineHz: 500,
      sineAmp: 0.2,
      durationS: 0.2,
    });
    const steady = left.slice(5000);
    let peak = 0;
    for (const v of steady) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    // 0.2 (= -14 dBFS) is well below -6dB threshold; output should match
    // within DynamicsCompressorNode's auto-makeup tolerance (~10-20%).
    expect(peak).toBeGreaterThan(0.18);
    expect(peak).toBeLessThan(0.30);
  });
});

describe('audio-out ART: combined behavior on stress patterns', () => {
  it('handles a sine-on-DC: DC blocked, sine preserved', async () => {
    // Common bug case: an LFO patched into an audio chain via VCA can
    // produce a sine wave riding on a DC offset. The DC blocker should
    // strip the DC; the sine should pass through.
    const { left } = await renderAudioOutDestination({
      dcOffset: 0.4,
      sineHz: 200,
      sineAmp: 0.3,
      durationS: 0.3,
    });
    // Average over the last 1000 samples — DC blocker should null this
    // close to zero.
    const tail = left.slice(left.length - 1000);
    let avg = 0;
    for (const v of tail) avg += v;
    avg /= tail.length;
    expect(Math.abs(avg)).toBeLessThan(0.02);
    // Peak (the 200Hz sine) should remain measurable.
    let peak = 0;
    for (const v of tail) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0.2);
  });
});
