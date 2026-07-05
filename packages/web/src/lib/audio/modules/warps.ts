// packages/web/src/lib/audio/modules/warps.ts
//
// WARPS — Mutable Instruments Warps meta-modulator / signal masher.
// Clean-room TypeScript port. Original C++ Copyright 2014 Emilie Gillet,
// MIT-licensed (https://github.com/pichenettes/eurorack/tree/master/warps).
// Pure-math mirror lives in this file; the actual audio path runs in the
// worklet at packages/dsp/src/warps.ts. Keep the two implementations
// numerically identical — drift here means the unit tests + ART scenarios
// diverge from the audible output.
//
// v1 algorithm slice (mandatory): XFADE / RING-MOD / XOR / COMPARATOR.
// Stretch (deferred): FOLD, ANALOG-RING, FREQUENCY-SHIFTER, DOPPLER,
// VOCODER — see PR body for the deferral note.
//
// Inputs:
//   carrier_in (audio): external carrier audio (replaces the internal oscillator when patched).
//   modulator_in (audio): modulator audio.
//   pitch (pitch): V/oct for the internal carrier (sums with note).
//   algorithm_cv (cv, discrete, paramTarget=algorithm): displaces the algorithm selector.
//   carrier_shape_cv (cv, linear, paramTarget=carrier_shape): displaces internal-carrier shape morph.
//   timbre_cv (cv, linear, paramTarget=timbre): displaces TIMBRE.
//   level_1_cv (cv, linear, paramTarget=level_1): displaces carrier amount.
//   level_2_cv (cv, linear, paramTarget=level_2): displaces modulator amount.
//
// Outputs:
//   out (audio): the meta-modulated mix.
//
// Params:
//   algorithm (discrete 0..WARPS_MAX_ALGORITHM, default 0): meta-modulator algorithm.
//   carrier_shape (linear 0..1, default 0): internal carrier waveform morph.
//   timbre (linear 0..1, default 0.5): algorithm-specific modulation depth macro.
//   level_1 (linear 0..1, default 1.0): carrier signal level.
//   level_2 (linear 0..1, default 1.0): modulator signal level.
//   note (linear -60..60 st, default 0): internal carrier pitch offset.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/warps.js?url';

const PROCESSOR_NAME = 'warps';
const loadedContexts = new WeakSet<BaseAudioContext>();

// ----------------------------------------------------------------------------
// Pure-math mirror — see worklet for line-by-line counterpart.
// ----------------------------------------------------------------------------

function _softLimit(x: number): number {
  return x / (1 + Math.abs(x));
}

class _InternalOsc {
  phase = 0;
  tick(freq: number, shape: number, sr: number): number {
    const dt = freq / sr;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    const t = this.phase;
    const s = Math.max(0, Math.min(1, shape));
    if (s < 0.25) return Math.sin(2 * Math.PI * t);
    if (s < 0.5)  return 1 - 4 * Math.abs(t - 0.5);
    if (s < 0.75) return 2 * t - 1;
    return t < 0.5 ? 1 : -1;
  }
  reset(): void { this.phase = 0; }
}

export function warpsXfade(carrier: number, modulator: number, parameter: number): number {
  const p = Math.max(0, Math.min(1, parameter));
  const g1 = Math.cos(p * Math.PI * 0.5);
  const g2 = Math.sin(p * Math.PI * 0.5);
  return carrier * g1 + modulator * g2;
}

export function warpsRingMod(x1: number, x2: number, parameter: number): number {
  const ring = 4 * x1 * x2 * (1 + parameter * 8);
  return ring / (1 + Math.abs(ring));
}

export function warpsXor(x1: number, x2: number, parameter: number): number {
  const x1s = Math.max(-32768, Math.min(32767, Math.round(x1 * 32768))) | 0;
  const x2s = Math.max(-32768, Math.min(32767, Math.round(x2 * 32768))) | 0;
  const mod = (x1s ^ x2s) / 32768;
  const sum = (x1 + x2) * 0.7;
  return sum + (mod - sum) * parameter;
}

export function warpsComparator(modulator: number, carrier: number, parameter: number): number {
  const x = Math.max(0, Math.min(2.995, parameter * 2.995));
  const xInt = Math.floor(x);
  const xFrac = x - xInt;
  const direct = modulator < carrier ? modulator : carrier;
  const window = Math.abs(modulator) > Math.abs(carrier) ? modulator : carrier;
  const window2 = Math.abs(modulator) > Math.abs(carrier)
    ? Math.abs(modulator) : -Math.abs(carrier);
  const threshold = carrier > 0.05 ? carrier : modulator;
  const sequence = [direct, threshold, window, window2];
  const a = sequence[xInt]!;
  const b = sequence[xInt + 1] ?? sequence[xInt]!;
  return a + (b - a) * xFrac;
}

