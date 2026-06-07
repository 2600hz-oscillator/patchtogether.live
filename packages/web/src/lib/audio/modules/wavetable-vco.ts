// packages/web/src/lib/audio/modules/wavetable-vco.ts
//
// WAVETABLE VCO — one-shot wavetable oscillator with continuous
// frame-morph control. The DSP is a custom JS AudioWorklet
// (packages/dsp/src/wavetable-vco.ts). The factory generates a synthetic
// 16-frame "basic" wavetable that morphs saw → square → triangle → sine
// and loads it into the worklet via port.postMessage on instantiation.
// The `wavePos` param picks the morph position into the 16-frame table;
// the wavetable is a fixed sequence shipped with the module, NOT a user-
// uploaded set (see WAVECEL or WAVVIZ for those).
//
// Inputs:
//   pitch (pitch): V/oct pitch input, 0V = C4.
//   fm (audio): audio-rate frequency modulator, scaled by fmAmount.
//   wavePos (cv, paramTarget=wavePos): displaces the wavetable morph position.
//   pm (audio): audio-rate phase modulator, scaled by pmAmount.
//   tune (cv, linear, paramTarget=tune): displaces tune knob (semitones).
//   fine (cv, linear, paramTarget=fine): displaces fine knob (cents).
//   fmAmount (cv, linear, paramTarget=fmAmount): displaces FM-depth knob.
//   pmAmount (cv, linear, paramTarget=pmAmount): displaces PM-depth knob.
//
// Outputs:
//   audio (audio): the morphed wavetable signal.
//
// Params:
//   tune (linear -36..36 st, default 0): coarse tune semitones.
//   fine (linear -100..100 ¢, default 0): fine tune cents.
//   wavePos (linear 0..1, default 0): position into the 16-frame table (0 = first frame, 1 = last).
//   fmAmount (linear -1..1, default 0): FM input depth.
//   pmAmount (linear -1..1, default 0): PM input depth.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/wavetable-vco.js?url';

const FRAME_SIZE = 2048;
const FRAME_COUNT = 16;

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

function generateBasicTable(): Float32Array {
  const table = new Float32Array(FRAME_SIZE * FRAME_COUNT);
  for (let f = 0; f < FRAME_COUNT; f++) {
    const t = f / (FRAME_COUNT - 1); // 0..1
    for (let s = 0; s < FRAME_SIZE; s++) {
      const phase = s / FRAME_SIZE; // 0..1
      let v: number;
      if (t < 1 / 3) {
        // Saw → Square morph
        const m = t * 3;
        const saw = phase < 0.5 ? 2 * phase : 2 * phase - 2;
        const sqr = phase < 0.5 ? 1 : -1;
        v = saw * (1 - m) + sqr * m;
      } else if (t < 2 / 3) {
        // Square → Triangle morph
        const m = (t - 1 / 3) * 3;
        const sqr = phase < 0.5 ? 1 : -1;
        const tri =
          phase < 0.25 ? 4 * phase :
          phase < 0.75 ? 2 - 4 * phase :
          -4 + 4 * phase;
        v = sqr * (1 - m) + tri * m;
      } else {
        // Triangle → Sine morph
        const m = (t - 2 / 3) * 3;
        const tri =
          phase < 0.25 ? 4 * phase :
          phase < 0.75 ? 2 - 4 * phase :
          -4 + 4 * phase;
        const sn = Math.sin(2 * Math.PI * phase);
        v = tri * (1 - m) + sn * m;
      }
      table[f * FRAME_SIZE + s] = v;
    }
  }
  return table;
}

export const wavetableVcoDef: AudioModuleDef = {
  type: 'wavetableVco',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'wavetable vco',
  category: 'sources',
  schemaVersion: 3,
  migrate(data, fromVersion) {
    if (fromVersion < 2) {
      const d = (data ?? {}) as { params?: Record<string, number> };
      const params = { ...(d.params ?? {}) };
      if (params.pmAmount === undefined) params.pmAmount = 0;
      return { ...d, params };
    }
    // v2 → v3: fmAmount / pmAmount widened from [0..1] to [-1..+1]. Old values
    // are already legal in the new range, so this is a no-op.
    return data;
  },

  inputs: [
    { id: 'pitch',   type: 'pitch' },
    { id: 'fm',      type: 'audio' },
    // wavePos is audio-rate (the worklet sums wpKnob + wpCv per-sample), so
    // it doesn't go through the CV→AudioParam fast path. paramTarget keeps
    // docs labelling correct; cvScale would do nothing here (the input is
    // not summed onto an AudioParam — see PASSTHROUGH_BY_DESIGN registry).
    { id: 'wavePos', type: 'cv', paramTarget: 'wavePos' },
    // pm: audio-rate phase modulation input. ±1 input × pmAmount = up to
    // ±1 cycle of phase shift at the wavetable readout.
    { id: 'pm',      type: 'audio' },
    // CV → AudioParam routings (engine attaches a WaveShaperNode scaler so
    // an LFO ±1 sweeps the full natural range centered on the knob).
    { id: 'tune',     type: 'cv', paramTarget: 'tune',     cvScale: { mode: 'linear' } },
    { id: 'fine',     type: 'cv', paramTarget: 'fine',     cvScale: { mode: 'linear' } },
    { id: 'fmAmount', type: 'cv', paramTarget: 'fmAmount', cvScale: { mode: 'linear' } },
    { id: 'pmAmount', type: 'cv', paramTarget: 'pmAmount', cvScale: { mode: 'linear' } },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'tune',     label: 'Tune', defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',     label: 'Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'wavePos',  label: 'Wave', defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'fmAmount', label: 'FM',   defaultValue: 0,   min: -1,   max: 1,   curve: 'linear' },
    { id: 'pmAmount', label: 'PM',   defaultValue: 0,   min: -1,   max: 1,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'wavetable-vco', {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Build table + ship it to the worklet (transfer the buffer).
    const table = generateBasicTable();
    const buf = table.buffer;
    workletNode.port.postMessage(
      { type: 'load', table: buf, frameSize: FRAME_SIZE, frameCount: FRAME_COUNT },
      [buf]
    );

    // Apply initial param values.
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of wavetableVcoDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',   { node: workletNode, input: 0 }],
        ['fm',      { node: workletNode, input: 1 }],
        ['wavePos', { node: workletNode, input: 2 }],
        ['pm',      { node: workletNode, input: 3 }],
        // CV → AudioParam fast-path; engine sums the scaled CV into these AudioParams.
        ['tune',     { node: workletNode, input: 0, param: params.get('tune')!     }],
        ['fine',     { node: workletNode, input: 0, param: params.get('fine')!     }],
        ['fmAmount', { node: workletNode, input: 0, param: params.get('fmAmount')! }],
        ['pmAmount', { node: workletNode, input: 0, param: params.get('pmAmount')! }],
      ]),
      outputs: new Map([['audio', { node: workletNode, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        workletNode.disconnect();
      },
    };
  },
};
