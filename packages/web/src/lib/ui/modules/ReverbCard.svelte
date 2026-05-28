<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { reverbDef } from '$lib/audio/modules/reverb';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let size = $derived(node?.params.size ?? reverbDef.params[0]!.defaultValue);
  let damp = $derived(node?.params.damp ?? reverbDef.params[1]!.defaultValue);
  let mix  = $derived(node?.params.mix  ?? reverbDef.params[2]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const inputs: PortDescriptor[] = [{ id: 'audio', label: 'IN', cable: 'audio' }];
  const outputs: PortDescriptor[] = [{ id: 'audio', label: 'OUT', cable: 'audio' }];
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
  .reverb-card { width: 200px; min-height: 180px; }
  .reverb-card .fader-row { margin-top: 14px; padding: 0 18px; }
</style>
