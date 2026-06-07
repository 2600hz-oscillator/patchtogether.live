// packages/web/src/lib/audio/modules/moog923.ts
//
// MOOG 923 FILTERS / NOISE SOURCE — a slice of the Moog System 35 clone
// (.myrobots/MOOG/). The 923 is a dual-purpose utility panel:
//
//   1. NOISE SOURCE — the same white + pink noise generators the 903A
//      ships, on two independent outputs, gain-scaled by a single LEVEL
//      knob. Implemented (like NOISE / 903A) by pre-generating a 2-second
//      loopable AudioBuffer per flavor via noiseGenerators and looping it
//      through an AudioBufferSourceNode → GainNode. NO worklet — a looping
//      buffer is far cheaper than a per-sample JS callback.
//
//   2. FIXED FILTER section — a low-pass + a high-pass filter operating on
//      one external AUDIO input. The input fans out (one GainNode) into two
//      BiquadFilterNodes ('lowpass' / 'highpass'); each filter is a
//      separate output (lp / hp). Pure Web Audio (BiquadFilterNode), no
//      worklet — the 904C is the only Moog filter that needs the custom
//      ladder worklet.
//
// PURE Web Audio: noise buffer-loop factory + a small Biquad graph. No
// AudioWorklet, no Faust DSP.
//
// Inputs:
//   audio (audio): the external signal fed into the LP + HP filter section.
//     PASSTHROUGH (the signal being filtered, not a knob modulator) → no
//     cvScale / paramTarget.
//
// Outputs:
//   white (audio): full-spectrum white noise (LEVEL-scaled).
//   pink  (audio): 1/f pink noise, -3 dB/oct (LEVEL-scaled).
//   lp    (audio): the audio input low-passed at lpCutoff.
//   hp    (audio): the audio input high-passed at hpCutoff.
//
// Params:
//   level    (linear 0..1, default 0.8): master gain on both noise taps.
//   lpCutoff (linear 0..1, default 0.5): low-pass corner; the 0..1 knob is
//     mapped LOG to ~40 Hz .. 20 kHz inside the factory.
//   hpCutoff (linear 0..1, default 0.5): high-pass corner; same log map.
//
// Categorized under Ports → moogafakkin (mirroring the CP3 / 921A SYS55 bucket).
// Category 'filter' because the headline feature is the LP/HP filter pair.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { noiseGenerators } from '$lib/audio/modules/noise';

/** Buffer length for the loopable noise tables — 2 s, same as NOISE/903A.
 *  The loop period (~0.5 Hz) is imperceptible; noise is aperiodic so the
 *  seam is silent. */
const BUFFER_SECONDS = 2;

/** Log map a normalized 0..1 cutoff knob onto the audible filter range
 *  ~40 Hz .. 20 kHz. Exposed for the unit test so the mapping is pinned. */
export const CUTOFF_MIN_HZ = 40;
export const CUTOFF_MAX_HZ = 20000;
export function cutoffToHz(norm: number): number {
  const t = Math.min(1, Math.max(0, norm));
  // Exponential interpolation between min and max in log space.
  return CUTOFF_MIN_HZ * Math.pow(CUTOFF_MAX_HZ / CUTOFF_MIN_HZ, t);
}

