// packages/web/src/lib/audio/modules/rings.ts
//
// RINGS — modal / sympathetic-string resonator (audio domain).
//
// Faithful TypeScript port of Émilie Gillet's Rings (Mutable Instruments).
// Source: eurorack/rings/ — Copyright 2015 Émilie Gillet, MIT-licensed per
// individual file headers. The eurorack repo's overall README states
// "Code (STM32F projects): MIT license" so we're compatible with patch-
// together.live's MIT license. See packages/dsp/src/rings.ts for the
// worklet DSP; the pure-math mirror in this file is what unit tests and
// the ART scenario exercise.
//
// Inputs:
//   in (audio): external excitation input (replaces internal exciter when patched).
//   pitch (pitch): V/oct (1 unit = 1 octave). Sums with note.
//   strum (gate): rising edge re-strums the resonator chord.
//   model_cv (cv, discrete, paramTarget=model): displaces the resonator-model selector.
//   note_cv (cv, linear, paramTarget=note): displaces the note offset (±60 st).
//   str_cv (cv, linear, paramTarget=structure): displaces STRUCTURE.
//   bright_cv (cv, linear, paramTarget=brightness): displaces BRIGHTNESS.
//   damp_cv (cv, linear, paramTarget=damping): displaces DAMPING.
//   pos_cv (cv, linear, paramTarget=position): displaces POSITION.
//   level_cv (cv, linear, paramTarget=level): displaces LEVEL.
//
// Outputs:
//   odd (audio): odd-mode resonator output.
//   even (audio): even-mode resonator output (parallel companion to ODD).
//
// Params:
//   model (discrete 0..RINGS_MAX_MODEL, default 0): resonator-model selector.
//   note (linear -60..60 st, default 0): semitone offset from pitch CV.
//   structure (linear 0..1, default 0.25): inharmonicity / structure macro.
//   brightness (linear 0..1, default 0.5): high-end character.
//   damping (linear 0..1, default 0.5): partial decay / damping.
//   position (linear 0..1, default 0.5): pickup position along the resonator.
//   level (linear 0..1, default 0.8): output level.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/rings.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

const _MODAL_MAX_PARTIALS = 24;

