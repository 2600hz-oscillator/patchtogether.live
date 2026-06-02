// packages/web/src/lib/audio/modules/blades.ts
//
// BLADES — dual SVF VCF + COLOR overdrive + mix bus. From-spec
// implementation of the Mutable Instruments Blades archetype.
// Worklet DSP at packages/dsp/src/blades.ts.
//
// I/O surface:
//   in1 / in2          per-filter audio inputs
//   voct1 / voct2      V/oct CV (octave-offset on cutoff knob)
//   cutoff1_cv /       audio-rate cutoff CV (octave-scaled, sums into
//   cutoff2_cv         the V/oct path)
//   res1_cv / res2_cv  CV → resonance AudioParam (linear cvScale)
//   color_cv           CV → COLOR (linear cvScale)
//   mix_mode_cv        CV → mixMode (discrete, 0=parallel, 1=serial)
//   out1 / out2        per-filter audio outputs (LP/BP/HP per mode)
//   mix                mix bus output
//
// COLOR + cutoff CV inputs are PASSTHROUGH_BY_DESIGN where they enter
// the worklet via audio-rate node inputs (voct + cutoffN_cv), since the
// worklet already expects a bipolar ±1 carrier and applies its own
// musical-range mapping (octave-scaled via 2^x). The res / color / mode
// CV inputs route via AudioParam with linear/discrete cvScale so an LFO
// sweeps the full param range.
//
// Inputs:
//   in1 / in2 (audio): per-filter audio inputs.
//   voct1 / voct2 (cv): V/oct CV; ±1V → ±1 octave offset on the per-filter cutoff knob.
//   cutoff1_cv / cutoff2_cv (cv): audio-rate cutoff CV (sums into the V/oct path).
//   res1_cv / res2_cv (cv, linear, paramTarget=res{N}): displaces per-filter resonance.
//   color_cv (cv, linear, paramTarget=color): displaces COLOR overdrive.
//   mix_mode_cv (cv, discrete, paramTarget=mixMode): displaces 0=parallel / 1=serial.
//
// Outputs:
//   out1 / out2 (audio): per-filter output (per-filter mode picker selects LP/BP/HP/etc).
//   mix (audio): mix bus (depends on mixMode).
//
// Params:
//   cutoff1 / cutoff2 (log 20..20000 Hz, default 1000): per-filter center frequency.
//   res1 / res2 (linear 0..1, default 0.1): per-filter resonance.
//   mode1 / mode2 (discrete 0..BLADES_MAX_MODE, default 0): per-filter mode picker.
//   color (linear 0..1, default 0): COLOR overdrive amount.
//   mixMode (discrete 0..1, default 0): 0=parallel, 1=serial routing for the MIX bus.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/blades.js?url';

const PROCESSOR_NAME = 'blades';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const BLADES_MODE_NAMES = ['LP', 'BP', 'HP'] as const;
export type BladesMode = 0 | 1 | 2;
export const BLADES_MAX_MODE = BLADES_MODE_NAMES.length - 1;

export const BLADES_MIX_MODE_NAMES = ['PARALLEL', 'SERIAL'] as const;
export type BladesMixMode = 0 | 1;

// ---------------------------------------------------------------------------
// Pure-math mirror. Numerically identical to packages/dsp/src/blades.ts.
// Used by unit + ART tests so we can pin filter response without Web Audio.
// ---------------------------------------------------------------------------

interface SvfState { ic1: number; ic2: number; }

function svfStep(
  input: number,
  g: number,
  k: number,
  s: SvfState,
): { lp: number; bp: number; hp: number } {
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = input - s.ic2;
  const v1 = a1 * s.ic1 + a2 * v3;
  const v2 = s.ic2 + a2 * s.ic1 + a3 * v3;
  s.ic1 = 2 * v1 - s.ic1;
  s.ic2 = 2 * v2 - s.ic2;
  // HP uses the RAW input (not v3) — that's the standard Cytomic /
  // Zavalishin output equation. Using v3 instead would subtract the
  // damped integrator state and ruin the HP roll-off.
  return { lp: v2, bp: v1, hp: input - k * v1 - v2 };
}

