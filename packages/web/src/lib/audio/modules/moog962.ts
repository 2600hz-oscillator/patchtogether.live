// packages/web/src/lib/audio/modules/moog962.ts
//
// MOOG 962 SEQUENTIAL SWITCH — Moog System 55 clone (batch 5 utility
// cluster). A gate-advanced signal selector: up to three signal inputs
// (in1..in3) feed a single output (out), and a rising edge on the SHIFT gate
// steps the selector to the next input (1→2→3→1, or 1↔2 when STAGES=2). This
// is the 4PLEXER's gate-advanced selector trimmed to 3-in / 1-out.
//
// Signal ports are declared `cv` so the CV family (cv / pitch / gate) is
// first-class in the patch-to menu; the underlying Web Audio substrate is
// identical for audio + cv, so an AUDIO cable patches in (and routes) just the
// same — the engine connects node→node regardless of cable type (see the
// routing note in fourplexer.ts).
//
// DSP lives in packages/dsp/src/moog962.ts (custom JS AudioWorklet) wrapping
// the pure, unit-tested Moog962Switch in packages/dsp/src/lib/moog962-dsp.ts.
//
// Inputs:
//   in1..in3 (cv): three signal inputs (audio routes identically via the engine).
//   shift (gate): rising edge advances the selector to the next input.
//
// Outputs:
//   out (cv): carries the currently-selected input.
//
// Params:
//   stages (discrete 2..3, default 3): how many inputs to cycle through.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog962.js?url';

const PROCESSOR_NAME = 'moog962';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog962Def: AudioModuleDef = {
  type: 'moog962',
  palette: { top: 'Clones', sub: 'moogafakkin' },
  card: 'Moog962Card',
  domain: 'audio',
  label: 'moogafakkin 962 Seq Switch',
  // 'utilities' to bucket alongside the sibling Moog routing/utility modules
  // (CP3 / 902 / 961 / 984 / 994 / 995) in the palette tree.
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    // Signal inputs — audio OR cv route identically through the engine.
    { id: 'in1',   type: 'cv' },
    { id: 'in2',   type: 'cv' },
    { id: 'in3',   type: 'cv' },
    // SHIFT advance gate — rising edge steps the selector.
    { id: 'shift', type: 'gate' },
  ],
  outputs: [
    { id: 'out', type: 'cv' },
  ],
  params: [
    // STAGES — how many inputs to cycle through. Discrete 2..3 (UI shows the
    // raw count). Default 3 = full 1→2→3→1 rotation.
    { id: 'stages', label: 'Stages', defaultValue: 3, min: 2, max: 3, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Feed silence into every input so the node stays in the active processing
    // graph even when nothing's externally patched (mirrors the 921 VCO /
    // CP3 silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 4; i++) silence.connect(workletNode, 0, i);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog962Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in1',   { node: workletNode, input: 0 }],
        ['in2',   { node: workletNode, input: 1 }],
        ['in3',   { node: workletNode, input: 2 }],
        ['shift', { node: workletNode, input: 3 }],
      ]),
      outputs: new Map([
        ['out', { node: workletNode, output: 0 }],
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
