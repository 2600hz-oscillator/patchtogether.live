<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { wavetableVcoDef } from '$lib/audio/modules/wavetable-vco';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(wavetableVcoDef, () => id, () => node);

  let tune     = $derived(node?.params.tune     ?? wavetableVcoDef.params.find((p) => p.id === 'tune')!.defaultValue);
  let fine     = $derived(node?.params.fine     ?? wavetableVcoDef.params.find((p) => p.id === 'fine')!.defaultValue);
  let wavePos  = $derived(node?.params.wavePos  ?? wavetableVcoDef.params.find((p) => p.id === 'wavePos')!.defaultValue);
  let fmAmount = $derived(node?.params.fmAmount ?? wavetableVcoDef.params.find((p) => p.id === 'fmAmount')!.defaultValue);
  let pmAmount = $derived(node?.params.pmAmount ?? wavetableVcoDef.params.find((p) => p.id === 'pmAmount')!.defaultValue);


  const inputs = portsFromDef(wavetableVcoDef.inputs, {
    wavePos: 'WAVE POSITION', fmAmount: 'FM AMT', pmAmount: 'PM AMT',
  });
  const outputs = portsFromDef(wavetableVcoDef.outputs);
</script>

<div class="mod-card wt-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="Wavetable VCO" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={tune}     min={-36} max={36}   defaultValue={0} label="Tune" units="st" curve="linear" onchange={set('tune')} moduleId={id} paramId="tune"     readLive={live('tune')} />
      <Fader value={fine}     min={-100} max={100} defaultValue={0} label="Fine" units="¢"  curve="linear" onchange={set('fine')} moduleId={id} paramId="fine"     readLive={live('fine')} />
      <Fader value={wavePos}  min={0}   max={1}    defaultValue={0} label="Wave"            curve="linear" onchange={set('wavePos')} moduleId={id} paramId="wavePos"  readLive={live('wavePos')} />
      <Fader value={fmAmount} min={0}   max={1}    defaultValue={0} label="FM"              curve="linear" onchange={set('fmAmount')} moduleId={id} paramId="fmAmount" readLive={live('fmAmount')} />
      <Fader value={pmAmount} min={0}   max={1}    defaultValue={0} label="PM"              curve="linear" onchange={set('pmAmount')} moduleId={id} paramId="pmAmount" readLive={live('pmAmount')} />
    </div>
  </PatchPanel>
</div>

<style>
  .wt-card { width: 240px; }
  .wt-card .fader-row { padding: 0 18px; margin-top: 14px; }
</style>
