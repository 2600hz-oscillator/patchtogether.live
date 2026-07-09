<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { illogicDef } from '$lib/audio/modules/illogic';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(illogicDef, () => id, () => node);

  let att1 = $derived(node?.params.att1_amount ?? illogicDef.params[0]!.defaultValue);
  let att2 = $derived(node?.params.att2_amount ?? illogicDef.params[1]!.defaultValue);
  let att3 = $derived(node?.params.att3_amount ?? illogicDef.params[2]!.defaultValue);
  let att4 = $derived(node?.params.att4_amount ?? illogicDef.params[3]!.defaultValue);


  const inputs = portsFromDef(illogicDef.inputs);
  const outputs = portsFromDef(illogicDef.outputs);
</script>

<div class="mod-card illogic-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="ILLOGIC" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={att1} min={-1} max={1} defaultValue={1} label="Att1" curve="linear" onchange={set('att1_amount')} moduleId={id} paramId="att1_amount" readLive={live('att1_amount')} />
      <Fader value={att2} min={-1} max={1} defaultValue={1} label="Att2" curve="linear" onchange={set('att2_amount')} moduleId={id} paramId="att2_amount" readLive={live('att2_amount')} />
      <Fader value={att3} min={-1} max={1} defaultValue={1} label="Att3" curve="linear" onchange={set('att3_amount')} moduleId={id} paramId="att3_amount" readLive={live('att3_amount')} />
      <Fader value={att4} min={-1} max={1} defaultValue={1} label="Att4" curve="linear" onchange={set('att4_amount')} moduleId={id} paramId="att4_amount" readLive={live('att4_amount')} />
    </div>
  </PatchPanel>
</div>

<style>
  .illogic-card { width: 240px; }
  .illogic-card .fader-row { padding: 0 14px; margin-top: 16px; }
</style>
