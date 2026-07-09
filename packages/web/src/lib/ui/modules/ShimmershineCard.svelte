<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { shimmershineDef } from '$lib/audio/modules/shimmershine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(shimmershineDef, () => id, () => node);

  let decay   = $derived(node?.params.decay   ?? shimmershineDef.params[0]!.defaultValue);
  let shimmer = $derived(node?.params.shimmer ?? shimmershineDef.params[1]!.defaultValue);
  let size    = $derived(node?.params.size    ?? shimmershineDef.params[2]!.defaultValue);
  let damp    = $derived(node?.params.damp    ?? shimmershineDef.params[3]!.defaultValue);
  let mix     = $derived(node?.params.mix     ?? shimmershineDef.params[4]!.defaultValue);


  const inputs = portsFromDef(shimmershineDef.inputs);
  const outputs = portsFromDef(shimmershineDef.outputs);
</script>

<div class="mod-card shimmershine-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SHIMMERSHINE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={decay}   min={0} max={1} defaultValue={0.6} label="Decay"   curve="linear" onchange={set('decay')} moduleId={id} paramId="decay"   readLive={live('decay')} />
      <Fader value={shimmer} min={0} max={1} defaultValue={0.4} label="Shimmer" curve="linear" onchange={set('shimmer')} moduleId={id} paramId="shimmer" readLive={live('shimmer')} />
      <Fader value={size}    min={0} max={1} defaultValue={0.6} label="Size"    curve="linear" onchange={set('size')} moduleId={id} paramId="size"    readLive={live('size')} />
      <Fader value={damp}    min={0} max={1} defaultValue={0.4} label="Damp"    curve="linear" onchange={set('damp')} moduleId={id} paramId="damp"    readLive={live('damp')} />
      <Fader value={mix}     min={0} max={1} defaultValue={0.4} label="Mix"     curve="linear" onchange={set('mix')} moduleId={id} paramId="mix"     readLive={live('mix')} />
    </div>
  </PatchPanel>
</div>

<style>
  .shimmershine-card { width: 280px; }  .shimmershine-card .fader-row {
    margin-top: 14px;
    display: flex;
    justify-content: center;
    gap: 12px;
    padding: 0 18px;
  }
</style>
