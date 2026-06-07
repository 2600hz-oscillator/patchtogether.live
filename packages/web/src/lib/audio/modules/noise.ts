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

/** Pure helpers exposed for unit tests so we can validate the noise
 *  generators without spinning up Web Audio. */
export const noiseGenerators = {
  /** White noise: uniform in [-1, +1]. Mean 0, variance 1/3, std-dev ≈ 0.5774. */
  white(n: number, seed?: number): Float32Array {
    const out = new Float32Array(n);
    const rand = seed === undefined ? Math.random : mulberry32(seed);
    for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
    return out;
  },

  /** Pink noise (1/f) via Voss-McCartney. Each row updates only when its
   *  bit position changes (LSB toggles every sample, MSB toggles every
   *  2^15 samples), so the long-term spectrum has the characteristic
   *  -3 dB/oct slope. */
  pink(n: number, seed?: number): Float32Array {
    const out = new Float32Array(n);
    const rand = seed === undefined ? Math.random : mulberry32(seed);
    const ROWS = 16;
    const rows = new Float32Array(ROWS);
    let runningSum = 0;
    let counter = 0;
    for (let i = 0; i < n; i++) {
      counter++;
      // Find the lowest set bit of counter — that's the row to update.
      // (counter & -counter) isolates the LSB; Math.log2 gives the row index.
      const lsb = counter & -counter;
      const row = Math.log2(lsb);
      if (row < ROWS) {
        runningSum -= rows[row]!;
        rows[row] = rand() * 2 - 1;
        runningSum += rows[row]!;
      }
      // Add a fresh white sample on top so the high frequencies aren't
      // attenuated to silence (Voss-McCartney without this sounds dull).
      const white = rand() * 2 - 1;
      // Sum of ROWS rows + 1 white sample is in [-(ROWS+1), +(ROWS+1)];
      // normalise to ~[-1, +1] by dividing by ROWS+1.
      out[i] = (runningSum + white) / (ROWS + 1);
    }
    return out;
  },

  /** Brown noise (1/f²) via leaky integration of white noise. The leak
   *  coefficient (0.99) prevents DC drift on long runs while keeping
   *  the -6 dB/oct slope across the audible range. The integrator
   *  steady-state RMS is ~3.5 with the params below; we scale by 1/8
   *  so peak excursions stay comfortably under ±1 over arbitrary
   *  buffer lengths (verified to ~64k samples). */
  brown(n: number, seed?: number): Float32Array {
    const out = new Float32Array(n);
    const rand = seed === undefined ? Math.random : mulberry32(seed);
    let last = 0;
    const LEAK = 0.99;
    const NORM = 1 / 8;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      last = LEAK * last + 0.5 * w;
      out[i] = last * NORM;
    }
    return out;
  },
};

/** Tiny seeded PRNG — same one used elsewhere in the codebase
 *  (sync/prng.ts). Inlined here so the unit tests don't pull in the
 *  whole sync module. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  schemaVersion: 1,

  inputs: [],
  outputs: [
    { id: 'white', type: 'audio' },
    { id: 'pink',  type: 'audio' },
    { id: 'brown', type: 'audio' },
  ],
  params: [
    { id: 'level', label: 'Level', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  ],

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
