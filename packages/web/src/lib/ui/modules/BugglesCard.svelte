<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { bugglesDef } from '$lib/audio/modules/buggles';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(bugglesDef, () => id, () => node);

  let rate       = $derived(node?.params.rate              ?? bugglesDef.params[0]!.defaultValue);
  let chaos      = $derived(node?.params.chaos             ?? bugglesDef.params[1]!.defaultValue);
  let smoothness = $derived(node?.params.smoothness        ?? bugglesDef.params[2]!.defaultValue);
  let burstProb  = $derived(node?.params.burst_probability ?? bugglesDef.params[3]!.defaultValue);
  let level      = $derived(node?.params.level             ?? bugglesDef.params[4]!.defaultValue);


  const inputs = portsFromDef(bugglesDef.inputs, {
    clock_cv: 'CLOCK CV', chaos_cv: 'CHAOS CV', external_clock: 'EXT CLK',
  });
  const outputs = portsFromDef(bugglesDef.outputs);
</script>

<div class="mod-card buggles-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="BUGGLES" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={rate}       min={0} max={1} defaultValue={0.4} label="Rate"   curve="linear" onchange={set('rate')} moduleId={id} paramId="rate"              readLive={live('rate')} />
      <Fader value={chaos}      min={0} max={1} defaultValue={0.3} label="Chaos"  curve="linear" onchange={set('chaos')} moduleId={id} paramId="chaos"             readLive={live('chaos')} />
      <Fader value={smoothness} min={0} max={1} defaultValue={0.5} label="Smooth" curve="linear" onchange={set('smoothness')} moduleId={id} paramId="smoothness"        readLive={live('smoothness')} />
      <Fader value={burstProb}  min={0} max={1} defaultValue={0.2} label="Burst"  curve="linear" onchange={set('burst_probability')} moduleId={id} paramId="burst_probability" readLive={live('burst_probability')} />
      <Fader value={level}      min={0} max={1} defaultValue={0.7} label="Level"  curve="linear" onchange={set('level')} moduleId={id} paramId="level"             readLive={live('level')} />
    </div>
  </PatchPanel>
</div>

<style>
  .buggles-card { width: 280px; }
  .buggles-card .fader-row { padding: 0 14px; margin-top: 18px; gap: 4px; }
</style>
