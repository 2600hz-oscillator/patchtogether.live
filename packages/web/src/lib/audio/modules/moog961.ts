// packages/web/src/lib/audio/modules/moog961.ts
//
// MOOG 961 INTERFACE — trigger/gate format converter (Moog System 55 clone,
// batch 5). The 961 bridges S-trigger (switch) and V-trigger (voltage) formats
// between a Moog modular and the outside world. In OUR graph every trigger is a
// plain `gate` cable, so polarity is COSMETIC — we model only the TIMING
// behaviours. The conversion DSP lives in the worklet
// (packages/dsp/src/moog961.ts → dist/moog961.js), built on the pure +
// unit-tested ./lib/trigger-convert-dsp.ts.
//
// Circuits (see the lib header for per-circuit detail):
//   (1) audio_in level over `sensitivity` → fire v_out1 AND v_out2 (rising-
//       edge on the rectified audio crossing the threshold).
//   (2) s_in passes straight through onto v_out1 AND v_out2 (format
//       passthrough — an external trigger drives the same V outs).
//   (3) v_in_a → s_out_a, the gate passed through with its INPUT width.
//   (4) v_in_b → s_out_b as a FIXED-WIDTH one-shot of `switchOnTime` seconds
//       on each rising edge (the column-B "switch-on time" pulse).
//
// CV-style inputs: s_in / v_in_a / v_in_b are GATE inputs (the signals being
// converted, not knob modulators), so they're plain node connections — no
// cvScale / paramTarget (PASSTHROUGH_BY_DESIGN, same shape as FLIPPER.in1).
// audio_in is an audio signal feeding the level detector.
//
// Inputs:  audio_in (audio), s_in (gate), v_in_a (gate), v_in_b (gate).
// Outputs: v_out1 (gate), v_out2 (gate), s_out_a (gate), s_out_b (gate).
// Params:  sensitivity (linear 0..1 default 0.5), switchOnTime (log 0.04..4s
//          default 0.2).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog961.js?url';

const PROCESSOR_NAME = 'moog961';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog961Def: AudioModuleDef = {
  type: 'moog961',
  palette: { top: 'Clones', sub: 'moogafakkin' },
  card: 'Moog961Card',
  domain: 'audio',
  label: 'moogafakkin 961 Interface',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    { id: 'audio_in', type: 'audio' },
    // Gate inputs — the signals being format-converted, not knob modulators
    // (PASSTHROUGH_BY_DESIGN: no cvScale / paramTarget, like FLIPPER's gates).
    { id: 's_in',     type: 'gate' },
    { id: 'v_in_a',   type: 'gate' },
    { id: 'v_in_b',   type: 'gate' },
  ],
  outputs: [
    { id: 'v_out1',   type: 'gate' },
    { id: 'v_out2',   type: 'gate' },
    { id: 's_out_a',  type: 'gate' },
    { id: 's_out_b',  type: 'gate' },
  ],
  params: [
    // sensitivity — audio→trigger threshold (linear 0..1).
    { id: 'sensitivity',  label: 'Sensitivity',     defaultValue: 0.5, min: 0,    max: 1, curve: 'linear' },
    // switchOnTime — column-B fixed pulse width in seconds (log fader).
    { id: 'switchOnTime', label: 'Switch-On Time',  defaultValue: 0.2, min: 0.04, max: 4, curve: 'log', units: 's' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 4 inputs (audio_in, s_in, v_in_a, v_in_b) → 4 gate outputs, 1 ch each.
    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 4,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    // Feed silence into input 0 so the node stays in the active processing
    // graph even when nothing is externally patched (mirrors the FLIPPER /
    // 921 VCO silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog961Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio_in', { node: workletNode, input: 0 }],
        ['s_in',     { node: workletNode, input: 1 }],
        ['v_in_a',   { node: workletNode, input: 2 }],
        ['v_in_b',   { node: workletNode, input: 3 }],
      ]),
      outputs: new Map([
        ['v_out1',  { node: workletNode, output: 0 }],
        ['v_out2',  { node: workletNode, output: 1 }],
        ['s_out_a', { node: workletNode, output: 2 }],
        ['s_out_b', { node: workletNode, output: 3 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
