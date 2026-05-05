<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { reverbDef } from '$lib/audio/modules/reverb';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let size = $derived(node?.params.size ?? reverbDef.params[0]!.defaultValue);
  let damp = $derived(node?.params.damp ?? reverbDef.params[1]!.defaultValue);
  let mix  = $derived(node?.params.mix  ?? reverbDef.params[2]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };
</script>

<div class="mod-card reverb-card">
  <div class="stripe" style="background: var(--cable-pitch);"></div>
  <header class="title">Reverb</header>

  <Handle type="target" position={Position.Left} id="audio" style="top: 56px; --handle-color: var(--cable-audio);" />
  <span class="port-label left" style="top: 50px;">in</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 56px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">out</span>

  <div class="fader-row">
    <Fader value={size} min={0} max={1} defaultValue={0.5} label="Size" curve="linear" onchange={set('size')} readLive={live('size')} />
    <Fader value={damp} min={0} max={1} defaultValue={0.3} label="Damp" curve="linear" onchange={set('damp')} readLive={live('damp')} />
    <Fader value={mix}  min={0} max={1} defaultValue={0.3} label="Mix"  curve="linear" onchange={set('mix')}  readLive={live('mix')} />
  </div>
</div>

<style>
  .reverb-card { width: 200px; min-height: 200px; }
</style>
