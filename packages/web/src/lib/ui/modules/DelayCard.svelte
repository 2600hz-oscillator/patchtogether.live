<script lang="ts">
  // DELAY — mono delay line with time / feedback / mix. Pure-JS
  // factory wires a DelayNode + feedback loop; see
  // /Users/2600hz/Documents/workspace/inet.modular/packages/web/src/lib/audio/modules/delay.ts
  // for the topology.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { delayDef } from '$lib/audio/modules/delay';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(delayDef, () => id, () => node);

  let time     = $derived(node?.params.time     ?? delayDef.params[0]!.defaultValue);
  let feedback = $derived(node?.params.feedback ?? delayDef.params[1]!.defaultValue);
  let mix      = $derived(node?.params.mix      ?? delayDef.params[2]!.defaultValue);


  const inputs = portsFromDef(delayDef.inputs, { audio: 'IN' });
  const outputs = portsFromDef(delayDef.outputs, { audio: 'OUT' });
</script>

<div class="mod-card delay-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="DELAY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={time}     min={0.001} max={2}    defaultValue={0.25} label="Time" units="s" curve="log"    onchange={set('time')} moduleId={id} paramId="time"     readLive={live('time')} />
      <Fader value={feedback} min={0}     max={0.95} defaultValue={0.4}  label="Fb"   curve="linear"        onchange={set('feedback')} moduleId={id} paramId="feedback" readLive={live('feedback')} />
      <Fader value={mix}      min={0}     max={1}    defaultValue={0.35} label="Mix"  curve="linear"        onchange={set('mix')} moduleId={id} paramId="mix"      readLive={live('mix')} />
    </div>
  </PatchPanel>
</div>

<style>
  .delay-card { width: 200px; }
  .delay-card .fader-row { margin-top: 14px; padding: 0 18px; }
</style>
