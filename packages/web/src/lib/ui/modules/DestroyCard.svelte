<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { destroyDef } from '$lib/audio/modules/destroy';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let decimate = $derived(node?.params.decimate ?? destroyDef.params[0]!.defaultValue);
  let bits     = $derived(node?.params.bits     ?? destroyDef.params[1]!.defaultValue);
  let wet      = $derived(node?.params.wet      ?? destroyDef.params[2]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const inputs: PortDescriptor[] = [
    { id: 'audio',    cable: 'audio' },
    { id: 'decimate', cable: 'cv' },
    { id: 'bits',     cable: 'cv' },
    { id: 'wet',      cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [{ id: 'audio', label: 'OUT', cable: 'audio' }];
</script>

<div class="mod-card destroy-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">DESTROY</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={decimate} min={1}  max={64} defaultValue={1}  label="Decimate" curve="linear" onchange={set('decimate')} readLive={live('decimate')} />
      <Fader value={bits}     min={1}  max={16} defaultValue={16} label="Bits"     curve="linear" onchange={set('bits')}     readLive={live('bits')} />
      <Fader value={wet}      min={0}  max={1}  defaultValue={1}  label="Wet"      curve="linear" onchange={set('wet')}      readLive={live('wet')} />
    </div>
  </PatchPanel>
</div>

<style>
  .destroy-card { width: 220px; min-height: 200px; }
  .destroy-card .fader-row { padding: 0 18px; margin-top: 14px; }
</style>
