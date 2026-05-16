// packages/web/src/lib/audio/modules/clouds.ts
//
// CLOUDS — granular texture processor. Audio-domain module + pure-math
// mirror of the worklet engine. Worklet at packages/dsp/src/clouds.ts.
// Algorithm after Émilie Gillet's Mutable Instruments Clouds (MIT-licensed);
// attribution in the worklet header.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/clouds.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

// ----------------------------------------------------------------------------
// Pure-math mirror — keep numerically identical to the worklet.
// ----------------------------------------------------------------------------

const _BUFFER_SECONDS = 2.0;
const _MAX_GRAINS = 24;

interface _Grain {
  active: boolean;
  readPos: number;
  pitchRatio: number;
  age: number;
  length: number;
  gainL: number;
  gainR: number;
}

class _LcgRng {
  state: number;
  constructor(seed: number) {
    this.state = seed | 0;
    if (this.state === 0) this.state = 1;
  }
  next(): number {
    this.state = Math.imul(this.state, 16807) | 0;
    return (this.state & 0x7fffffff) / 0x7fffffff;
  }
}

function _grainEnvelope(phase: number, texture: number): number {
  if (phase < 0 || phase >= 1) return 0;
  const rect = 1;
  const tri = 1 - Math.abs(2 * phase - 1);
  const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  if (texture < 0.5) {
    const t = texture * 2;
    return rect * (1 - t) + tri * t;
  }
  const t = (texture - 0.5) * 2;
  return tri * (1 - t) + hann * t;
}

function _readBufferLerp(buf: Float32Array, pos: number): number {
  const len = buf.length;
  let p = pos - Math.floor(pos / len) * len;
  const i0 = Math.floor(p);
  const i1 = i0 + 1 === len ? 0 : i0 + 1;
  const frac = p - i0;
  return buf[i0]! * (1 - frac) + buf[i1]! * frac;
}

class _GranularEngine {
  bufL: Float32Array;
  bufR: Float32Array;
  writeHead = 0;
  bufLen: number;
  fillLevel = 0;
  grains: _Grain[] = [];
  spawnPhasor = 0;
  rng = new _LcgRng(0xc0ffee);
  sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.bufLen = Math.max(2, Math.floor(sr * _BUFFER_SECONDS));
    this.bufL = new Float32Array(this.bufLen);
    this.bufR = new Float32Array(this.bufLen);
    for (let i = 0; i < _MAX_GRAINS; i++) {
      this.grains.push({
        active: false, readPos: 0, pitchRatio: 1, age: 0, length: 0,
        gainL: 0.7, gainR: 0.7,
      });
    }
  }

  reset(): void {
    for (let i = 0; i < this.bufLen; i++) { this.bufL[i] = 0; this.bufR[i] = 0; }
    this.writeHead = 0;
    this.fillLevel = 0;
    this.spawnPhasor = 0;
    for (const g of this.grains) { g.active = false; g.age = 0; }
  }

  private findFreeGrain(): number {
    for (let i = 0; i < this.grains.length; i++) {
      if (!this.grains[i]!.active) return i;
    }
    return -1;
  }

  private spawnGrain(position: number, size: number, pitchRatio: number): void {
    const idx = this.findFreeGrain();
    if (idx < 0) return;
    const g = this.grains[idx]!;
    const minMs = 60;
    const maxMs = 1500;
    const ms = minMs * Math.pow(maxMs / minMs, size);
    const lengthSamples = Math.max(8, Math.floor((ms / 1000) * this.sr));
    const safeLen = Math.min(lengthSamples, Math.floor(this.bufLen * 0.4));
    g.length = safeLen;
    g.age = 0;
    const availableHistory = Math.max(safeLen + 1, Math.min(this.fillLevel, this.bufLen));
    const headroom = Math.max(0, availableHistory - safeLen);
    const offset = safeLen + position * headroom;
    g.readPos = this.writeHead - offset;
    g.pitchRatio = pitchRatio;
    const pan = 0.3 + this.rng.next() * 0.4;
    g.gainL = Math.cos(pan * Math.PI * 0.5);
    g.gainR = Math.sin(pan * Math.PI * 0.5);
    g.active = true;
  }

  tick(
    inL: number, inR: number,
    position: number, size: number, pitchSemitones: number,
    density: number, texture: number, blend: number,
    freeze: boolean,
  ): [number, number] {
    if (!freeze) {
      this.bufL[this.writeHead] = inL;
      this.bufR[this.writeHead] = inR;
      if (this.fillLevel < this.bufLen) this.fillLevel++;
    }
    const clampedSemis = Math.max(-24, Math.min(24, pitchSemitones));
    const pitchRatio = Math.pow(2, clampedSemis / 12);

    const minIntervalSamples = this.sr / 1200;
    const maxIntervalSamples = this.sr / 6;
    const interval = maxIntervalSamples * Math.pow(minIntervalSamples / maxIntervalSamples, density);
    this.spawnPhasor += 1;
    if (this.spawnPhasor >= interval) {
      this.spawnPhasor -= interval;
      this.spawnGrain(position, size, pitchRatio);
    }

    let wetL = 0;
    let wetR = 0;
    let activeCount = 0;
    for (let i = 0; i < this.grains.length; i++) {
      const g = this.grains[i]!;
      if (!g.active) continue;
      const phase = g.age / g.length;
      const env = _grainEnvelope(phase, texture);
      const sL = _readBufferLerp(this.bufL, g.readPos);
      const sR = _readBufferLerp(this.bufR, g.readPos);
      wetL += sL * env * g.gainL;
      wetR += sR * env * g.gainR;
      g.readPos += g.pitchRatio;
      g.age += 1;
      activeCount++;
      if (g.age >= g.length) g.active = false;
    }
    if (activeCount > 1) {
      const norm = 1 / Math.sqrt(activeCount);
      wetL *= norm;
      wetR *= norm;
    }
    wetL *= 1.4;
    wetR *= 1.4;
    wetL = Math.tanh(wetL);
    wetR = Math.tanh(wetR);

    const outL = inL * (1 - blend) + wetL * blend;
    const outR = inR * (1 - blend) + wetR * blend;
    this.writeHead = (this.writeHead + 1) % this.bufLen;
    return [outL, outR];
  }
}

