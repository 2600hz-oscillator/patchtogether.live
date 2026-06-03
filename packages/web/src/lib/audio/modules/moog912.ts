// packages/web/src/lib/audio/modules/moog912.ts
//
// MOOG 912 ENVELOPE FOLLOWER — a slice of the Moog System 55 / 35 clone
// initiative (.myrobots/MOOG/). The 912 is a passive ANALYSIS utility: it
// watches an incoming AUDIO signal's amplitude and turns it into a smooth
// control voltage (an "envelope") plus a GATE that goes high while the input
// is sounding. Patch a drum or vocal in and use the env to open a VCF/VCA, or
// the gate to fire an envelope generator from a live source.
//
// PASSIVE / PURE Web Audio — NO AudioWorklet, NO Faust DSP. The whole module
// is a tiny node graph:
//
//   audio in
//     → GainNode (SENSITIVITY: input gain into the follower)
//     → WaveShaperNode (full-wave rectifier, |x|)
//     → BiquadFilterNode('lowpass', cutoff from SMOOTHING) ── env out
//                                                          └→ WaveShaperNode
//                                                             (hard threshold,
//                                                              1 if >~0.1 else 0)
//                                                              ── gate out
//
// The rectifier WaveShaper maps x → |x| (turn the bipolar AC waveform into a
// unipolar magnitude); the lowpass smooths that magnitude into a slow envelope
// — more SMOOTHING = lower cutoff = slower, lazier envelope. The gate
// WaveShaper is a steep step on the env: ~0 below the threshold, ~1 above, so
// `gate` is a clean on/off control while the input plays.
//
// CV semantics: the single input is plain AUDIO being analysed (PASSTHROUGH —
// it's the signal under measurement, not a knob modulator, so no cvScale /
// paramTarget). The two outputs are CV-domain control signals (env = cv,
// gate = gate), NOT audio.
//
// Inputs:
//   audio (audio): the signal to follow.
//
// Outputs:
//   env  (cv):   the smoothed amplitude envelope (rectified + lowpassed).
//   gate (gate): high (~1) while the envelope is above the gate threshold,
//                low (~0) otherwise.
//
// Params:
//   sensitivity (linear 0..1, default 0.7): input gain into the follower
//     (how hard the signal hits the rectifier — louder => bigger env).
//   smoothing (linear 0..1, default 0.5): maps to the envelope lowpass cutoff
//     (1 Hz at 1.0 .. 50 Hz at 0.0). MORE smoothing = LOWER cutoff = SLOWER
//     env. (See SMOOTH_MIN_HZ / SMOOTH_MAX_HZ below.)
//
// Categorized under Clones → moogafakkin (the shared SYS55/SYS35 bucket, mirroring the
// CP3 / 921A / 992). Category 'modulation' because it produces CV/gate control.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

// SMOOTHING → lowpass cutoff (Hz). smoothing=1.0 (max smoothing) → the SLOWEST
// envelope (lowest cutoff); smoothing=0.0 (no smoothing) → the FASTEST (highest
// cutoff). Log-interpolated so the knob feels even across its range.
export const SMOOTH_MIN_HZ = 1; // most smoothing (smoothing = 1.0)
export const SMOOTH_MAX_HZ = 50; // least smoothing (smoothing = 0.0)

/** Map the 0..1 SMOOTHING knob to a lowpass cutoff in Hz (log scale).
 *  smoothing=1 → SMOOTH_MIN_HZ (slow); smoothing=0 → SMOOTH_MAX_HZ (fast). */
export function smoothingToCutoffHz(smoothing: number): number {
  const s = smoothing < 0 ? 0 : smoothing > 1 ? 1 : smoothing;
  // t=0 at smoothing=1 (min Hz), t=1 at smoothing=0 (max Hz).
  const t = 1 - s;
  const lnMin = Math.log(SMOOTH_MIN_HZ);
  const lnMax = Math.log(SMOOTH_MAX_HZ);
  return Math.exp(lnMin + (lnMax - lnMin) * t);
}

// Gate fires once the smoothed envelope rises above this level.
export const GATE_THRESHOLD = 0.1;

/** Full-wave rectifier curve: x → |x|. A WaveShaper maps its input domain
 *  [-1, 1] (sampled across `len` points) through this; |x| folds the negative
 *  half up, turning the bipolar waveform into a unipolar magnitude.
 *  Returned as `Float32Array<ArrayBuffer>` (the type `WaveShaperNode.curve`
 *  requires — the default `new Float32Array(len)` is `ArrayBufferLike`). */
