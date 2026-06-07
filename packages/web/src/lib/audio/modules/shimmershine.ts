// packages/web/src/lib/audio/modules/shimmershine.ts
//
// SHIMMERSHINE — stereo shimmer reverb. Pure-TS AudioWorklet wraps a
// Schroeder reverb tank (4 combs + 2 allpasses per channel) with a
// pitch-shifted feedback loop (+12 semis via granular fade) for the
// signature crystalline shimmer tail. Use it as the project's "ambient
// halo" reverb: bigger and more dreamy than the basic REVERB, with the
// octave-up shimmer tail that's the module's defining feature.
//
// Inputs:
//   in_l / in_r (audio): stereo input.
//   decay_cv (cv, linear, paramTarget=decay): displaces tank decay time.
//   shimmer_cv (cv, linear, paramTarget=shimmer): displaces the octave-up feedback amount.
//   size_cv (cv, linear, paramTarget=size): displaces the tank size.
//   mix_cv (cv, linear, paramTarget=mix): displaces dry/wet mix.
//
// Outputs:
//   out_l / out_r (audio): stereo wet+dry output.
//
// Params:
//   decay (linear 0..1, default 0.6): tank decay-time macro.
//   shimmer (linear 0..1, default 0.4): +1 octave feedback amount (the shimmer tail intensity).
//   size (linear 0..1, default 0.6): reverb space size.
//   damp (linear 0..1, default 0.4): HF damping in the tank.
//   mix (linear 0..1, default 0.4): dry/wet balance.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/shimmershine.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

// ----------------------------------------------------------------------------
// Pure DSP helpers — reflected from the worklet (packages/dsp/src/shimmershine.ts)
// so unit tests can exercise the pitch-shifter math + full signal chain in
// node (the worklet itself can't be imported from node because it references
// the AudioWorkletGlobalScope-only `AudioWorkletProcessor` base class at
// module load). Any change here MUST mirror the worklet implementation.
// ----------------------------------------------------------------------------

const COMB_LENGTHS_44 = [1116, 1188, 1277, 1356];
const ALLPASS_LENGTHS_44 = [556, 441];

