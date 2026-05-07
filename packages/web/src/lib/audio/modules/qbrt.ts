import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/qbrt.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/qbrt.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/qbrt.worklet.js?url';

const PARAM_PREFIX = '/QBRT';

export const qbrtDef: AudioModuleDef = {
  type: 'qbrt',
  domain: 'audio',
  label: 'QBRT',
  category: 'filters',
  // v2: added `pingDecay` param + reworked the ping path to vactrol-style
  // (Q boost + click excitation). Loading a v1 save populates pingDecay
  // from default — no migration callback needed.
  schemaVersion: 2,
  inputs: [
    { id: 'L',         type: 'audio' },
    { id: 'R',         type: 'audio' },
    { id: 'ping',      type: 'gate' },
    { id: 'cutoff',    type: 'cv', paramTarget: 'cutoff' },
    { id: 'resonance', type: 'cv', paramTarget: 'resonance' },
    { id: 'mode',      type: 'cv', paramTarget: 'mode' },
    { id: 'pingDecay', type: 'cv', paramTarget: 'pingDecay' },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  params: [
    { id: 'cutoff',    label: 'Cut',  defaultValue: 1000, min: 20,    max: 20000, curve: 'log',    units: 'Hz' },
    { id: 'resonance', label: 'Res',  defaultValue: 0.7,  min: 0,     max: 0.99,  curve: 'linear' },
    { id: 'mode',      label: 'Mode', defaultValue: 0,    min: 0,     max: 1,     curve: 'linear' },
    { id: 'pingDecay', label: 'Ping', defaultValue: 0.15, min: 0.005, max: 0.5,   curve: 'log',    units: 's' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'qbrt', wasmUrl, metaUrl, workletUrl });
    const merger = ctx.createChannelMerger(3);
    merger.connect(f);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);
    silence.connect(merger, 0, 2);

    const splitter = ctx.createChannelSplitter(2);
    f.connect(splitter);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of qbrtDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pCutoff    = params.get(`${PARAM_PREFIX}/cutoff`);
    const pRes       = params.get(`${PARAM_PREFIX}/resonance`);
    const pMode      = params.get(`${PARAM_PREFIX}/mode`);
    const pPingDecay = params.get(`${PARAM_PREFIX}/pingDecay`);

    return {
      domain: 'audio',
      inputs: new Map([
        ['L',         { node: merger, input: 0 }],
        ['R',         { node: merger, input: 1 }],
        ['ping',      { node: merger, input: 2 }],
        ['cutoff',    { node: f, input: 0, param: pCutoff! }],
        ['resonance', { node: f, input: 0, param: pRes! }],
        ['mode',      { node: f, input: 0, param: pMode! }],
        ['pingDecay', { node: f, input: 0, param: pPingDecay! }],
      ]),
      outputs: new Map([
        ['L', { node: splitter, output: 0 }],
        ['R', { node: splitter, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        merger.disconnect();
        f.disconnect();
        splitter.disconnect();
      },
    };
  },
};
