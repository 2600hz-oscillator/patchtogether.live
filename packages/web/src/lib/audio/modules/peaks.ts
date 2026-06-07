// packages/web/src/lib/audio/modules/peaks.ts
//
// PEAKS — dual-channel multi-mode utility (Mutable Instruments Peaks
// archetype, Émilie Gillet, 2013, MIT-licensed). Audio-domain module +
// pure-math mirror of the worklet engines. Worklet at
// packages/dsp/src/peaks.ts.
//
// v1 ships five per-channel modes: KICK, SNARE, HIHAT, ENV (attack-decay),
// LFO (sine/tri/square with phase-reset on gate). Stretch (multistage
// envelope, tap-LFO, BPF mode) deferred — the worklet's `mode` parameter
// reserves headroom past 4 for the follow-up.
//
// I/O surface (duplicated for ch0 + ch1):
//   gate[ch]    audio-rate trigger
//   k1_cv[ch]   CV → knob1 AudioParam (linear cvScale)
//   k2_cv[ch]   CV → knob2 AudioParam (linear cvScale)
//   out[ch]     mono — audio for drum modes, CV for env/lfo
//
// Inputs:
//   gate0 / gate1 (gate): per-channel trigger.
//   mode0_cv / mode1_cv (cv, discrete, paramTarget=mode{N}): displaces the per-channel mode selector.
//   k1_0_cv / k2_0_cv / k1_1_cv / k2_1_cv (cv, linear, paramTarget=…): per-channel knob CV.
//
// Outputs:
//   out0 / out1 (audio): per-channel output (audio for KICK/SNARE/HIHAT, CV for ENV/LFO).
//
// Params:
//   mode0 / mode1 (discrete 0..PEAKS_MAX_MODE, default 4): per-channel mode picker.
//   k1_0 / k1_1 (linear 0.001..200, default 1): per-channel "knob 1" (semantic depends on mode).
//   k2_0 / k2_1 (linear 0.001..5, default 0.3): per-channel "knob 2".

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/peaks.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const PEAKS_MODE_NAMES = ['KICK', 'SNARE', 'HIHAT', 'ENV', 'LFO'] as const;
export const PEAKS_MAX_MODE = PEAKS_MODE_NAMES.length - 1;
export type PeaksMode = 0 | 1 | 2 | 3 | 4;

// ---------------------------------------------------------------------------
// Pure-math mirror. Keep numerically identical to packages/dsp/src/peaks.ts.
// ---------------------------------------------------------------------------

const _HIHAT_RATIOS = [2.0, 3.0, 4.16, 5.43, 6.79, 8.21];

class _KickEngine {
  phase = 0; pitchEnv = 0; ampEnv = 0;
  trigger(): void { this.phase = 0; this.pitchEnv = 1; this.ampEnv = 1; }
  tick(baseHz: number, decaySec: number, sr: number): number {
    const pCoef = Math.exp(-1 / (0.03 * sr));
    this.pitchEnv *= pCoef;
    const sweepMul = Math.pow(2, 3 * this.pitchEnv);
    const f = Math.min(20000, baseHz * sweepMul);
    const aCoef = Math.exp(-1 / (Math.max(0.01, decaySec) * sr));
    this.ampEnv *= aCoef;
    this.phase += f / sr;
    if (this.phase >= 1) this.phase -= 1;
    return Math.sin(2 * Math.PI * this.phase) * this.ampEnv;
  }
}