class _CombLP {
  buf: Float32Array;
  idx = 0;
  fbStore = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
  tick(x: number, fb: number, damp: number): number {
    const y = this.buf[this.idx]!;
    this.fbStore = this.fbStore * damp + y * (1 - damp);
    this.buf[this.idx] = x + this.fbStore * fb;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

class _Allpass {
  buf: Float32Array;
  idx = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
  tick(x: number): number {
    const stored = this.buf[this.idx]!;
    const out = -x + stored;
    this.buf[this.idx] = x + stored * 0.5;
    this.idx = (this.idx + 1) % this.buf.length;
    return out;
  }
}

class _SchroederTank {
  combs: _CombLP[];
  allpasses: _Allpass[];
  constructor(sr: number) {
    const scale = sr / 44100;
    this.combs = COMB_LENGTHS_44.map((n) => new _CombLP(Math.max(8, Math.round(n * scale))));
    this.allpasses = ALLPASS_LENGTHS_44.map(
      (n) => new _Allpass(Math.max(8, Math.round(n * scale))),
    );
  }
  tick(x: number, size: number, damp: number): number {
    // Comb feedback range 0.70..0.88 — pulled back from 0.92 so the
    // worst-case combination (size=1, damp=0, decay=1) is still stable
    // when summed across 4 parallel combs + a shimmer feedback loop.
    const fb = 0.70 + 0.18 * size;
    let y = 0;
    for (const c of this.combs) y += c.tick(x, fb, damp);
    y *= 0.25;
    for (const a of this.allpasses) y = a.tick(y);
    return y;
  }
}

class _GranularPitchShifter {
  buf: Float32Array;
  writeIdx = 0;
  headOffsetA: number;
  headOffsetB: number;
  windowSamples: number;
  rate: number;
  constructor(sr: number, rate: number, windowMs: number) {
    this.windowSamples = Math.max(64, Math.round((windowMs / 1000) * sr));
    this.rate = rate;
    this.buf = new Float32Array(this.windowSamples * 4);
    // headOffsetA starts at W (full window behind write — phase 0 in the
    // window, zero crossfade gain at startup so silence comes out cleanly).
    // headOffsetB starts at W/2 (mid-window, peak gain) so it carries the
    // signal while A is at the window edge.
    this.headOffsetA = this.windowSamples;
    this.headOffsetB = this.windowSamples * 0.5;
  }
  private cosWindow(phase: number): number {
    return 0.5 * (1 - Math.cos(2 * Math.PI * phase));
  }
  private readAt(pos: number): number {
    const len = this.buf.length;
    let p = pos % len;
    if (p < 0) p += len;
    const i0 = Math.floor(p);
    const i1 = (i0 + 1) % len;
    const frac = p - i0;
    return this.buf[i0]! * (1 - frac) + this.buf[i1]! * frac;
  }
  tick(x: number): number {
    this.buf[this.writeIdx] = x;
    const W = this.windowSamples;
    // For pitch UP (rate > 1) the read heads must walk forward faster than
    // the write head — i.e. they approach the write head over time, so the
    // headOffset (distance behind write) SHRINKS by (rate - 1) per tick.
    // When the read head catches up (headOffset crosses 0) we wrap it back
    // by W samples; the partner head, offset by W/2, covers the wrap with
    // its mid-window crossfade gain.
    const a = this.readAt(this.writeIdx - this.headOffsetA);
    const b = this.readAt(this.writeIdx - this.headOffsetB);
    // Phase = (W - headOffset) / W within the [0..W] envelope window.
    const phaseA = 1 - this.headOffsetA / W;
    const phaseB = 1 - this.headOffsetB / W;
    const gA = this.cosWindow(phaseA);
    const gB = this.cosWindow(phaseB);
    const out = a * gA + b * gB;
    const delta = this.rate - 1;
    this.headOffsetA -= delta;
    this.headOffsetB -= delta;
    // Wrap: when offset drops below 0 (caught up to write), jump back W.
    if (this.headOffsetA <= 0) this.headOffsetA += W;
    if (this.headOffsetB <= 0) this.headOffsetB += W;
    this.writeIdx = (this.writeIdx + 1) % this.buf.length;
    return out;
  }
}

/** Pure helpers for unit tests + ART scenarios. The actual audio runs in
 *  the worklet at packages/dsp/src/shimmershine.ts; this mirror keeps the
 *  same math reachable from node. */
export const shimmershineMath = {
  hannWindow(phase: number): number {
    return 0.5 * (1 - Math.cos(2 * Math.PI * phase));
  },
  renderPitchShifter(
    input: Float32Array,
    sr: number,
    rate: number,
    windowMs: number,
  ): Float32Array {
    const shifter = new _GranularPitchShifter(sr, rate, windowMs);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = shifter.tick(input[i]!);
    }
    return out;
  },
  renderShimmer(
    input: Float32Array,
    sr: number,
    params: { decay: number; shimmer: number; size: number; damp: number; mix: number },
  ): Float32Array {
    const tank = new _SchroederTank(sr);
    const shifter = new _GranularPitchShifter(sr, 2.0, 25);
    const out = new Float32Array(input.length);
    const effSize = params.size * (0.5 + 0.5 * params.decay);
    const FB_CAP = 0.55;
    const fbGain = params.shimmer * FB_CAP;
    let fb = 0;
    for (let i = 0; i < input.length; i++) {
      const dry = input[i]!;
      // tanh-limit the tank input too — a defensive cap on what the
      // combs can ever see, so even with damp=0 + size=1 + ongoing
      // input the recirculating energy can't blow past ±1.
      const wet = Math.tanh(tank.tick(dry + fb, effSize, params.damp));
      const shifted = shifter.tick(wet);
      fb = Math.tanh(shifted * fbGain);
      out[i] = dry * (1 - params.mix) + wet * params.mix;
    }
    return out;
  },
};

export const shimmershineDef: AudioModuleDef = {
  type: 'shimmershine',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'shimmershine',
  category: 'effects',
  schemaVersion: 1,
  stereoPairs: [['in_l', 'in_r'], ['out_l', 'out_r']],

  inputs: [
    { id: 'in_l',       type: 'audio' },
    { id: 'in_r',       type: 'audio' },
    // CV scaling per .myrobots/plans/cv-range-standard.md — all linear 0..1.
    { id: 'decay_cv',   type: 'cv', paramTarget: 'decay',   cvScale: { mode: 'linear' } },
    { id: 'shimmer_cv', type: 'cv', paramTarget: 'shimmer', cvScale: { mode: 'linear' } },
    { id: 'size_cv',    type: 'cv', paramTarget: 'size',    cvScale: { mode: 'linear' } },
    { id: 'mix_cv',     type: 'cv', paramTarget: 'mix',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    { id: 'decay',   label: 'Decay',   defaultValue: 0.6, min: 0, max: 1, curve: 'linear' },
    { id: 'shimmer', label: 'Shimmer', defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    { id: 'size',    label: 'Size',    defaultValue: 0.6, min: 0, max: 1, curve: 'linear' },
    { id: 'damp',    label: 'Damp',    defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    { id: 'mix',     label: 'Mix',     defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'shimmershine', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const silenceL = ctx.createConstantSource();
    const silenceR = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceR.offset.value = 0;
    silenceL.start();
    silenceR.start();
    silenceL.connect(workletNode, 0, 0);
    silenceR.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of shimmershineDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    const pDecay = params.get('decay');
    const pShimmer = params.get('shimmer');
    const pSize = params.get('size');
    const pMix = params.get('mix');

    return {
      domain: 'audio',
      inputs: new Map([
        ['in_l',       { node: workletNode, input: 0 }],
        ['in_r',       { node: workletNode, input: 1 }],
        ['decay_cv',   { node: workletNode, input: 0, param: pDecay! }],
        ['shimmer_cv', { node: workletNode, input: 0, param: pShimmer! }],
        ['size_cv',    { node: workletNode, input: 0, param: pSize! }],
        ['mix_cv',     { node: workletNode, input: 0, param: pMix! }],
      ]),
      outputs: new Map([
        ['out_l', { node: workletNode, output: 0 }],
        ['out_r', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
