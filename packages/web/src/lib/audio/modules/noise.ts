// packages/web/src/lib/audio/modules/noise.ts
//
// NOISE — basic noise source. Three flavors of noise on three independent
// outputs, all gain-scaled by a single LEVEL knob:
//
//   white  — full-spectrum white noise (flat spectrum). Math.random()-driven.
//   pink   — 1/f pink noise (-3 dB/oct). Voss-McCartney algorithm.
//   brown  — 1/f² brown noise (-6 dB/oct). Leaky-integrated white.
//
// Implementation strategy: pre-generate a 2-second AudioBuffer per flavor
// and loop it via three AudioBufferSourceNodes feeding three gain nodes
// (one per output, all sharing the LEVEL knob's value). This is much
// cheaper than an AudioWorklet — no per-sample JS callback, just a
// looping buffer playback. The loop seam is inaudible because (a) noise
// is by definition aperiodic and (b) at 2s × 48kHz = 96k samples the
// loop period is ~0.5Hz, far below any pitched perception.
//
// Why three independent outputs instead of one + filters: the user can
// pick any combination — patch white into one chain and brown into
// another for layered synthesis. All three are computed up-front (zero
// runtime cost beyond a buffer playback) so this is essentially free.
//
// LEVEL knob: a single GainNode per output, all driven by the same
// param value. CV-modulating LEVEL would be possible but the spec asks
// for "just one knob" with no CV input — keep it simple.
//
// Inputs: none.
//
// Outputs:
//   white (audio): full-spectrum white noise.
//   pink (audio): 1/f pink noise (-3 dB/oct).
//   brown (audio): 1/f² brown noise (-6 dB/oct).
//
// Params:
//   level (linear 0..1, default 0.5): master gain applied to all three taps.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
// The pure noise-flavor generators live in the shared DSP lib (extracted for
// the ART audio profile, which pins them with a fixed seed — the same
// relative-import pattern as moog-filterbank-factory → moog-filterbank-dsp).
import { noiseGenerators } from '../../../../../dsp/src/lib/noise-dsp';

// Re-exported so existing consumers (unit tests, MOOG 903A/923 which build
// their noise tables from the same generators) keep their import surface.
export { noiseGenerators };

/** Buffer length for the loopable noise tables. 2 seconds at typical
 *  sample rates is long enough that the loop period (~0.5 Hz) is
 *  imperceptible — noise is aperiodic by nature so the seam is silent. */
const BUFFER_SECONDS = 2;

export const noiseDef: AudioModuleDef = {
  type: 'noise',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'noise',
  category: 'sources',

  inputs: [],
  outputs: [
    { id: 'white', type: 'audio' },
    { id: 'pink',  type: 'audio' },
    { id: 'brown', type: 'audio' },
  ],
  params: [
    { id: 'level', label: 'Level', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  ],

  docs: {
    explanation:
      "A pure noise source with three independent spectral flavors: white (flat spectrum), pink (1/f, -3 dB/oct), and brown (1/f², -6 dB/oct). All three noise streams run continuously from a shared 2-second looping buffer and are gain-scaled by a single LEVEL knob. Mental model: patch any combination of the three outputs into different channels to layer different timbres—white for brightness, pink for warmth, brown for rumble—all controlled by one master gain. Since the buffer loop is long and aperiodic noise by nature, the 0.5 Hz loop seam is inaudible.",
    inputs: {},
    outputs: {
      white:
        "Full-spectrum white noise with flat frequency response; uniform random amplitude across all audible frequencies. One of three independent outputs sharing the LEVEL control.",
      pink: "1/f pink noise at -3 dB per octave slope; warmer than white noise with attenuated highs. Useful for smooth, natural-sounding textures. One of three independent outputs sharing the LEVEL control.",
      brown:
        "1/f² brown noise at -6 dB per octave slope; the darkest flavor with heavy low-frequency content. One of three independent outputs sharing the LEVEL control.",
    },
    controls: {
      level:
        "Master gain applied equally to all three noise outputs, from silence (0) to full amplitude (1). Default 0.5 provides moderate headroom; raise it to push the noise through downstream processing, lower it to blend subtly into a mix.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const sampleRate = ctx.sampleRate;
    const bufferLen = Math.floor(BUFFER_SECONDS * sampleRate);

    // Generate the three noise tables once, fill them, and wrap each in
    // a looping AudioBufferSourceNode. The .start() kicks the source into
    // playback; .stop() in dispose() ends it.
    //
    // copyToChannel's parameter is typed Float32Array<ArrayBuffer> in
    // recent TS lib.dom.d.ts; sample-by-sample copyToChannel via
    // getChannelData sidesteps the SharedArrayBuffer / ArrayBuffer
    // generic-arg mismatch.
    function makeBuffer(data: Float32Array): AudioBuffer {
      const buf = ctx.createBuffer(1, bufferLen, sampleRate);
      const channel = buf.getChannelData(0);
      for (let i = 0; i < bufferLen; i++) channel[i] = data[i] ?? 0;
      return buf;
    }

    const whiteBuf = makeBuffer(noiseGenerators.white(bufferLen));
    const pinkBuf  = makeBuffer(noiseGenerators.pink(bufferLen));
    const brownBuf = makeBuffer(noiseGenerators.brown(bufferLen));

    const whiteSrc = ctx.createBufferSource();
    whiteSrc.buffer = whiteBuf;
    whiteSrc.loop = true;

    const pinkSrc = ctx.createBufferSource();
    pinkSrc.buffer = pinkBuf;
    pinkSrc.loop = true;

    const brownSrc = ctx.createBufferSource();
    brownSrc.buffer = brownBuf;
    brownSrc.loop = true;

    // Per-output gain nodes, all driven by the same LEVEL value. We could
    // share one GainNode but keeping them per-output makes the disposal
    // story symmetrical (each src → its own gain → outputs map entry).
    const initialLevel = (node.params ?? {}).level ?? 0.5;
    const whiteGain = ctx.createGain();
    whiteGain.gain.value = initialLevel;
    const pinkGain = ctx.createGain();
    pinkGain.gain.value = initialLevel;
    const brownGain = ctx.createGain();
    brownGain.gain.value = initialLevel;

    whiteSrc.connect(whiteGain);
    pinkSrc.connect(pinkGain);
    brownSrc.connect(brownGain);

    whiteSrc.start();
    pinkSrc.start();
    brownSrc.start();

    return {
      domain: 'audio',
      // No inputs declared. Map is intentionally empty.
      inputs: new Map(),
      outputs: new Map([
        ['white', { node: whiteGain, output: 0 }],
        ['pink',  { node: pinkGain,  output: 0 }],
        ['brown', { node: brownGain, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'level') {
          whiteGain.gain.setValueAtTime(value, ctx.currentTime);
          pinkGain.gain.setValueAtTime(value, ctx.currentTime);
          brownGain.gain.setValueAtTime(value, ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'level') return whiteGain.gain.value;
        return undefined;
      },
      dispose() {
        try { whiteSrc.stop(); } catch { /* already stopped */ }
        try { pinkSrc.stop();  } catch { /* already stopped */ }
        try { brownSrc.stop(); } catch { /* already stopped */ }
        whiteSrc.disconnect();
        pinkSrc.disconnect();
        brownSrc.disconnect();
        whiteGain.disconnect();
        pinkGain.disconnect();
        brownGain.disconnect();
      },
    };
  },
};
