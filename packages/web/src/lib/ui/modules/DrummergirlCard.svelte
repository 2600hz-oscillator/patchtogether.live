<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { drummergirlDef } from '$lib/audio/modules/drummergirl';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(drummergirlDef, () => id, () => node);

  let pitch  = $derived(node?.params.pitch  ?? drummergirlDef.params[0]!.defaultValue);
  let tone   = $derived(node?.params.tone   ?? drummergirlDef.params[1]!.defaultValue);
  let shape  = $derived(node?.params.shape  ?? drummergirlDef.params[2]!.defaultValue);
  let volume = $derived(node?.params.volume ?? drummergirlDef.params[3]!.defaultValue);
  let decay  = $derived(node?.params.decay  ?? drummergirlDef.params[4]!.defaultValue);


  const inputs = portsFromDef(drummergirlDef.inputs);
  const outputs = portsFromDef(drummergirlDef.outputs, { audio: 'OUT' });
</script>

<div class="mod-card drummergirl-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="DRUMMERGIRL" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={pitch}  min={-36}   max={36}  defaultValue={0}    label="Pitch"  units="st" curve="linear" onchange={set('pitch')} moduleId={id} paramId="pitch"  readLive={live('pitch')} />
      <Fader value={tone}   min={0}     max={1}   defaultValue={0.3}  label="Tone"              curve="linear" onchange={set('tone')} moduleId={id} paramId="tone"   readLive={live('tone')} />
      <Fader value={shape}  min={0}     max={1}   defaultValue={0.3}  label="Shape"             curve="linear" onchange={set('shape')} moduleId={id} paramId="shape"  readLive={live('shape')} />
      <Fader value={decay}  min={0.001} max={0.5} defaultValue={0.15} label="Decay"  units="s"  curve="log"    onchange={set('decay')} moduleId={id} paramId="decay"  readLive={live('decay')} />
      <Fader value={volume} min={0}     max={2.0} defaultValue={1.0}  label="Volume"            curve="linear" onchange={set('volume')} moduleId={id} paramId="volume" readLive={live('volume')} />
    </div>
  </PatchPanel>
</div>

<style>
  .drummergirl-card { width: 320px; }
  .drummergirl-card .fader-row { padding: 0 24px; margin-top: 14px; }
</style>