function pickMode(
  modes: { lp: number; bp: number; hp: number },
  mode: BladesMode,
): number {
  return mode === 0 ? modes.lp : mode === 1 ? modes.bp : modes.hp;
}

export const bladesMath = {
  /** Cutoff in Hz given knob + voct + audio-rate CV (cv is in ±1 units,
   *  mapped to ±5 octaves to match the existing filter.dsp convention). */
  cutoffHz(knobHz: number, voct: number, cv: number, sr: number): number {
    const raw = knobHz * Math.pow(2, voct + cv * 5);
    return Math.min(sr * 0.49, Math.max(10, raw));
  },

  /** Resonance → k mapping. k=0.003 = edge of self-osc (clamped so
   *  float round-off doesn't push k negative and break the SVF
   *  topology coefficient a1 = 1/(1+g*(g+k))). */
  resToK(res: number): number {
    const r = Math.max(0, Math.min(1, res));
    return Math.max(0.003, 2 - 2 * r);
  },

  /** COLOR drive: 0 → 1, 1 → 10. Identity-like at 0; aggressive at 1. */
  colorDrive(color: number): number {
    const c = Math.max(0, Math.min(1, color));
    return 1 + 9 * c;
  },

  /** Apply the COLOR pre-stage. color==0 is a no-op (linear identity). */
  applyColor(sample: number, color: number): number {
    if (color <= 0) return sample;
    return Math.tanh(sample * bladesMath.colorDrive(color));
  },

  /** Step a single SVF core. Mutates state in place; returns selected mode out. */
  step(
    input: number,
    fcHz: number,
    res: number,
    mode: BladesMode,
    state: SvfState,
    sr: number,
  ): number {
    const g = Math.tan(Math.PI * fcHz / sr);
    const k = bladesMath.resToK(res);
    return pickMode(svfStep(input, g, k, state), mode);
  },

  /** Render `frames` of audio through both filters + the mix bus.
   *  Inputs are nullable (null = silent / unpatched). Returns the three
   *  outputs the worklet emits: out1, out2, mix. */
  render(
    in1: Float32Array | null,
    in2: Float32Array | null,
    frames: number,
    opts: {
      cutoff1: number;       // Hz
      cutoff2: number;       // Hz
      res1: number;          // 0..1
      res2: number;          // 0..1
      mode1: BladesMode;
      mode2: BladesMode;
      color: number;         // 0..1
      mixMode: BladesMixMode;
      sr: number;
      voct1?: Float32Array;
      voct2?: Float32Array;
      cv1?: Float32Array;    // cutoff CV (audio-rate, octave-scaled)
      cv2?: Float32Array;
    },
  ): { out1: Float32Array; out2: Float32Array; mix: Float32Array } {
    const out1 = new Float32Array(frames);
    const out2 = new Float32Array(frames);
    const mix  = new Float32Array(frames);
    const sf1: SvfState = { ic1: 0, ic2: 0 };
    const sf2: SvfState = { ic1: 0, ic2: 0 };
    const ss2: SvfState = { ic1: 0, ic2: 0 };
    for (let i = 0; i < frames; i++) {
      const vo1 = opts.voct1?.[i] ?? 0;
      const vo2 = opts.voct2?.[i] ?? 0;
      const md1 = opts.cv1?.[i] ?? 0;
      const md2 = opts.cv2?.[i] ?? 0;
      const fc1 = bladesMath.cutoffHz(opts.cutoff1, vo1, md1, opts.sr);
      const fc2 = bladesMath.cutoffHz(opts.cutoff2, vo2, md2, opts.sr);
      const x1 = in1 ? (in1[i] ?? 0) : 0;
      const x2 = in2 ? (in2[i] ?? 0) : 0;
      const xd1 = bladesMath.applyColor(x1, opts.color);
      const xd2 = bladesMath.applyColor(x2, opts.color);

      const y1 = bladesMath.step(xd1, fc1, opts.res1, opts.mode1, sf1, opts.sr);
      const y2 = bladesMath.step(xd2, fc2, opts.res2, opts.mode2, sf2, opts.sr);
      const ys = bladesMath.step(y1,  fc2, opts.res2, opts.mode2, ss2, opts.sr);

      out1[i] = y1;
      out2[i] = y2;
      mix[i]  = opts.mixMode === 0 ? Math.tanh(y1 + y2) : Math.tanh(ys);
    }
    return { out1, out2, mix };
  },
};

