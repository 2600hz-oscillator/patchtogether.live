<script lang="ts">
  // VST FX card — runs one of the user's installed effect plugins (AU) as a
  // stereo insert through the vst-bridge helper. All bridge UI lives in the
  // shared VstBridgePanel; this card contributes the clouds-shaped stereo
  // in/out ports that make lane drops slot it in as an FX insert.
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import VstBridgePanel from './VstBridgePanel.svelte';
  import { vstFxDef } from '$lib/audio/modules/vst-fx';
  import type { ModuleNode } from '$lib/graph/types';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { engineCtx } = cardParams(vstFxDef, () => id, () => node);

  /** The engine's AudioContext rate — a reconnect must hello at the SAME
   *  rate the worklet runs at (the bridge renders at hello.rate). */
  function sampleRate(): number {
    const e = engineCtx.get();
    const audio = e?.getDomain?.('audio') as { ctx?: AudioContext } | undefined;
    return audio?.ctx?.sampleRate ?? 48000;
  }

  const inputs = portsFromDef(vstFxDef.inputs, { in_l: 'IN L', in_r: 'IN R' });
  const outputs = portsFromDef(vstFxDef.outputs, { out_l: 'OUT L', out_r: 'OUT R' });
</script>

<div class="mod-card vst-fx-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="VST FX" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <VstBridgePanel {id} kinds={['effect', 'musicEffect']} {sampleRate} />
  </PatchPanel>
</div>

<style>
  .vst-fx-card { position: relative; }
  .stripe { position: absolute; inset: 0 auto 0 0; width: 4px; border-radius: 2px 0 0 2px; }
</style>
