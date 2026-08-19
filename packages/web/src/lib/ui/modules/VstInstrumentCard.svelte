<script lang="ts">
  // VST INSTRUMENT card — plays one of the user's installed instrument
  // plugins (AU) through the vst-bridge helper. All bridge UI lives in the
  // shared VstBridgePanel; this card contributes the tidyVco-shaped ports
  // (poly/pitch/gate/vel in, stereo out) that make lane drops + clip
  // auto-wiring work with zero wiring code.
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import VstBridgePanel from './VstBridgePanel.svelte';
  import { vstInstrumentDef } from '$lib/audio/modules/vst-instrument';
  import type { ModuleNode } from '$lib/graph/types';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { engineCtx } = cardParams(vstInstrumentDef, () => id, () => node);

  /** The engine's AudioContext rate — a reconnect must hello at the SAME
   *  rate the worklet runs at (the bridge renders at hello.rate). */
  function sampleRate(): number {
    const e = engineCtx.get();
    const audio = e?.getDomain?.('audio') as { ctx?: AudioContext } | undefined;
    return audio?.ctx?.sampleRate ?? 48000;
  }

  const inputs = portsFromDef(vstInstrumentDef.inputs, {
    poly: 'POLY', pitch: 'V/OCT', gate: 'GATE', vel: 'VEL',
  });
  const outputs = portsFromDef(vstInstrumentDef.outputs, {
    out_l: 'OUT L', out_r: 'OUT R',
  });
</script>

<div class="mod-card vst-instrument-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="VST INSTRUMENT" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <VstBridgePanel {id} kinds={['instrument', 'generator', 'musicEffect']} {sampleRate} />
  </PatchPanel>
</div>

<style>
  .vst-instrument-card { position: relative; }
  .stripe { position: absolute; inset: 0 auto 0 0; width: 4px; border-radius: 2px 0 0 2px; }
</style>
