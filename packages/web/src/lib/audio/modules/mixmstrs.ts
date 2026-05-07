// packages/web/src/lib/audio/modules/mixmstrs.ts
//
// MIXMSTRS — 4-channel stereo mixer with EQ, compressor, two stereo aux sends,
// two stereo returns. Singleton per rackspace (`maxInstances: 1`).
//
// 12 audio inputs (4 ch × stereo + 2 returns × stereo) + 6 audio outputs
// (master L/R + send1 L/R + send2 L/R). 37 AudioParams.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamDef, PortDef } from '$lib/graph/types';
import wasmUrl from '@patchtogether.live/dsp/dist/mixmstrs.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/mixmstrs.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/mixmstrs.worklet.js?url';

const PARAM_PREFIX = '/MIXMSTRS';

// Build the 37-param schema programmatically — 9 controls per channel ×
// 4 channels + 1 master.
function buildParams(): readonly ParamDef[] {
  const params: ParamDef[] = [];
  for (const ch of [1, 2, 3, 4]) {
    params.push({ id: `ch${ch}_volume`,      label: `${ch}V`,   defaultValue: 0.8, min: 0,    max: 1,   curve: 'linear' });
    params.push({ id: `ch${ch}_low`,         label: `${ch}Lo`,  defaultValue: 0,   min: -12,  max: 12,  curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_mid`,         label: `${ch}Md`,  defaultValue: 0,   min: -12,  max: 12,  curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_high`,        label: `${ch}Hi`,  defaultValue: 0,   min: -12,  max: 12,  curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_thresh`,      label: `${ch}Th`,  defaultValue: -12, min: -36,  max: 0,   curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_ratio`,       label: `${ch}Rt`,  defaultValue: 2,   min: 1,    max: 10,  curve: 'linear' });
    params.push({ id: `ch${ch}_compEnable`,  label: `${ch}Cp`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'discrete' });
    params.push({ id: `ch${ch}_send1`,       label: `${ch}S1`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' });
    params.push({ id: `ch${ch}_send2`,       label: `${ch}S2`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' });
  }
  params.push({ id: 'master_volume', label: 'Master', defaultValue: 0.8, min: 0, max: 1, curve: 'linear' });
  return params;
}

const PARAMS = buildParams();

// Inputs: 12 audio + 37 paramTarget CV inputs.
function buildInputs(): PortDef[] {
  const inputs: PortDef[] = [
    { id: 'ch1L', type: 'audio' }, { id: 'ch1R', type: 'audio' },
    { id: 'ch2L', type: 'audio' }, { id: 'ch2R', type: 'audio' },
    { id: 'ch3L', type: 'audio' }, { id: 'ch3R', type: 'audio' },
    { id: 'ch4L', type: 'audio' }, { id: 'ch4R', type: 'audio' },
    { id: 'ret1L', type: 'audio' }, { id: 'ret1R', type: 'audio' },
    { id: 'ret2L', type: 'audio' }, { id: 'ret2R', type: 'audio' },
  ];
  for (const p of PARAMS) {
    inputs.push({ id: p.id, type: 'cv', paramTarget: p.id });
  }
  return inputs;
}

export const mixmstrsDef: AudioModuleDef = {
  type: 'mixmstrs',
  domain: 'audio',
  label: 'MIXMSTRS',
  category: 'utilities',
  schemaVersion: 1,
  maxInstances: 1,
  stereoPairs: [
    ['ch1L', 'ch1R'],
    ['ch2L', 'ch2R'],
    ['ch3L', 'ch3R'],
    ['ch4L', 'ch4R'],
    ['ret1L', 'ret1R'],
    ['ret2L', 'ret2R'],
  ],

  inputs: buildInputs(),
  outputs: [
    { id: 'masterL', type: 'audio' },
    { id: 'masterR', type: 'audio' },
    { id: 'send1L',  type: 'audio' },
    { id: 'send1R',  type: 'audio' },
    { id: 'send2L',  type: 'audio' },
    { id: 'send2R',  type: 'audio' },
  ],
  params: PARAMS,

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'mixmstrs', wasmUrl, metaUrl, workletUrl });

    // 12 mono audio inputs into the Faust worklet (channel-merger of 12).
    // The Faust process() takes 12 args in the same order our inputs declare.
    const merger = ctx.createChannelMerger(12);
    merger.connect(f);
    // Silence keeps each channel active even with nothing patched in.
    const silenceSources: ConstantSourceNode[] = [];
    for (let i = 0; i < 12; i++) {
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(merger, 0, i);
      silenceSources.push(sil);
    }

    // Output splitter: 6 outputs (masterL/R, send1L/R, send2L/R).
    const splitter = ctx.createChannelSplitter(6);
    f.connect(splitter);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of PARAMS) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }

    // Build inputs map: 12 audio at fixed indices, 37 CV-targets per param.
    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    const audioInPorts = ['ch1L','ch1R','ch2L','ch2R','ch3L','ch3R','ch4L','ch4R','ret1L','ret1R','ret2L','ret2R'];
    audioInPorts.forEach((id, i) => {
      inputsMap.set(id, { node: merger, input: i });
    });
    for (const p of PARAMS) {
      const ap = params.get(`${PARAM_PREFIX}/${p.id}`);
      if (ap) inputsMap.set(p.id, { node: f, input: 0, param: ap });
    }

    const outputsMap = new Map<string, { node: AudioNode; output: number }>();
    ['masterL','masterR','send1L','send1R','send2L','send2R'].forEach((id, i) => {
      outputsMap.set(id, { node: splitter, output: i });
    });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: outputsMap,
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        for (const s of silenceSources) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        merger.disconnect();
        splitter.disconnect();
        f.disconnect();
      },
    };
  },
};
