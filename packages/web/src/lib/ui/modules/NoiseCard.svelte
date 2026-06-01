<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { noiseDef } from '$lib/audio/modules/noise';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let level = $derived(node?.params.level ?? noiseDef.params[0]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  // No inputs (NOISE is a pure source), three audio outputs.
  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [
    { id: 'white', label: 'WHITE', cable: 'audio' },
    { id: 'pink',  label: 'PINK',  cable: 'audio' },
    { id: 'brown', label: 'BROWN', cable: 'audio' },
  ];
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
