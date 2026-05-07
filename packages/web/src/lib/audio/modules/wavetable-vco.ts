// packages/web/src/lib/audio/modules/wavetable-vco.ts
//
// Module def for the Wavetable VCO. The DSP is a custom JS AudioWorklet
// (packages/dsp/src/wavetable-vco.ts). The factory generates a synthetic
// 16-frame "basic" wavetable that morphs saw → square → triangle → sine
// and loads it into the worklet via port.postMessage on instantiation.

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
  domain: 'audio',
  label: 'Wavetable VCO',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    { id: 'pitch',   type: 'pitch' },
    { id: 'fm',      type: 'audio' },
    { id: 'wavePos', type: 'cv' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'tune',     label: 'Tune', defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',     label: 'Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'wavePos',  label: 'Wave', defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'fmAmount', label: 'FM',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'wavetable-vco', {
      numberOfInputs: 3,
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
