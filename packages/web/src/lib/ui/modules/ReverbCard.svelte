<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { reverbDef } from '$lib/audio/modules/reverb';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(reverbDef, () => id, () => node);

  let size = $derived(node?.params.size ?? reverbDef.params[0]!.defaultValue);
  let damp = $derived(node?.params.damp ?? reverbDef.params[1]!.defaultValue);
  let mix  = $derived(node?.params.mix  ?? reverbDef.params[2]!.defaultValue);


  const inputs = portsFromDef(reverbDef.inputs, { audio: 'IN' });
  const outputs = portsFromDef(reverbDef.outputs, { audio: 'OUT' });
</script>

<div class="mod-card reverb-card">
  <div class="stripe" style="background: var(--cable-pitch);"></div>
  <ModuleTitle {id} {data} defaultLabel="Reverb" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={size} min={0} max={1} defaultValue={0.5} label="Size" curve="linear" onchange={set('size')} moduleId={id} paramId="size" readLive={live('size')} />
      <Fader value={damp} min={0} max={1} defaultValue={0.3} label="Damp" curve="linear" onchange={set('damp')} moduleId={id} paramId="damp" readLive={live('damp')} />
      <Fader value={mix}  min={0} max={1} defaultValue={0.3} label="Mix"  curve="linear" onchange={set('mix')} moduleId={id} paramId="mix"  readLive={live('mix')} />
    </div>
  </PatchPanel>
</div>

<style>
  .reverb-card { width: 200px; }
  .reverb-card .fader-row { margin-top: 14px; padding: 0 18px; }
</style>
