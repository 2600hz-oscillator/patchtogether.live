<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
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
</script>

<div class="mod-card destroy-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">DESTROY</header>

  <Handle type="target" position={Position.Left} id="audio"    style="top: 56px;  --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="decimate" style="top: 92px;  --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="bits"     style="top: 128px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="wet"      style="top: 164px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">audio</span>
  <span class="port-label left" style="top: 86px;">dec cv</span>
  <span class="port-label left" style="top: 122px;">bit cv</span>
  <span class="port-label left" style="top: 158px;">wet cv</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 56px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">out</span>

  <div class="fader-row">
    <Fader value={decimate} min={1}  max={64} defaultValue={1}  label="Dec"  curve="linear" onchange={set('decimate')} readLive={live('decimate')} />
    <Fader value={bits}     min={1}  max={16} defaultValue={16} label="Bits" curve="linear" onchange={set('bits')}     readLive={live('bits')} />
    <Fader value={wet}      min={0}  max={1}  defaultValue={1}  label="Wet"  curve="linear" onchange={set('wet')}      readLive={live('wet')} />
  </div>
</div>

<style>
  .destroy-card { width: 220px; min-height: 240px; }
  .destroy-card .fader-row { padding: 0 30px; margin-top: 50px; }
</style>
