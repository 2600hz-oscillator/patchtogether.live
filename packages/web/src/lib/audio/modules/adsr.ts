import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/adsr.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/adsr.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/adsr.worklet.js?url';

const PARAM_PREFIX = '/ADSR';

export const adsrDef: AudioModuleDef = {
  type: 'adsr',
  domain: 'audio',
  label: 'ADSR',
  category: 'modulation',
  schemaVersion: 1,
  inputs: [
    { id: 'gate',    type: 'gate' },
    // CV inputs route directly to the corresponding AudioParam (sums into
    // the param's intrinsic value at audio rate). Patch an LFO here to wobble
    // the envelope shape over time; the corresponding fader's motorized poll
    // tracks the modulated value.
    { id: 'attack',  type: 'cv', paramTarget: 'attack'  },
    { id: 'decay',   type: 'cv', paramTarget: 'decay'   },
    { id: 'sustain', type: 'cv', paramTarget: 'sustain' },
    { id: 'release', type: 'cv', paramTarget: 'release' },
  ],
  outputs: [
    { id: 'env',     type: 'cv' },
    // Inverted envelope: 1 - env. Standard Eurorack semantic for unipolar
    // envelopes — ducking, reverse-modulation, "sidechain"-style ADSR.
    // Implemented as ConstantSource(+1) + GainNode(-1)·env, summed.
    { id: 'env_inv', type: 'cv' },
  ],
  params: [
    { id: 'attack',  label: 'A', defaultValue: 0.005, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'decay',   label: 'D', defaultValue: 0.1,   min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'sustain', label: 'S', defaultValue: 0.7,   min: 0,     max: 1,  curve: 'linear' },
    { id: 'release', label: 'R', defaultValue: 0.3,   min: 0.001, max: 10, curve: 'log', units: 's' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'adsr', wasmUrl, metaUrl, workletUrl });
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of adsrDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pAttack  = params.get(`${PARAM_PREFIX}/attack`);
    const pDecay   = params.get(`${PARAM_PREFIX}/decay`);
    const pSustain = params.get(`${PARAM_PREFIX}/sustain`);
    const pRelease = params.get(`${PARAM_PREFIX}/release`);

    // ----- env_inv: 1 - env -----
    // Build (one + neg(env)) via two GainNodes sharing a sum bus.
    //   one    = ConstantSource(+1) → invBus (gain 1)
    //   negEnv = env (Faust output) → GainNode(-1) → invBus (gain 1)
    //   invBus output = 1 + (-env) = 1 - env  (clamped to 0..1 since env ∈ [0, 1])
    //
    // The ConstantSource lives for the lifetime of the module. invBus's
    // output is registered as the env_inv source.
    const oneSrc = ctx.createConstantSource();
    oneSrc.offset.value = 1;
    oneSrc.start();
    const invBus = ctx.createGain();
    invBus.gain.value = 1;
    const negEnv = ctx.createGain();
    negEnv.gain.value = -1;
    oneSrc.connect(invBus);
    f.connect(negEnv);
    negEnv.connect(invBus);

    return {
      domain: 'audio',
      inputs: new Map([
        ['gate',    { node: f, input: 0 }],
        // CV → AudioParam routing. The engine recognizes `param` and uses
        // sout.node.connect(param) instead of node-to-node.
        ['attack',  { node: f, input: 0, param: pAttack! }],
        ['decay',   { node: f, input: 0, param: pDecay! }],
        ['sustain', { node: f, input: 0, param: pSustain! }],
        ['release', { node: f, input: 0, param: pRelease! }],
      ]),
      outputs: new Map([
        ['env',     { node: f,      output: 0 }],
        ['env_inv', { node: invBus, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { oneSrc.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        oneSrc.disconnect();
        invBus.disconnect();
        negEnv.disconnect();
        f.disconnect();
      },
    };
  },
};
