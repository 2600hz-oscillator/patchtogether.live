<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { mixerDef } from '$lib/audio/modules/mixer';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let ch1    = $derived(node?.params.ch1    ?? mixerDef.params[0]!.defaultValue);
  let ch2    = $derived(node?.params.ch2    ?? mixerDef.params[1]!.defaultValue);
  let ch3    = $derived(node?.params.ch3    ?? mixerDef.params[2]!.defaultValue);
  let ch4    = $derived(node?.params.ch4    ?? mixerDef.params[3]!.defaultValue);
  let master = $derived(node?.params.master ?? mixerDef.params[4]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const inputs: PortDescriptor[] = [
    { id: 'in1', label: 'INPUT 1', cable: 'audio' },
    { id: 'in2', label: 'INPUT 2', cable: 'audio' },
    { id: 'in3', label: 'INPUT 3', cable: 'audio' },
    { id: 'in4', label: 'INPUT 4', cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'audio', label: 'OUT', cable: 'audio' },
  ];
</script>

<div class="mod-card mixer-card">
  <div class="stripe" style="background: var(--text-dim);"></div>
  <ModuleTitle {id} {data} defaultLabel="Mixer" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={ch1}    min={0} max={1} defaultValue={1} label="Ch1"    curve="linear" onchange={set('ch1')} moduleId={id} paramId="ch1"    readLive={live('ch1')} />
      <Fader value={ch2}    min={0} max={1} defaultValue={1} label="Ch2"    curve="linear" onchange={set('ch2')} moduleId={id} paramId="ch2"    readLive={live('ch2')} />
      <Fader value={ch3}    min={0} max={1} defaultValue={1} label="Ch3"    curve="linear" onchange={set('ch3')} moduleId={id} paramId="ch3"    readLive={live('ch3')} />
      <Fader value={ch4}    min={0} max={1} defaultValue={1} label="Ch4"    curve="linear" onchange={set('ch4')} moduleId={id} paramId="ch4"    readLive={live('ch4')} />
      <Fader value={master} min={0} max={1} defaultValue={1} label="Master" curve="linear" onchange={set('master')} moduleId={id} paramId="master" readLive={live('master')} />
    </div>
  </PatchPanel>
</div>

<style>
  .mixer-card { width: 260px; min-height: 200px; }
  .mixer-card .fader-row { padding: 0 12px; gap: 4px; margin-top: 12px; }
</style>
