// packages/web/src/lib/audio/modules/moog903a.ts
//
// MOOG 903A RANDOM SIGNAL GENERATOR — a slice of the Moog System 55/35 clone
// initiative (.myrobots/MOOG/). The 903A is a passive noise SOURCE: it puts
// out full-spectrum WHITE noise and -3 dB/oct PINK noise on two independent
// outputs (the hardware spans ~25 Hz–20 kHz), both gain-scaled by a single
// LEVEL knob.
//
// PURE Web Audio: no AudioWorklet, no Faust DSP. Following the NOISE module's
// buffer-loop factory pattern (noise.ts), we pre-generate a ~2 s AudioBuffer
// per flavor (via the shared noiseGenerators) and loop each through an
// AudioBufferSourceNode → a per-output GainNode. This is far cheaper than a
// per-sample worklet callback — just looping buffer playback. The loop seam is
// inaudible because noise is aperiodic and the loop period (~0.5 Hz at 2 s) is
// far below any pitched perception.
//
// SOURCE-ONLY: NO inputs. Two outputs (white, pink), no CV.
//
// Inputs: none.
//
// Outputs:
//   white (audio): full-spectrum white noise.
//   pink  (audio): 1/f pink noise (-3 dB/oct).
//
// Params:
//   level (linear 0..1, default 0.8): master gain applied to BOTH taps.
//
// Categorized under Ports → moogafakkin (the shared SYS55/SYS35 bucket, mirroring the
// CP3 / 921A / 992). Category 'sources' because it generates signal.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { noiseGenerators } from '$lib/audio/modules/noise';

/** Buffer length for the loopable noise tables. ~2 seconds — long enough that
 *  the loop period (~0.5 Hz) is imperceptible (noise is aperiodic, so the seam
 *  is silent). Mirrors NOISE's BUFFER_SECONDS. */
const BUFFER_SECONDS = 2;

export const moog903aDef: AudioModuleDef = {
  type: 'moog903a',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog903aCard',
  domain: 'audio',
  label: '903a random signal generator',
  category: 'sources',
  schemaVersion: 1,

  inputs: [],
  outputs: [
    // Two independent noise taps. No CV.
    { id: 'white', type: 'audio' },
    { id: 'pink',  type: 'audio' },
  ],
  params: [
    { id: 'level', label: 'Level', defaultValue: 0.8, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const sampleRate = ctx.sampleRate;
    const bufferLen = Math.floor(BUFFER_SECONDS * sampleRate);

    // Generate the two noise tables once, fill them, and wrap each in a
    // looping AudioBufferSourceNode. The .start() kicks playback; .stop() in
    // dispose() ends it. We copy sample-by-sample via getChannelData to
    // sidestep the copyToChannel SharedArrayBuffer/ArrayBuffer generic-arg
    // mismatch (same as noise.ts).
    function makeBuffer(data: Float32Array): AudioBuffer {
      const buf = ctx.createBuffer(1, bufferLen, sampleRate);
      const channel = buf.getChannelData(0);
      for (let i = 0; i < bufferLen; i++) channel[i] = data[i] ?? 0;
      return buf;
    }

    const whiteBuf = makeBuffer(noiseGenerators.white(bufferLen));
    const pinkBuf  = makeBuffer(noiseGenerators.pink(bufferLen));

    const whiteSrc = ctx.createBufferSource();
    whiteSrc.buffer = whiteBuf;
    whiteSrc.loop = true;

    const pinkSrc = ctx.createBufferSource();
    pinkSrc.buffer = pinkBuf;
    pinkSrc.loop = true;

    // Per-output gain nodes, both driven by the same LEVEL value. Keeping them
    // per-output makes disposal symmetrical (each src → its own gain → outputs
    // map entry).
    const initialLevel =
      (node.params ?? {}).level ?? moog903aDef.params.find((p) => p.id === 'level')!.defaultValue;
    const whiteGain = ctx.createGain();
    whiteGain.gain.value = initialLevel;
    const pinkGain = ctx.createGain();
    pinkGain.gain.value = initialLevel;

    whiteSrc.connect(whiteGain);
    pinkSrc.connect(pinkGain);

    whiteSrc.start();
    pinkSrc.start();

    return {
      domain: 'audio',
      // No inputs declared. Map is intentionally empty.
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>(),
      outputs: new Map([
        ['white', { node: whiteGain, output: 0 }],
        ['pink',  { node: pinkGain,  output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'level') {
          // LEVEL drives BOTH taps.
          whiteGain.gain.setValueAtTime(value, ctx.currentTime);
          pinkGain.gain.setValueAtTime(value, ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'level') return whiteGain.gain.value;
        return undefined;
      },
      dispose() {
        try { whiteSrc.stop(); } catch { /* already stopped */ }
        try { pinkSrc.stop();  } catch { /* already stopped */ }
        try { whiteSrc.disconnect(); } catch { /* */ }
        try { pinkSrc.disconnect();  } catch { /* */ }
        try { whiteGain.disconnect(); } catch { /* */ }
        try { pinkGain.disconnect();  } catch { /* */ }
      },
    };
  },
};