export interface CloudsParams {
  position: number;
  size: number;
  pitch: number;
  density: number;
  texture: number;
  blend: number;
}

export const cloudsMath = {
  grainEnvelope(phase: number, texture: number): number {
    return _grainEnvelope(phase, texture);
  },

  render(
    inL: Float32Array,
    inR: Float32Array,
    sr: number,
    pitchV: number,
    params: CloudsParams,
    options?: { freezeAt?: number },
  ): { outL: Float32Array; outR: Float32Array } {
    const n = Math.min(inL.length, inR.length);
    const eng = new _GranularEngine(sr);
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    const pitchSemis = pitchV * 12 + params.pitch;
    let frozen = false;
    const freezeAt = options?.freezeAt;
    for (let i = 0; i < n; i++) {
      if (freezeAt !== undefined && i === freezeAt) frozen = true;
      const [l, r] = eng.tick(
        inL[i]!, inR[i]!,
        params.position, params.size, pitchSemis,
        params.density, params.texture, params.blend,
        frozen,
      );
      outL[i] = l;
      outR[i] = r;
    }
    return { outL, outR };
  },
};

export const cloudsDef: AudioModuleDef = {
  type: 'clouds',
  domain: 'audio',
  label: 'CLOUDS',
  category: 'effects',
  schemaVersion: 1,
  stereoPairs: [['in_l', 'in_r'], ['out_l', 'out_r']],

  inputs: [
    { id: 'in_l',        type: 'audio' },
    { id: 'in_r',        type: 'audio' },
    { id: 'pitch',       type: 'pitch' },
    { id: 'freeze_gate', type: 'gate' },
    { id: 'position_cv', type: 'cv', paramTarget: 'position', cvScale: { mode: 'linear' } },
    { id: 'size_cv',     type: 'cv', paramTarget: 'size',     cvScale: { mode: 'linear' } },
    { id: 'pitch_cv',    type: 'cv', paramTarget: 'pitch',    cvScale: { mode: 'linear' } },
    { id: 'density_cv',  type: 'cv', paramTarget: 'density',  cvScale: { mode: 'linear' } },
    { id: 'texture_cv',  type: 'cv', paramTarget: 'texture',  cvScale: { mode: 'linear' } },
    { id: 'blend_cv',    type: 'cv', paramTarget: 'blend',    cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    { id: 'position', label: 'Position', defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'size',     label: 'Size',     defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'pitch',    label: 'Pitch',    defaultValue: 0,   min: -24, max: 24, curve: 'linear', units: 'st' },
    { id: 'density',  label: 'Density',  defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'texture',  label: 'Texture',  defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'blend',    label: 'Blend',    defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'freeze',   label: 'Freeze',   defaultValue: 0,   min: 0,   max: 1,  curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'clouds', {
      numberOfInputs: 4,
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
    for (const def of cloudsDef.params) {
      if (def.id === 'freeze') continue;
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const freezeInitial = ((node.params ?? {})['freeze'] ?? 0) >= 0.5;
    if (freezeInitial) {
      params.get('freeze')?.setValueAtTime(1, ctx.currentTime);
      params.get('freeze')?.setValueAtTime(0, ctx.currentTime + 0.05);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in_l',        { node: workletNode, input: 0 }],
        ['in_r',        { node: workletNode, input: 1 }],
        ['pitch',       { node: workletNode, input: 2 }],
        ['freeze_gate', { node: workletNode, input: 3 }],
        ['position_cv', { node: workletNode, input: 0, param: params.get('position')! }],
        ['size_cv',     { node: workletNode, input: 0, param: params.get('size')! }],
        ['pitch_cv',    { node: workletNode, input: 0, param: params.get('pitch')! }],
        ['density_cv',  { node: workletNode, input: 0, param: params.get('density')! }],
        ['texture_cv',  { node: workletNode, input: 0, param: params.get('texture')! }],
        ['blend_cv',    { node: workletNode, input: 0, param: params.get('blend')! }],
      ]),
      outputs: new Map([
        ['out_l', { node: workletNode, output: 0 }],
        ['out_r', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'freeze') {
          // Pulse the worklet's a-rate freeze param — it detects rising
          // edges and toggles its internal latched-freeze flag on each one.
          params.get('freeze')?.setValueAtTime(1, ctx.currentTime);
          params.get('freeze')?.setValueAtTime(0, ctx.currentTime + 0.005);
          return;
        }
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        if (paramId === 'freeze') return undefined;
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        try { silenceL.disconnect(); } catch { /* */ }
        try { silenceR.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
