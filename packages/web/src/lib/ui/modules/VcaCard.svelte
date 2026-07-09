<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { vcaDef } from '$lib/audio/modules/vca';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(vcaDef, () => id, () => node);

  let base = $derived(node?.params.base ?? vcaDef.params[0]!.defaultValue);
  let cvAmount = $derived(node?.params.cvAmount ?? vcaDef.params[1]!.defaultValue);


  const inputs = portsFromDef(vcaDef.inputs);
  const outputs = portsFromDef(vcaDef.outputs, { audio_inv: 'AUDIO INV' });
</script>

<div class="mod-card vca-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="VCA" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={base}     min={0}  max={1} defaultValue={0}   label="Base" curve="linear" onchange={set('base')}     readLive={live('base')}     moduleId={id} paramId="base" />
      <Fader value={cvAmount} min={-1} max={1} defaultValue={1.0} label="CV Amt" curve="linear" onchange={set('cvAmount')} readLive={live('cvAmount')} moduleId={id} paramId="cvAmount" />
    </div>
  </PatchPanel>
</div>

<style>
  .vca-card { width: 160px; }
</style>