export function buildRectifyCurve(len = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(len * 4));
  for (let i = 0; i < len; i++) {
    // Map sample index → input value in [-1, 1].
    const x = (i / (len - 1)) * 2 - 1;
    curve[i] = Math.abs(x);
  }
  return curve;
}

/** Hard-threshold gate curve: ~0 below `threshold`, ~1 at/above. The env is
 *  unipolar (0..~1), so we only need the upper half of the [-1,1] domain to be
 *  meaningful; negative inputs (never produced by the rectified env) map to 0.
 *  Returned as `Float32Array<ArrayBuffer>` for `WaveShaperNode.curve` (see
 *  buildRectifyCurve). */
export function buildGateCurve(threshold = GATE_THRESHOLD, len = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(len * 4));
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1;
    curve[i] = x >= threshold ? 1 : 0;
  }
  return curve;
}

export const moog912Def: AudioModuleDef = {
  type: 'moog912',
  palette: { top: 'Clones', sub: 'moogafakkin' },
  card: 'Moog912Card',
  domain: 'audio',
  label: '912 Envelope Follower',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // The signal being analysed. Plain audio passthrough into the input gain;
    // PASSTHROUGH (it's the measured signal, not a knob modulator) → no
    // cvScale / paramTarget.
    { id: 'audio', type: 'audio' },
  ],
  outputs: [
    // The smoothed amplitude envelope (CV) + a gate while above threshold.
    { id: 'env', type: 'cv' },
    { id: 'gate', type: 'gate' },
  ],
  params: [
    { id: 'sensitivity', label: 'Sens',   defaultValue: 0.7, min: 0, max: 1, curve: 'linear' },
    { id: 'smoothing',   label: 'Smooth', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initial = node.params ?? {};
    const valueOf = (id: string): number =>
      initial[id] ?? moog912Def.params.find((p) => p.id === id)!.defaultValue;

    const sensitivity = valueOf('sensitivity');
    const smoothing = valueOf('smoothing');

    // SENSITIVITY → input gain into the follower.
    const inputGain = ctx.createGain();
    inputGain.gain.value = sensitivity;

    // Full-wave rectifier: x → |x| (bipolar AC → unipolar magnitude).
    const rectifier = ctx.createWaveShaper();
    rectifier.curve = buildRectifyCurve();
    rectifier.oversample = '2x';

    // SMOOTHING → lowpass cutoff. The smoothed rectified magnitude IS the env.
    const envFilter = ctx.createBiquadFilter();
    envFilter.type = 'lowpass';
    envFilter.frequency.value = smoothingToCutoffHz(smoothing);
    // Gentle Q so the envelope settles without ringing/overshoot.
    envFilter.Q.value = 0.5;

    // Gate: a steep step on the env (~1 above threshold, ~0 below).
    const gateShaper = ctx.createWaveShaper();
    gateShaper.curve = buildGateCurve();
    gateShaper.oversample = 'none';

    // audio → inputGain → rectifier → envFilter (= env out) → gateShaper (= gate out)
    inputGain.connect(rectifier);
    rectifier.connect(envFilter);
    envFilter.connect(gateShaper);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio', { node: inputGain, input: 0 }],
      ]),
      outputs: new Map([
        ['env', { node: envFilter, output: 0 }],
        ['gate', { node: gateShaper, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'sensitivity') {
          inputGain.gain.setValueAtTime(value, ctx.currentTime);
        } else if (paramId === 'smoothing') {
          envFilter.frequency.setValueAtTime(smoothingToCutoffHz(value), ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'sensitivity') return inputGain.gain.value;
        // Read the smoothing knob position back from the live cutoff (invert
        // the log map) so the UI fader tracks the running node.
        if (paramId === 'smoothing') {
          const hz = envFilter.frequency.value;
          const lnMin = Math.log(SMOOTH_MIN_HZ);
          const lnMax = Math.log(SMOOTH_MAX_HZ);
          const t = (Math.log(hz) - lnMin) / (lnMax - lnMin);
          const s = 1 - t;
          return s < 0 ? 0 : s > 1 ? 1 : s;
        }
        return undefined;
      },
      dispose() {
        try { inputGain.disconnect(); } catch { /* */ }
        try { rectifier.disconnect(); } catch { /* */ }
        try { envFilter.disconnect(); } catch { /* */ }
        try { gateShaper.disconnect(); } catch { /* */ }
      },
    };
  },
};