class _SnareEngine {
  phase = 0; env = 0; rng = 0xfacefeed | 0;
  trigger(): void { this.phase = 0; this.env = 1; }
  noise(): number {
    this.rng = Math.imul(this.rng, 16807) | 0;
    return ((this.rng & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  }
  tick(mix: number, decaySec: number, sr: number): number {
    const c = Math.exp(-1 / (Math.max(0.01, decaySec) * sr));
    this.env *= c;
    const bodyHz = 180;
    this.phase += bodyHz / sr;
    if (this.phase >= 1) this.phase -= 1;
    const body = Math.sin(2 * Math.PI * this.phase);
    const n = this.noise();
    const m = Math.max(0, Math.min(1, mix));
    return (body * (1 - m) + n * m) * this.env;
  }
}

class _HihatEngine {
  phases = new Float32Array(_HIHAT_RATIOS.length);
  env = 0;
  bpX1 = 0; bpX2 = 0; bpY1 = 0; bpY2 = 0;
  trigger(): void {
    for (let i = 0; i < _HIHAT_RATIOS.length; i++) this.phases[i] = ((i * 0.27 + 0.13) % 1);
    this.env = 1;
    this.bpX1 = 0; this.bpX2 = 0; this.bpY1 = 0; this.bpY2 = 0;
  }
  tick(brightness: number, decaySec: number, sr: number): number {
    const c = Math.exp(-1 / (Math.max(0.01, decaySec) * sr));
    this.env *= c;
    const baseHz = 320;
    let cluster = 0;
    for (let i = 0; i < _HIHAT_RATIOS.length; i++) {
      const r = _HIHAT_RATIOS[i]!;
      this.phases[i]! += (baseHz * r) / sr;
      if (this.phases[i]! >= 1) this.phases[i]! -= 1;
      cluster += this.phases[i]! < 0.5 ? 1 : -1;
    }
    cluster /= _HIHAT_RATIOS.length;
    const bpFreq = 2000 + Math.max(0, Math.min(1, brightness)) * 8000;
    const Q = 0.7;
    const w0 = 2 * Math.PI * bpFreq / sr;
    const cosW0 = Math.cos(w0); const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * Q);
    const b0 = alpha; const b2 = -alpha;
    const a0 = 1 + alpha; const a1 = -2 * cosW0; const a2 = 1 - alpha;
    const y = (b0 * cluster + 0 * this.bpX1 + b2 * this.bpX2 - a1 * this.bpY1 - a2 * this.bpY2) / a0;
    this.bpX2 = this.bpX1; this.bpX1 = cluster;
    this.bpY2 = this.bpY1; this.bpY1 = y;
    return y * this.env;
  }
}

class _EnvEngine {
  stage = 0; value = 0;
  trigger(): void { this.stage = 1; }
  tick(attackSec: number, decaySec: number, sr: number): number {
    const aR = 1 / Math.max(0.001, attackSec * sr);
    const dR = 1 / Math.max(0.001, decaySec * sr);
    if (this.stage === 1) {
      this.value += aR;
      if (this.value >= 1) { this.value = 1; this.stage = 2; }
    } else if (this.stage === 2) {
      this.value -= dR;
      if (this.value <= 0) { this.value = 0; this.stage = 0; }
    }
    return this.value;
  }
}

class _LfoEngine {
  phase = 0;
  trigger(): void { this.phase = 0; }
  tick(rateHz: number, wave: number, sr: number): number {
    const rate = Math.max(0.001, rateHz);
    this.phase += rate / sr;
    if (this.phase >= 1) this.phase -= 1;
    const w = Math.max(0, Math.min(1, wave));
    if (w < 0.25) return Math.sin(2 * Math.PI * this.phase);
    if (w < 0.75) {
      const p = this.phase;
      if (p < 0.25) return 4 * p;
      if (p < 0.75) return 2 - 4 * p;
      return -4 + 4 * p;
    }
    return this.phase < 0.5 ? 1 : -1;
  }
}

export interface PeaksRenderOpts {
  mode: PeaksMode;
  k1: number;
  k2: number;
  /** Sample indices (within [0, n)) where a rising-edge gate fires. */
  triggers?: number[];
}

export const peaksMath = {
  /** Render `n` samples of a single channel at sample rate `sr`. Triggers
   *  fire at the supplied sample indices (rising-edge semantics). */
  render(n: number, sr: number, opts: PeaksRenderOpts): Float32Array {
    const out = new Float32Array(n);
    const kick = new _KickEngine();
    const snare = new _SnareEngine();
    const hihat = new _HihatEngine();
    const env = new _EnvEngine();
    const lfo = new _LfoEngine();
    const trigSet = new Set(opts.triggers ?? []);
    for (let i = 0; i < n; i++) {
      if (trigSet.has(i)) {
        if (opts.mode === 0) kick.trigger();
        else if (opts.mode === 1) snare.trigger();
        else if (opts.mode === 2) hihat.trigger();
        else if (opts.mode === 3) env.trigger();
        else if (opts.mode === 4) lfo.trigger();
      }
      if (opts.mode === 0) out[i] = kick.tick(opts.k1, opts.k2, sr);
      else if (opts.mode === 1) out[i] = snare.tick(opts.k1, opts.k2, sr);
      else if (opts.mode === 2) out[i] = hihat.tick(opts.k1, opts.k2, sr);
      else if (opts.mode === 3) out[i] = env.tick(opts.k1, opts.k2, sr);
      else if (opts.mode === 4) out[i] = lfo.tick(opts.k1, opts.k2, sr);
    }
    return out;
  },

  /** Mode-aware human label for the active knob's semantic. The card
   *  uses these for tooltips + a11y; tests assert the mapping. */
  knobLabels(mode: PeaksMode): { k1: string; k2: string } {
    if (mode === 0) return { k1: 'Pitch', k2: 'Decay' };
    if (mode === 1) return { k1: 'Mix',   k2: 'Decay' };
    if (mode === 2) return { k1: 'Bright', k2: 'Decay' };
    if (mode === 3) return { k1: 'Attack', k2: 'Decay' };
    return { k1: 'Rate', k2: 'Wave' };
  },
};

// ---------------------------------------------------------------------------
// Module def.
// ---------------------------------------------------------------------------

export const peaksDef: AudioModuleDef = {
  type: 'peaks',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'peaks',
  category: 'modulation',
  schemaVersion: 1,
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'gate0',  type: 'gate' },
    { id: 'gate1',  type: 'gate' },
    // Mode is k-rate-ish (rounded) but routed as a CV → AudioParam so a
    // sequencer-step CV can switch modes between hits if a user really
    // wants. Discrete cvScale per the macrooscillator pattern.
    { id: 'mode0_cv', type: 'cv', paramTarget: 'mode0', cvScale: { mode: 'discrete' } },
    { id: 'mode1_cv', type: 'cv', paramTarget: 'mode1', cvScale: { mode: 'discrete' } },
    { id: 'k1_0_cv', type: 'cv', paramTarget: 'k1_0', cvScale: { mode: 'linear' } },
    { id: 'k2_0_cv', type: 'cv', paramTarget: 'k2_0', cvScale: { mode: 'linear' } },
    { id: 'k1_1_cv', type: 'cv', paramTarget: 'k1_1', cvScale: { mode: 'linear' } },
    { id: 'k2_1_cv', type: 'cv', paramTarget: 'k2_1', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out0', type: 'audio' },
    { id: 'out1', type: 'audio' },
  ],
  params: [
    { id: 'mode0', label: 'Mode A', defaultValue: 4, min: 0, max: PEAKS_MAX_MODE, curve: 'discrete' },
    { id: 'mode1', label: 'Mode B', defaultValue: 4, min: 0, max: PEAKS_MAX_MODE, curve: 'discrete' },
    // Knob ranges are union ranges across all modes — the worklet treats
    // the raw value as the mode-active interpretation, and the card hides
    // out-of-range labels.
    //   KICK: k1=pitch Hz (30..200), k2=decay s (0.05..2)
    //   SNARE: k1=mix (0..1), k2=decay s (0.05..2)
    //   HIHAT: k1=bright (0..1), k2=decay s (0.05..2)
    //   ENV:   k1=attack s (0.001..2), k2=decay s (0.005..5)
    //   LFO:   k1=rate Hz (0.01..50), k2=wave (0..1)
    // The fader curve is linear and the value range spans the union.
    { id: 'k1_0', label: 'A1', defaultValue: 1, min: 0.001, max: 200, curve: 'linear' },
    { id: 'k2_0', label: 'A2', defaultValue: 0.3, min: 0.001, max: 5, curve: 'linear' },
    { id: 'k1_1', label: 'B1', defaultValue: 1, min: 0.001, max: 200, curve: 'linear' },
    { id: 'k2_1', label: 'B2', defaultValue: 0.3, min: 0.001, max: 5, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'peaks', {
      // 2 input slots: gate0 + gate1.
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of peaksDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['gate0',    { node: workletNode, input: 0 }],
        ['gate1',    { node: workletNode, input: 1 }],
        ['mode0_cv', { node: workletNode, input: 0, param: params.get('mode0')! }],
        ['mode1_cv', { node: workletNode, input: 0, param: params.get('mode1')! }],
        ['k1_0_cv',  { node: workletNode, input: 0, param: params.get('k1_0')! }],
        ['k2_0_cv',  { node: workletNode, input: 0, param: params.get('k2_0')! }],
        ['k1_1_cv',  { node: workletNode, input: 0, param: params.get('k1_1')! }],
        ['k2_1_cv',  { node: workletNode, input: 0, param: params.get('k2_1')! }],
      ]),
      outputs: new Map([
        ['out0', { node: workletNode, output: 0 }],
        ['out1', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
