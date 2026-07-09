<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { qbrtDef } from '$lib/audio/modules/qbrt';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(qbrtDef, () => id, () => node);

  let cutoff    = $derived(node?.params.cutoff    ?? qbrtDef.params[0]!.defaultValue);
  let resonance = $derived(node?.params.resonance ?? qbrtDef.params[1]!.defaultValue);
  let mode      = $derived(node?.params.mode      ?? qbrtDef.params[2]!.defaultValue);
  let pingDecay = $derived(node?.params.pingDecay ?? qbrtDef.params[3]!.defaultValue);


  const inputs = portsFromDef(qbrtDef.inputs);
  const outputs = portsFromDef(qbrtDef.outputs);
</script>

<div class="mod-card qbrt-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="QBRT" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={cutoff}    min={20}    max={20000} defaultValue={1000} label="Cutoff"     units="Hz" curve="log"    onchange={set('cutoff')} moduleId={id} paramId="cutoff"    readLive={live('cutoff')} />
      <Fader value={resonance} min={0}     max={0.99}  defaultValue={0.7}  label="Resonance"             curve="linear" onchange={set('resonance')} moduleId={id} paramId="resonance" readLive={live('resonance')} />
      <Fader value={mode}      min={0}     max={1}     defaultValue={0}    label="Mode"                  curve="linear" onchange={set('mode')} moduleId={id} paramId="mode"      readLive={live('mode')} />
      <Fader value={pingDecay} min={0.005} max={0.5}   defaultValue={0.15} label="Ping Decay" units="s"  curve="log"    onchange={set('pingDecay')} moduleId={id} paramId="pingDecay" readLive={live('pingDecay')} />
    </div>
  </PatchPanel>
</div>

<style>
  .qbrt-card { width: 280px; }
  .qbrt-card .fader-row { padding: 0 24px; margin-top: 14px; }
</style>
