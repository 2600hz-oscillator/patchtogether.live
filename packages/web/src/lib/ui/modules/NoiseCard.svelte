<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { noiseDef } from '$lib/audio/modules/noise';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(noiseDef, () => id, () => node);

  let level = $derived(node?.params.level ?? noiseDef.params[0]!.defaultValue);


  // No inputs (NOISE is a pure source), three audio outputs.
  const inputs = portsFromDef(noiseDef.inputs);
  const outputs = portsFromDef(noiseDef.outputs);
</script>

<div class="mod-card noise-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="NOISE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={level} min={0} max={1} defaultValue={0.5} label="Level" curve="linear" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
    </div>
  </PatchPanel>
</div>

<style>
  .noise-card { width: 160px; }
  .noise-card .fader-row { padding: 0 30px; margin-top: 16px; justify-content: center; }
</style>