class _Biquad {
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  reset(): void { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  setBandpass(freq: number, q: number, sr: number): void {
    const w0 = 2 * Math.PI * Math.min(freq, sr * 0.49) / sr;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * Math.max(0.5, q));
    const a0 = 1 + alpha;
    this.b0 =  alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = -2 * cosW0 / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
              - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class _RingsModal {
  filters: _Biquad[] = [];
  position = 0.5;
  numModes = _MODAL_MAX_PARTIALS;
  constructor() {
    for (let i = 0; i < _MODAL_MAX_PARTIALS; i++) this.filters.push(new _Biquad());
  }
  reset(): void {
    for (const f of this.filters) f.reset();
    this.position = 0.5;
  }
  configure(freq: number, structure: number, brightness: number, damping: number, sr: number): void {
    const stiffness = structure * 0.5;
    const q = 5 + Math.pow(1 - damping, 2) * 495;
    const bClamped = Math.max(0, Math.min(1, brightness));
    let qLoss = bClamped * (2 - bClamped) * 0.85 + 0.15;
    const qLossDampingRate = structure * (2 - structure) * 0.1;
    let stretch = 1;
    let qCurrent = q;
    let activeModes = 0;
    for (let i = 0; i < _MODAL_MAX_PARTIALS; i++) {
      const partialFreq = freq * (i + 1) * stretch;
      if (partialFreq < sr * 0.49) activeModes = i + 1;
      this.filters[i]!.setBandpass(partialFreq, qCurrent * 0.05, sr);
      stretch += stiffness;
      qLoss += qLossDampingRate * (1 - qLoss);
      qCurrent *= qLoss;
    }
    this.numModes = activeModes;
  }
  process(input: number): [number, number] {
    const p = this.position * Math.PI;
    let odd = 0;
    let even = 0;
    for (let i = 0; i < this.numModes; i++) {
      const w = Math.cos(p * (i + 1));
      const y = this.filters[i]!.process(input * 0.125);
      if ((i & 1) === 0) odd += w * y;
      else even += w * y;
    }
    return [odd, even];
  }
  setPosition(p: number): void { this.position = Math.max(0, Math.min(1, p)); }
}

const _KS_MAX_DELAY = 4096;
const _NUM_STRINGS = 2;

class _KSString {
  buf = new Float32Array(_KS_MAX_DELAY);
  writeIdx = 0;
  brightLpState = 0;
  dampLpState = 0;
  freq = 220;
  damping = 0.5;
  brightness = 0.5;
  reset(): void {
    for (let i = 0; i < _KS_MAX_DELAY; i++) this.buf[i] = 0;
    this.writeIdx = 0;
    this.brightLpState = 0;
    this.dampLpState = 0;
  }
  configure(freq: number, damping: number, brightness: number): void {
    this.freq = freq;
    this.damping = damping;
    this.brightness = brightness;
  }
  process(input: number, sr: number): number {
    const delayLen = Math.max(2, Math.min(_KS_MAX_DELAY - 1, Math.round(sr / this.freq)));
    const readIdx = (this.writeIdx - delayLen + _KS_MAX_DELAY) % _KS_MAX_DELAY;
    const delayed = this.buf[readIdx]!;
    const brightCutHz = 200 + this.brightness * 9800;
    const brightAlpha = 1 - Math.exp(-2 * Math.PI * brightCutHz / sr);
    this.brightLpState += brightAlpha * (input - this.brightLpState);
    const dampCutHz = 200 + (1 - this.damping) * 11800;
    const dampAlpha = 1 - Math.exp(-2 * Math.PI * dampCutHz / sr);
    const loopIn = delayed + this.brightLpState;
    this.dampLpState += dampAlpha * (loopIn - this.dampLpState);
    const loopGain = 0.998 - this.damping * 0.08;
    const looped = this.dampLpState * loopGain;
    this.buf[this.writeIdx] = looped;
    this.writeIdx = (this.writeIdx + 1) % _KS_MAX_DELAY;
    return looped;
  }
}

class _Plucker {
  remaining = 0;
  rngState = 0x12345678 | 0;
  trigger(durationSamples: number): void { this.remaining = durationSamples | 0; }
  next(): number {
    if (this.remaining <= 0) return 0;
    this.remaining--;
    this.rngState = (this.rngState * 16807) | 0;
    return ((this.rngState & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  }
}

class _RingsSympatheticStrings {
  strings: _KSString[] = [];
  plucker = new _Plucker();
  constructor() {
    for (let i = 0; i < _NUM_STRINGS; i++) this.strings.push(new _KSString());
  }
  reset(): void {
    for (const s of this.strings) s.reset();
    this.plucker.remaining = 0;
  }
  configure(freq: number, structure: number, brightness: number, damping: number, sr: number): void {
    const detuneSemi = structure * 19;
    const ratios = [1.0, Math.pow(2, detuneSemi / 12)];
    for (let i = 0; i < _NUM_STRINGS; i++) {
      this.strings[i]!.configure(freq * ratios[i]!, damping, brightness);
    }
  }
  triggerStrum(sr: number): void {
    this.plucker.trigger(Math.floor(0.01 * sr));
  }
  process(externalExciter: number, position: number, sr: number): [number, number] {
    const burst = this.plucker.next();
    const burstA = burst * (1 - position * 0.4);
    const burstB = burst * (1 - (1 - position) * 0.4);
    const inputA = externalExciter + burstA;
    const inputB = externalExciter + burstB;
    const yA = this.strings[0]!.process(inputA, sr);
    const yB = this.strings[1]!.process(inputB, sr);
    const odd  = yA * position + yB * (1 - position);
    const even = yA * (1 - position) + yB * position;
    return [odd, even];
  }
}

export interface RingsParams {
  /** 0 = MODAL, 1 = SYMPATHETIC_STRING. Rounded in render. */
  model: number;
  note: number;
  structure: number;
  brightness: number;
  damping: number;
  position: number;
  level: number;
}

export const RINGS_MODEL_NAMES = ['MODAL', 'SYMPATHETIC'] as const;
export type RingsModelName = (typeof RINGS_MODEL_NAMES)[number];
export const RINGS_MAX_MODEL = RINGS_MODEL_NAMES.length - 1;

export const ringsMath = {
  render(
    n: number,
    sr: number,
    pitchV: number,
    params: RingsParams,
    exciter?: Float32Array | null,
    strumAt = -1,
  ): { odd: Float32Array; even: Float32Array } {
    const modal = new _RingsModal();
    const symp = new _RingsSympatheticStrings();
    const modalPlucker = new _Plucker();
    modal.reset();
    symp.reset();
    const odd = new Float32Array(n);
    const even = new Float32Array(n);

    const semitones = pitchV * 12 + params.note;
    let freq = 261.6256 * Math.pow(2, semitones / 12);
    if (freq < 8) freq = 8;
    else if (freq > sr * 0.45) freq = sr * 0.45;

    const modelIdx = Math.max(0, Math.min(RINGS_MAX_MODEL, Math.round(params.model)));
    const s = Math.max(0, Math.min(1, params.structure));
    const b = Math.max(0, Math.min(1, params.brightness));
    const d = Math.max(0, Math.min(1, params.damping));
    const p = Math.max(0, Math.min(1, params.position));
    const lvl = Math.max(0, Math.min(1, params.level));

    modal.configure(freq, s, b, d, sr);
    symp.configure(freq, s, b, d, sr);
    modal.setPosition(p);

    for (let i = 0; i < n; i++) {
      if (i === strumAt) {
        symp.triggerStrum(sr);
        // Self-excite MODAL too so STRUM produces sound without an external exciter.
        modalPlucker.trigger(Math.floor(0.01 * sr));
      }
      const exc = exciter ? (exciter[i] ?? 0) : 0;
      let o: number;
      let e: number;
      if (modelIdx === 0) {
        const burst = modalPlucker.next();
        [o, e] = modal.process(exc + burst);
      } else {
        [o, e] = symp.process(exc, p, sr);
      }
      odd[i]  = Math.tanh(o * lvl);
      even[i] = Math.tanh(e * lvl);
    }
    return { odd, even };
  },
};

export const ringsDef: AudioModuleDef = {
  type: 'rings',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'rings',
  category: 'sources',
  schemaVersion: 1,
  stereoPairs: [
    ['odd', 'even'],
  ],
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'in',        type: 'audio' },
    { id: 'pitch',     type: 'pitch' },
    { id: 'strum',     type: 'gate' },
    { id: 'model_cv',  type: 'cv', paramTarget: 'model',      cvScale: { mode: 'discrete' } },
    { id: 'note_cv',   type: 'cv', paramTarget: 'note',       cvScale: { mode: 'linear' } },
    { id: 'str_cv',    type: 'cv', paramTarget: 'structure',  cvScale: { mode: 'linear' } },
    { id: 'bright_cv', type: 'cv', paramTarget: 'brightness', cvScale: { mode: 'linear' } },
    { id: 'damp_cv',   type: 'cv', paramTarget: 'damping',    cvScale: { mode: 'linear' } },
    { id: 'pos_cv',    type: 'cv', paramTarget: 'position',   cvScale: { mode: 'linear' } },
    { id: 'level_cv',  type: 'cv', paramTarget: 'level',      cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'odd',  type: 'audio' },
    { id: 'even', type: 'audio' },
  ],
  params: [
    { id: 'model',      label: 'Model',      defaultValue: 0,    min: 0,   max: RINGS_MAX_MODEL, curve: 'discrete' },
    { id: 'note',       label: 'Note',       defaultValue: 0,    min: -60, max: 60, curve: 'linear', units: 'st' },
    { id: 'structure',  label: 'Structure',  defaultValue: 0.25, min: 0,   max: 1,  curve: 'linear' },
    { id: 'brightness', label: 'Brightness', defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'damping',    label: 'Damping',    defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'position',   label: 'Position',   defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'level',      label: 'Level',      defaultValue: 0.8,  min: 0,   max: 1,  curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'rings', {
      numberOfInputs: 3,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of ringsDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in',        { node: workletNode, input: 0 }],
        ['pitch',     { node: workletNode, input: 1 }],
        ['strum',     { node: workletNode, input: 2 }],
        ['model_cv',  { node: workletNode, input: 0, param: params.get('model')! }],
        ['note_cv',   { node: workletNode, input: 0, param: params.get('note')! }],
        ['str_cv',    { node: workletNode, input: 0, param: params.get('structure')! }],
        ['bright_cv', { node: workletNode, input: 0, param: params.get('brightness')! }],
        ['damp_cv',   { node: workletNode, input: 0, param: params.get('damping')! }],
        ['pos_cv',    { node: workletNode, input: 0, param: params.get('position')! }],
        ['level_cv',  { node: workletNode, input: 0, param: params.get('level')! }],
      ]),
      outputs: new Map([
        ['odd',  { node: workletNode, output: 0 }],
        ['even', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) { params.get(paramId)?.setValueAtTime(value, ctx.currentTime); },
      readParam(paramId) { return params.get(paramId)?.value; },
      dispose() { try { workletNode.disconnect(); } catch { /* */ } },
    };
  },
};
