// packages/web/src/lib/audio/modules/fourplexer.ts
//
// 4PLEXER — 4-in / 4-out discrete signal router.
//
// Four signal inputs (in1..in4) and four signal outputs (out1..out4). Each
// OUTPUT has its own selector (sel1..sel4) choosing which ONE of the four
// inputs that output carries — discrete, never a blend. Each output also
// has its own GATE input (gate1..gate4): each rising edge advances that
// output's selector to the next input (1→2→3→4→1, wrapping).
//
// Signal ports are declared `cv` so the CV family (cv / pitch / gate) is
// first-class in the patch-to menu; the underlying Web Audio substrate is
// identical for audio + cv, so an AUDIO cable patches in (and routes) just
// the same — the engine connects node→node regardless of cable type, and
// the drag-connect path doesn't gate on canConnect. (See the routing note
// in the PR / docs: there is no single cable type the patch-to cascade
// accepts from BOTH an audio and a cv source, so we pick the lowest-common-
// denominator `cv` and rely on the engine routing audio identically.)
//
// DSP lives in packages/dsp/src/fourplexer.ts (custom JS AudioWorklet).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { fourplexerClampSelector } from '$lib/audio/fourplexer-select';
import workletUrl from '@patchtogether.live/dsp/dist/fourplexer.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

interface SelMessage {
  type: 'sel';
  out: number; // 0..3
  idx: number; // 0..3
}

export const fourplexerDef: AudioModuleDef = {
  type: 'fourplexer',
  domain: 'audio',
  label: '4PLEXER',
  category: 'utility',
  schemaVersion: 1,
  inputs: [
    // Signal inputs — audio OR cv route identically through the engine.
    { id: 'in1',   type: 'cv' },
    { id: 'in2',   type: 'cv' },
    { id: 'in3',   type: 'cv' },
    { id: 'in4',   type: 'cv' },
    // One gate per output selector. Rising edge advances that selector.
    { id: 'gate1', type: 'gate' },
    { id: 'gate2', type: 'gate' },
    { id: 'gate3', type: 'gate' },
    { id: 'gate4', type: 'gate' },
  ],
  outputs: [
    { id: 'out1', type: 'cv' },
    { id: 'out2', type: 'cv' },
    { id: 'out3', type: 'cv' },
    { id: 'out4', type: 'cv' },
  ],
  params: [
    // Selector per output. Discrete 0..3 (UI shows 1..4). Defaults make a
    // pass-through router: out1=in1, out2=in2, out3=in3, out4=in4.
    { id: 'sel1', label: 'OUT 1', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
    { id: 'sel2', label: 'OUT 2', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
    { id: 'sel3', label: 'OUT 3', defaultValue: 2, min: 0, max: 3, curve: 'discrete' },
    { id: 'sel4', label: 'OUT 4', defaultValue: 3, min: 0, max: 3, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'fourplexer', {
      numberOfInputs: 8,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of fourplexerDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(fourplexerClampSelector(v), ctx.currentTime);
    }

    // Gate-advanced selections are posted back from the worklet so the new
    // selector index persists in node params (synced + saved) exactly like
    // a UI click. We mirror the worklet's index into livePatch.
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as SelMessage | undefined;
      if (!m || m.type !== 'sel') return;
      const key = `sel${m.out + 1}`;
      const target = livePatch.nodes[node.id];
      if (target && target.params[key] !== m.idx) {
        target.params[key] = fourplexerClampSelector(m.idx);
      }
    };

    return {
      domain: 'audio',
      inputs: new Map([
        ['in1',   { node: workletNode, input: 0 }],
        ['in2',   { node: workletNode, input: 1 }],
        ['in3',   { node: workletNode, input: 2 }],
        ['in4',   { node: workletNode, input: 3 }],
        ['gate1', { node: workletNode, input: 4 }],
        ['gate2', { node: workletNode, input: 5 }],
        ['gate3', { node: workletNode, input: 6 }],
        ['gate4', { node: workletNode, input: 7 }],
      ]),
      outputs: new Map([
        ['out1', { node: workletNode, output: 0 }],
        ['out2', { node: workletNode, output: 1 }],
        ['out3', { node: workletNode, output: 2 }],
        ['out4', { node: workletNode, output: 3 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(fourplexerClampSelector(value), ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { workletNode.port.onmessage = null; } catch { /* ignore */ }
        workletNode.disconnect();
      },
    };
  },
};
