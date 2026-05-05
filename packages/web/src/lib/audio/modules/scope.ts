// packages/web/src/lib/audio/modules/scope.ts
//
// Scope — 2-channel passthrough oscilloscope. Plain JS (GainNode passthrough +
// AnalyserNode for waveform sampling). The card reads the analyser data via
// the engine's read(node, 'snapshot') interface.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export interface ScopeSnapshot {
  ch1: Float32Array;
  ch2: Float32Array;
  sampleRate: number;
}

export const scopeDef: AudioModuleDef = {
  type: 'scope',
  domain: 'audio',
  label: 'Scope',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    { id: 'ch1', type: 'audio' },
    { id: 'ch2', type: 'audio' },
  ],
  outputs: [
    { id: 'ch1_out', type: 'audio' },
    { id: 'ch2_out', type: 'audio' },
  ],
  // Most params are display-only (the audio passthrough is unchanged regardless
  // of scale/offset/mode). The factory's setParam ignores them; the card reads
  // them straight from patch.nodes[id].params.
  params: [
    { id: 'timeMs',    label: 'Time',  defaultValue: 20, min: 1,    max: 200, curve: 'log',      units: 'ms' },
    { id: 'ch1Scale',  label: 'Ch1 Sc', defaultValue: 1,  min: 0.1,  max: 10,  curve: 'log' },
    { id: 'ch1Offset', label: 'Ch1 Y',  defaultValue: 0,  min: -1,   max: 1,   curve: 'linear' },
    { id: 'ch2Scale',  label: 'Ch2 Sc', defaultValue: 1,  min: 0.1,  max: 10,  curve: 'log' },
    { id: 'ch2Offset', label: 'Ch2 Y',  defaultValue: 0,  min: -1,   max: 1,   curve: 'linear' },
    // 0 = split (two stacked traces), 1 = XY (ch1 vs ch2 plot).
    { id: 'mode',      label: 'XY',    defaultValue: 0,  min: 0,    max: 1,   curve: 'discrete' },
  ],

  async factory(ctx, _node): Promise<AudioDomainNodeHandle> {
    // Per channel: input → gain (passthrough) → output, with a tap to analyser.
    const gain1 = ctx.createGain();
    const gain2 = ctx.createGain();
    const analyser1 = ctx.createAnalyser();
    const analyser2 = ctx.createAnalyser();
    analyser1.fftSize = 2048;
    analyser2.fftSize = 2048;
    analyser1.smoothingTimeConstant = 0;
    analyser2.smoothingTimeConstant = 0;
    gain1.connect(analyser1);
    gain2.connect(analyser2);
    // Note: we don't connect analyser → anywhere; it's a sink that buffers samples.

    const buf1 = new Float32Array(analyser1.fftSize);
    const buf2 = new Float32Array(analyser2.fftSize);

    return {
      domain: 'audio',
      // gain1 and gain2 each act as both the input AND output for their channel
      // — Web Audio happily routes signal through a GainNode, and we tap a
      // separate analyser off it for visualization.
      inputs: new Map([
        ['ch1', { node: gain1, input: 0 }],
        ['ch2', { node: gain2, input: 0 }],
      ]),
      outputs: new Map([
        ['ch1_out', { node: gain1, output: 0 }],
        ['ch2_out', { node: gain2, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // Time knob is read-only by the card; nothing to set on the audio path.
      },
      readParam(_paramId) {
        return undefined;
      },
      read(key) {
        if (key === 'snapshot') {
          analyser1.getFloatTimeDomainData(buf1);
          analyser2.getFloatTimeDomainData(buf2);
          return {
            ch1: buf1,
            ch2: buf2,
            sampleRate: ctx.sampleRate,
          } satisfies ScopeSnapshot;
        }
        return undefined;
      },
      dispose() {
        gain1.disconnect();
        gain2.disconnect();
        analyser1.disconnect();
        analyser2.disconnect();
      },
    };
  },
};