export function warpsApplyAlgorithm(
  algorithm: number,
  carrier: number,
  modulator: number,
  parameter: number,
): number {
  const idx = Math.max(0, Math.min(WARPS_MAX_ALGORITHM, Math.round(algorithm)));
  switch (idx) {
    case 0: return warpsXfade(carrier, modulator, parameter);
    case 1: return warpsRingMod(carrier, modulator, parameter);
    case 2: return warpsXor(carrier, modulator, parameter);
    case 3: return warpsComparator(modulator, carrier, parameter);
    default: return warpsXfade(carrier, modulator, parameter);
  }
}

/** Highest legal algorithm index. Bump when more Xmod algorithms land. */
export const WARPS_MAX_ALGORITHM = 3;

export const WARPS_ALGORITHM_NAMES = ['XFADE', 'RING-MOD', 'XOR', 'COMPARE'] as const;

export interface WarpsParams {
  algorithm: number;
  carrier_shape: number;
  timbre: number;
  level_1: number;
  level_2: number;
  note: number;
}

/** Pure-math render — called from unit tests + ART. The worklet at
 *  packages/dsp/src/warps.ts implements the same loop. */
export const warpsMath = {
  xfade: warpsXfade,
  ringMod: warpsRingMod,
  xor: warpsXor,
  comparator: warpsComparator,
  applyAlgorithm: warpsApplyAlgorithm,
  internalOsc(sr: number): _InternalOsc { return new _InternalOsc(); },

  /** Render n samples at constant params. `carrierIn` and `modulatorIn`
   *  may be null to leave them unpatched (internal carrier osc takes over;
   *  modulator goes to zero). pitchV is V/oct, summed with params.note. */
  render(
    n: number,
    sr: number,
    pitchV: number,
    params: WarpsParams,
    carrierIn: Float32Array | null,
    modulatorIn: Float32Array | null,
  ): Float32Array {
    const out = new Float32Array(n);
    const osc = new _InternalOsc();
    const semis = pitchV * 12 + params.note;
    let freq = 261.6256 * Math.pow(2, semis / 12);
    if (freq < 1) freq = 1; else if (freq > 20000) freq = 20000;
    for (let i = 0; i < n; i++) {
      const internal = osc.tick(freq, params.carrier_shape, sr);
      const carrier = carrierIn ? (carrierIn[i] ?? 0) : internal;
      const modulator = modulatorIn ? (modulatorIn[i] ?? 0) : 0;
      const cScaled = carrier * params.level_1;
      const mScaled = modulator * params.level_2;
      const y = warpsApplyAlgorithm(params.algorithm, cScaled, mScaled, params.timbre);
      out[i] = _softLimit(y);
    }
    return out;
  },
};

