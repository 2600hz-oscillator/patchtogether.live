// packages/web/src/lib/audio/modules/timelorde.ts
//
// TIMELORDE — central time source per rackspace. TS AudioWorklet for
// sample-accurate phase counters. See packages/dsp/src/timelorde.ts.
//
// Singleton: maxInstances = 1. The whole point is "one canonical clock per
// patch"; multiple TIMELORDEs would invite ambiguity over which is the
// master.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/timelorde.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const timelordeDef: AudioModuleDef = {
  type: 'timelorde',
  domain: 'audio',
  label: 'TIMELORDE',
  category: 'modulation',
  schemaVersion: 1,
  maxInstances: 1,

  inputs: [
    // External clock — when patched, snaps 1x to incoming rising edges and
    // measures period for multiplier prediction. Disconnect → falls back
    // to internal BPM after ~2 master periods.
    { id: 'clock', type: 'gate' },
  ],
  outputs: [
    // Order MUST match dsp/timelorde.ts OUT_* indices.
    { id: '1x',    type: 'gate' },
    { id: '4x',    type: 'gate' },
    { id: '2x',    type: 'gate' },
    { id: '1/2',   type: 'gate' },
    { id: '1/3',   type: 'gate' },
    { id: '1/4',   type: 'gate' },
    { id: '1/8',   type: 'gate' },
    { id: '1/12',  type: 'gate' },
    { id: '1/16',  type: 'gate' },
    { id: '1/32',  type: 'gate' },
    { id: '1/64',  type: 'gate' },
    { id: 'swing', type: 'gate' },
  ],
  params: [
    { id: 'bpm',         label: 'BPM',   defaultValue: 120, min: 10, max: 300, curve: 'log',      units: 'bpm' },
    { id: 'swingAmount', label: 'Swing', defaultValue: 0,   min: 0,  max: 90,  curve: 'linear',   units: 'deg' },
    { id: 'swingSource', label: 'Src',   defaultValue: 0,   min: 0,  max: 10,  curve: 'discrete' },
    { id: 'isPlaying',   label: 'Play',  defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete' },
  ],

  // Module-grouping Phase 4 — surface every knob (BPM / Swing / Src) so a
  // containing GROUP! can opt to expose any subset on its bar. The play
  // toggle is intentionally NOT exposable here because TIMELORDE's local
  // play UI hides itself whenever an external clock is patched; the same
  // gating logic would have to be ported into the group bar to avoid
  // surprises. v1 covers knobs only; the button can be added later.
  exposableControls: [
    { id: 'bpm',         label: 'BPM',   kind: 'knob', paramId: 'bpm' },
    { id: 'swingAmount', label: 'Swing', kind: 'knob', paramId: 'swingAmount' },
    { id: 'swingSource', label: 'Src',   kind: 'knob', paramId: 'swingSource' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'timelorde', {
      numberOfInputs: 1,
      numberOfOutputs: 12,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });

    // The worklet's clock input always exists; tests + the engine plug a
    // ConstantSource of silence in so the node sees an active inbound to
    // remain in the graph even when no cable is patched.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of timelordeDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    const bpmParam = params.get('bpm');
    const swAmt = params.get('swingAmount');
    const swSrc = params.get('swingSource');
    const isPlaying = params.get('isPlaying');
    const hasExt = params.get('hasExternalClock');

    const nodeId = node.id;

    // hasExternalClock is reflected from the live patch every ~250 ms so the
    // worklet knows when to honor isPlaying vs force always-on.
    let timer: ReturnType<typeof setInterval> | null = null;
    function syncExternalFlag() {
      let hasEdge = false;
      for (const edge of Object.values(livePatch.edges)) {
        if (!edge) continue;
        if (edge.target.nodeId === nodeId && edge.target.portId === 'clock') {
          hasEdge = true;
          break;
        }
      }
      if (hasExt) hasExt.setValueAtTime(hasEdge ? 1 : 0, ctx.currentTime);
    }
    syncExternalFlag();
    timer = setInterval(syncExternalFlag, 250);

    return {
      domain: 'audio',
      inputs: new Map([
        ['clock', { node: workletNode, input: 0 }],
      ]),
      outputs: new Map([
        ['1x',    { node: workletNode, output: 0 }],
        ['4x',    { node: workletNode, output: 1 }],
        ['2x',    { node: workletNode, output: 2 }],
        ['1/2',   { node: workletNode, output: 3 }],
        ['1/3',   { node: workletNode, output: 4 }],
        ['1/4',   { node: workletNode, output: 5 }],
        ['1/8',   { node: workletNode, output: 6 }],
        ['1/12',  { node: workletNode, output: 7 }],
        ['1/16',  { node: workletNode, output: 8 }],
        ['1/32',  { node: workletNode, output: 9 }],
        ['1/64',  { node: workletNode, output: 10 }],
        ['swing', { node: workletNode, output: 11 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'hasExternalClock') {
          return hasExt?.value ?? 0;
        }
        return undefined;
      },
      dispose() {
        if (timer !== null) clearInterval(timer);
        try { silence.stop(); } catch { /* */ }
        silence.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