export const moog923Def: AudioModuleDef = {
  type: 'moog923',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog923Card',
  domain: 'audio',
  label: '923 filters / noise source',
  category: 'filter',
  schemaVersion: 1,

  inputs: [
    // The external signal fed through the LP + HP filter section.
    // PASSTHROUGH (the audio being filtered, not a knob modulator).
    { id: 'audio', type: 'audio' },
  ],
  outputs: [
    { id: 'white', type: 'audio' },
    { id: 'pink',  type: 'audio' },
    { id: 'lp',    type: 'audio' },
    { id: 'hp',    type: 'audio' },
  ],
  params: [
    { id: 'level',    label: 'Level',   defaultValue: 0.8, min: 0, max: 1, curve: 'linear' },
    { id: 'lpCutoff', label: 'Lo Pass', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'hpCutoff', label: 'Hi Pass', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initial = node.params ?? {};
    const paramOf = (id: string): number =>
      initial[id] ?? moog923Def.params.find((p) => p.id === id)!.defaultValue;

    // ---- Noise section (white + pink, looping buffers) ----
    const sampleRate = ctx.sampleRate;
    const bufferLen = Math.floor(BUFFER_SECONDS * sampleRate);

    function makeBuffer(data: Float32Array): AudioBuffer {
      const buf = ctx.createBuffer(1, bufferLen, sampleRate);
      const channel = buf.getChannelData(0);
      for (let i = 0; i < bufferLen; i++) channel[i] = data[i] ?? 0;
      return buf;
    }

    const whiteSrc = ctx.createBufferSource();
    whiteSrc.buffer = makeBuffer(noiseGenerators.white(bufferLen));
    whiteSrc.loop = true;

    const pinkSrc = ctx.createBufferSource();
    pinkSrc.buffer = makeBuffer(noiseGenerators.pink(bufferLen));
    pinkSrc.loop = true;

    // One LEVEL-scaled gain per noise tap (symmetrical disposal story, same
    // as NOISE/903A). Both driven by the single LEVEL value.
    const level = paramOf('level');
    const whiteGain = ctx.createGain();
    whiteGain.gain.value = level;
    const pinkGain = ctx.createGain();
    pinkGain.gain.value = level;

    whiteSrc.connect(whiteGain);
    pinkSrc.connect(pinkGain);
    whiteSrc.start();
    pinkSrc.start();

    // ---- Filter section (external audio → LP + HP) ----
    // The audio input fans out through one GainNode into both biquads, so a
    // single inputs-map entry feeds both filters.
    const fan = ctx.createGain();
    fan.gain.value = 1;

    const lpFilter = ctx.createBiquadFilter();
    lpFilter.type = 'lowpass';
    lpFilter.frequency.value = cutoffToHz(paramOf('lpCutoff'));

    const hpFilter = ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.value = cutoffToHz(paramOf('hpCutoff'));

    fan.connect(lpFilter);
    fan.connect(hpFilter);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        // Single audio input → the fan node feeding both filters.
        ['audio', { node: fan, input: 0 }],
      ]),
      outputs: new Map([
        ['white', { node: whiteGain, output: 0 }],
        ['pink',  { node: pinkGain,  output: 0 }],
        ['lp',    { node: lpFilter,  output: 0 }],
        ['hp',    { node: hpFilter,  output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'level') {
          whiteGain.gain.setValueAtTime(value, ctx.currentTime);
          pinkGain.gain.setValueAtTime(value, ctx.currentTime);
        } else if (paramId === 'lpCutoff') {
          lpFilter.frequency.setValueAtTime(cutoffToHz(value), ctx.currentTime);
        } else if (paramId === 'hpCutoff') {
          hpFilter.frequency.setValueAtTime(cutoffToHz(value), ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'level') return whiteGain.gain.value;
        // Invert the log map so the knob tracks the live biquad frequency.
        if (paramId === 'lpCutoff') return hzToCutoff(lpFilter.frequency.value);
        if (paramId === 'hpCutoff') return hzToCutoff(hpFilter.frequency.value);
        return undefined;
      },
      dispose() {
        try { whiteSrc.stop(); } catch { /* already stopped */ }
        try { pinkSrc.stop();  } catch { /* already stopped */ }
        try { whiteSrc.disconnect(); } catch { /* */ }
        try { pinkSrc.disconnect();  } catch { /* */ }
        try { whiteGain.disconnect(); } catch { /* */ }
        try { pinkGain.disconnect();  } catch { /* */ }
        try { fan.disconnect();       } catch { /* */ }
        try { lpFilter.disconnect();  } catch { /* */ }
        try { hpFilter.disconnect();  } catch { /* */ }
      },
    };
  },
};

/** Inverse of cutoffToHz — recover the normalized 0..1 knob value from a
 *  biquad frequency. Used by readParam so the UI knob tracks the live DSP. */
function hzToCutoff(hz: number): number {
  const clamped = Math.min(CUTOFF_MAX_HZ, Math.max(CUTOFF_MIN_HZ, hz));
  return Math.log(clamped / CUTOFF_MIN_HZ) / Math.log(CUTOFF_MAX_HZ / CUTOFF_MIN_HZ);
}
