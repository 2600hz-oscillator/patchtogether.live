// packages/web/src/lib/audio/modules/analog-vco.ts
import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@inet.modular/dsp/dist/analog-vco.wasm?url';
import metaUrl from '@inet.modular/dsp/dist/analog-vco.json?url';

const PARAM_PREFIX = '/Analog_VCO';

export const analogVcoDef: AudioModuleDef = {
  type: 'analogVco',
  domain: 'audio',
  label: 'Analog VCO',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'fm', type: 'audio' },
  ],
  outputs: [
    { id: 'saw',      type: 'audio' },
    { id: 'square',   type: 'audio' },
    { id: 'triangle', type: 'audio' },
    { id: 'sine',     type: 'audio' },
  ],
  params: [
    { id: 'tune', label: 'Tune', defaultValue: 0,   min: -36, max: 36, curve: 'linear', units: 'semi' },
    { id: 'fine', label: 'Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: 'cent' },
    { id: 'fmAmount', label: 'FM', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'pw',       label: 'PW', defaultValue: 0.5, min: 0.05, max: 0.95, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const faustNode = await instantiateFaustModule(ctx, { name: 'analog-vco', wasmUrl, metaUrl });

    // ChannelMerger routes per-port mono signals to distinct channels of
    // Faust's single multi-channel input. This is what makes sequencer.pitch
    // affect ONLY the pitch channel without bleeding into fm.
    const merger = ctx.createChannelMerger(2);
    merger.connect(faustNode);
    // Feed silence to every merger input so the node stays in the active
    // processing graph even when nothing's externally patched. Without this,
    // a fresh module (no inputs connected) doesn't process and there's no audio.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);

    // Splitter for the 4-channel output (saw / square / triangle / sine).
    const splitter = ctx.createChannelSplitter(4);
    faustNode.connect(splitter);

    const params = faustNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of analogVcoDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch', { node: merger, input: 0 }],
        ['fm',    { node: merger, input: 1 }],
      ]),
      outputs: new Map([
        ['saw',      { node: splitter, output: 0 }],
        ['square',   { node: splitter, output: 1 }],
        ['triangle', { node: splitter, output: 2 }],
        ['sine',     { node: splitter, output: 3 }],
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
        faustNode.disconnect();
        splitter.disconnect();
      },
    };
  },
};