export const bladesDef: AudioModuleDef = {
  type: 'blades',
  palette: { top: 'Ports', sub: 'Mutable' },
  domain: 'audio',
  label: 'BLADES',
  category: 'filters',
  schemaVersion: 1,

  inputs: [
    { id: 'in1',   type: 'audio' },
    { id: 'in2',   type: 'audio' },
    // V/oct CV inputs: routed through audio-rate node inputs so the
    // worklet sees the raw octave-units carrier. PASSTHROUGH_BY_DESIGN
    // — the worklet already does 2^(voct+...) so no AudioParam scaling
    // would help.
    { id: 'voct1', type: 'cv' },
    { id: 'voct2', type: 'cv' },
    // Audio-rate cutoff modulation. Same passthrough rationale: the
    // worklet applies cv*5-octave mapping itself.
    { id: 'cutoff1_cv', type: 'cv' },
    { id: 'cutoff2_cv', type: 'cv' },
    // Param-targeted CV: res / color / mix-mode go through cvScale so an
    // LFO of ±1 sweeps the full musical range.
    { id: 'res1_cv',     type: 'cv', paramTarget: 'res1',    cvScale: { mode: 'linear' } },
    { id: 'res2_cv',     type: 'cv', paramTarget: 'res2',    cvScale: { mode: 'linear' } },
    { id: 'color_cv',    type: 'cv', paramTarget: 'color',   cvScale: { mode: 'linear' } },
    { id: 'mix_mode_cv', type: 'cv', paramTarget: 'mixMode', cvScale: { mode: 'discrete' } },
  ],
  outputs: [
    { id: 'out1', type: 'audio' },
    { id: 'out2', type: 'audio' },
    { id: 'mix',  type: 'audio' },
  ],
  params: [
    { id: 'cutoff1', label: 'Cut 1', defaultValue: 1000, min: 20,   max: 20000, curve: 'log', units: 'Hz' },
    { id: 'cutoff2', label: 'Cut 2', defaultValue: 1000, min: 20,   max: 20000, curve: 'log', units: 'Hz' },
    { id: 'res1',    label: 'Res 1', defaultValue: 0.1,  min: 0,    max: 1,     curve: 'linear' },
    { id: 'res2',    label: 'Res 2', defaultValue: 0.1,  min: 0,    max: 1,     curve: 'linear' },
    { id: 'mode1',   label: 'M1',    defaultValue: 0,    min: 0,    max: BLADES_MAX_MODE, curve: 'discrete' },
    { id: 'mode2',   label: 'M2',    defaultValue: 0,    min: 0,    max: BLADES_MAX_MODE, curve: 'discrete' },
    { id: 'color',   label: 'COLOR', defaultValue: 0,    min: 0,    max: 1,     curve: 'linear' },
    { id: 'mixMode', label: 'MIX',   defaultValue: 0,    min: 0,    max: 1,     curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 6,
      numberOfOutputs: 3,
      outputChannelCount: [1, 1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of bladesDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in1',         { node: worklet, input: 0 }],
        ['in2',         { node: worklet, input: 1 }],
        ['voct1',       { node: worklet, input: 2 }],
        ['voct2',       { node: worklet, input: 3 }],
        ['cutoff1_cv',  { node: worklet, input: 4 }],
        ['cutoff2_cv',  { node: worklet, input: 5 }],
        ['res1_cv',     { node: worklet, input: 0, param: params.get('res1')! }],
        ['res2_cv',     { node: worklet, input: 0, param: params.get('res2')! }],
        ['color_cv',    { node: worklet, input: 0, param: params.get('color')! }],
        ['mix_mode_cv', { node: worklet, input: 0, param: params.get('mixMode')! }],
      ]),
      outputs: new Map([
        ['out1', { node: worklet, output: 0 }],
        ['out2', { node: worklet, output: 1 }],
        ['mix',  { node: worklet, output: 2 }],
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
