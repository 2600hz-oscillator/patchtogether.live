<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { adsrDef } from '$lib/audio/modules/adsr';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let attack  = $derived(node?.params.attack  ?? adsrDef.params[0]!.defaultValue);
  let decay   = $derived(node?.params.decay   ?? adsrDef.params[1]!.defaultValue);
  let sustain = $derived(node?.params.sustain ?? adsrDef.params[2]!.defaultValue);
  let release = $derived(node?.params.release ?? adsrDef.params[3]!.defaultValue);

  const set = (id_: string) => (v: number) => setNodeParam(id, id_, v);
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const inputs: PortDescriptor[] = [
    { id: 'gate',    cable: 'gate' },
    { id: 'attack',  cable: 'cv' },
    { id: 'decay',   cable: 'cv' },
    { id: 'sustain', cable: 'cv' },
    { id: 'release', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'env',     cable: 'cv' },
    { id: 'env_inv', label: 'ENV INV', cable: 'cv' },
  ];
</script>

<div class="mod-card adsr-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="ADSR" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={attack}  min={0.001} max={10} defaultValue={0.005} label="Attack"  units="s" curve="log"    onchange={set('attack')}  readLive={live('attack')}  moduleId={id} paramId="attack" />
      <Fader value={decay}   min={0.001} max={10} defaultValue={0.1}   label="Decay"   units="s" curve="log"    onchange={set('decay')}   readLive={live('decay')}   moduleId={id} paramId="decay" />
      <Fader value={sustain} min={0}     max={1}  defaultValue={0.7}   label="Sustain"           curve="linear" onchange={set('sustain')} readLive={live('sustain')} moduleId={id} paramId="sustain" />
      <Fader value={release} min={0.001} max={10} defaultValue={0.3}   label="Release" units="s" curve="log"    onchange={set('release')} readLive={live('release')} moduleId={id} paramId="release" />
    </div>
  </PatchPanel>
</div>

<style>
  .adsr-card { width: 240px; }
  .adsr-card .fader-row { padding: 0 18px; margin-top: 16px; }
</style>