export const warpsDef: AudioModuleDef = {
  type: 'warps',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'warps',
  category: 'effects',
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'carrier_in',      type: 'audio' },
    { id: 'modulator_in',    type: 'audio' },
    { id: 'pitch',           type: 'pitch' },
    { id: 'algorithm_cv',    type: 'cv', paramTarget: 'algorithm',     cvScale: { mode: 'discrete' } },
    { id: 'carrier_shape_cv', type: 'cv', paramTarget: 'carrier_shape', cvScale: { mode: 'linear' } },
    { id: 'timbre_cv',       type: 'cv', paramTarget: 'timbre',        cvScale: { mode: 'linear' } },
    { id: 'level_1_cv',      type: 'cv', paramTarget: 'level_1',       cvScale: { mode: 'linear' } },
    { id: 'level_2_cv',      type: 'cv', paramTarget: 'level_2',       cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'audio' },
  ],
  params: [
    { id: 'algorithm',     label: 'Algorithm', defaultValue: 0,   min: 0,   max: WARPS_MAX_ALGORITHM, curve: 'discrete' },
    { id: 'carrier_shape', label: 'Shape',     defaultValue: 0,   min: 0,   max: 1,                   curve: 'linear' },
    { id: 'timbre',        label: 'Timbre',    defaultValue: 0.5, min: 0,   max: 1,                   curve: 'linear' },
    { id: 'level_1',       label: 'Level 1',   defaultValue: 1.0, min: 0,   max: 1,                   curve: 'linear' },
    { id: 'level_2',       label: 'Level 2',   defaultValue: 1.0, min: 0,   max: 1,                   curve: 'linear' },
    { id: 'note',          label: 'Note',      defaultValue: 0,   min: -60, max: 60,                  curve: 'linear', units: 'st' },
  ],

  docs: {
    explanation:
      "A meta-modulator after Mutable Instruments' Warps: it cross-modulates two audio signals — a CARRIER and a MODULATOR — through a chosen modulation algorithm. ALGORITHM picks the cross-mod type (XFADE = equal-power crossfade between the two; RING-MOD = ring modulation for metallic/bell tones; XOR = a 16-bit bit-mash for digital grit; COMPARATOR = waveshaping comparison modes), TIMBRE sets that algorithm's intensity/mix, and LEVEL 1 / LEVEL 2 set the carrier and modulator input gains. When nothing is patched into CARRIER IN, an internal oscillator takes over — SHAPE morphs its waveform, NOTE offsets its pitch, and the V/OCT input plays it — so WARPS doubles as a playable cross-mod synth voice, not just an effect on two external sources.",
    inputs: {
      carrier_in: "External carrier audio. When patched it is the carrier the algorithm modulates; when left unpatched the internal oscillator (set by SHAPE / NOTE / V/OCT) takes its place so WARPS becomes a self-contained voice.",
      modulator_in: 'External modulator audio — the second operand of the cross-modulation. Unpatched, the modulator side is silent (so e.g. RING-MOD with no modulator passes the carrier through).',
      pitch: 'V/oct pitch input for the internal carrier oscillator. Summed with the NOTE offset; only audible when CARRIER IN is unpatched (the internal osc is in use).',
      algorithm_cv: 'CV (discrete) that displaces the ALGORITHM selector, switching the cross-mod type live — step it with a sequencer to jump between XFADE / RING-MOD / XOR / COMPARATOR.',
      carrier_shape_cv: 'CV that displaces the SHAPE knob, morphing the internal carrier waveform.',
      timbre_cv: 'CV that displaces the TIMBRE knob, modulating the active algorithm\'s intensity — the main "wiggle this" input for evolving cross-mod textures.',
      level_1_cv: 'CV that displaces the LEVEL 1 knob, modulating carrier input gain (and the crossfade weight in XFADE mode).',
      level_2_cv: 'CV that displaces the LEVEL 2 knob, modulating modulator input gain.',
    },
    outputs: {
      out: 'The mono cross-modulated result of the carrier and modulator through the selected algorithm at the chosen TIMBRE intensity.',
    },
    controls: {
      algorithm: 'Cross-modulation algorithm selector (discrete): 0 = XFADE (equal-power crossfade between carrier and modulator), 1 = RING-MOD (ring modulation — metallic, inharmonic tones), 2 = XOR (16-bit bitwise XOR mash — harsh digital grit), 3 = COMPARATOR (waveshaping comparison sub-modes). The card shows the current name.',
      carrier_shape: 'Internal-carrier waveform morph (0..1): sweeps the built-in oscillator\'s timbre (only in play when CARRIER IN is unpatched).',
      timbre: "The active algorithm's intensity / mix (0..1): in XFADE it's the carrier↔modulator balance; in RING-MOD/XOR/COMPARATOR it scales how aggressively the modulation is applied. The primary expressive control.",
      level_1: 'Carrier input gain (0..1) — and, in XFADE mode, its crossfade weight. Turn down to attenuate the carrier going into the cross-mod.',
      level_2: 'Modulator input gain (0..1): how hot the modulator drives the cross-modulation.',
      note: 'Internal-carrier pitch offset in semitones (-60..+60). Sums with the V/OCT input to set the internal oscillator\'s frequency (used when CARRIER IN is unpatched).',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of warpsDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['carrier_in',       { node: worklet, input: 0 }],
        ['modulator_in',     { node: worklet, input: 1 }],
        ['pitch',            { node: worklet, input: 2 }],
        ['algorithm_cv',     { node: worklet, input: 0, param: params.get('algorithm')! }],
        ['carrier_shape_cv', { node: worklet, input: 0, param: params.get('carrier_shape')! }],
        ['timbre_cv',        { node: worklet, input: 0, param: params.get('timbre')! }],
        ['level_1_cv',       { node: worklet, input: 0, param: params.get('level_1')! }],
        ['level_2_cv',       { node: worklet, input: 0, param: params.get('level_2')! }],
      ]),
      outputs: new Map([
        ['out', { node: worklet, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
