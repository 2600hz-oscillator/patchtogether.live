// packages/web/src/lib/audio/modules/plaits-fm.ts
//
// Module def for PlaitsFM — the 2-op FM engine from Mutable Instruments'
// Plaits, vendored under packages/dsp/vendor/plaits and compiled to
// dist/plaits.wasm by `flox activate -- task dsp:build:plaits`.
//
// This is the first module in a planned multi-engine Plaits family
// (Modal, Granular, Speech, String, Chord, Additive, ...). The wasm + the
// processor TS are engine-id-parameterized — adding a future engine is a
// new module-def file plus a `case` in worklet.cc.
//
// User-facing macro labels match Plaits' FM engine documentation:
//   harmonics → Ratio (carrier:modulator frequency)
//   timbre    → Index (FM modulation depth)
//   morph     → Feedback (negative phase-feedback, positive amplitude-feedback)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/plaits.worklet.js?url';

const ENGINE_FM = 9;

const loadedContexts = new WeakSet<BaseAudioContext>();

export const plaitsFmDef: AudioModuleDef = {
  type: 'plaitsFm',
  domain: 'audio',
  label: 'PlaitsFM',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    { id: 'pitch',   type: 'pitch' },
    { id: 'trigger', type: 'gate' },
  ],
  outputs: [
    { id: 'audio', type: 'audio' },
    // The aux output carries Plaits' free sub-octave signal. Patch it or
    // leave it unconnected — both are valid.
    { id: 'sub',   type: 'audio' },
  ],
  params: [
    { id: 'note',      label: 'Note',     defaultValue: 60,  min: 0,   max: 127, curve: 'linear', units: 'st' },
    { id: 'harmonics', label: 'Ratio',    defaultValue: 0.5, min: 0,   max: 1,   curve: 'linear' },
    { id: 'timbre',    label: 'Index',    defaultValue: 0.5, min: 0,   max: 1,   curve: 'linear' },
    { id: 'morph',     label: 'Feedback', defaultValue: 0.5, min: 0,   max: 1,   curve: 'linear' },
    { id: 'level',     label: 'Level',    defaultValue: 1,   min: 0,   max: 1,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      try {
        await ctx.audioWorklet.addModule(workletUrl);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          '[plaits-fm] failed to load worklet — has dist/plaits.worklet.js been built?\n' +
            '  Run: flox activate -- task dsp:build:plaits',
          err,
        );
        throw err;
      }
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'plaits', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
      processorOptions: { engineId: ENGINE_FM },
    });

    // Surface worklet boot errors (wasm load failures, base64 decode bugs,
    // etc.) to the main thread; AudioWorkletGlobalScope's console isn't
    // forwarded reliably across browsers.
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; error?: string };
      if (m?.type === 'plaits-error') {
        // eslint-disable-next-line no-console
        console.error('[plaits-fm] worklet error:', m.error);
      }
    };

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of plaitsFmDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',   { node: workletNode, input: 0 }],
        ['trigger', { node: workletNode, input: 1 }],
      ]),
      outputs: new Map([
        ['audio', { node: workletNode, output: 0 }],
        ['sub',   { node: workletNode, output: 1 }],
      ]),
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
