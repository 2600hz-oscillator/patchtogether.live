<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { drummergirlDef } from '$lib/audio/modules/drummergirl';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let pitch  = $derived(node?.params.pitch  ?? drummergirlDef.params[0]!.defaultValue);
  let tone   = $derived(node?.params.tone   ?? drummergirlDef.params[1]!.defaultValue);
  let shape  = $derived(node?.params.shape  ?? drummergirlDef.params[2]!.defaultValue);
  let volume = $derived(node?.params.volume ?? drummergirlDef.params[3]!.defaultValue);
  let decay  = $derived(node?.params.decay  ?? drummergirlDef.params[4]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };
</script>

<div class="mod-card drummergirl-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">DRUMMERGIRL</header>

  <Handle type="target" position={Position.Left} id="gate"   style="top: 56px;  --handle-color: var(--cable-gate);" />
  <Handle type="target" position={Position.Left} id="pitch"  style="top: 92px;  --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="tone"   style="top: 128px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="shape"  style="top: 164px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="volume" style="top: 200px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="decay"  style="top: 236px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">gate</span>
  <span class="port-label left" style="top: 86px;">p cv</span>
  <span class="port-label left" style="top: 122px;">t cv</span>
  <span class="port-label left" style="top: 158px;">s cv</span>
  <span class="port-label left" style="top: 194px;">v cv</span>
  <span class="port-label left" style="top: 230px;">d cv</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 56px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">out</span>

  <div class="fader-row">
    <Fader value={pitch}  min={-36}   max={36}  defaultValue={0}    label="Ptch" units="st" curve="linear" onchange={set('pitch')}  readLive={live('pitch')} />
    <Fader value={tone}   min={0}     max={1}   defaultValue={0.3}  label="Tone"            curve="linear" onchange={set('tone')}   readLive={live('tone')} />
    <Fader value={shape}  min={0}     max={1}   defaultValue={0.3}  label="Shp"             curve="linear" onchange={set('shape')}  readLive={live('shape')} />
    <Fader value={decay}  min={0.001} max={0.5} defaultValue={0.15} label="Dcy"  units="s"  curve="log"    onchange={set('decay')}  readLive={live('decay')} />
    <Fader value={volume} min={0}     max={2.0} defaultValue={1.0}  label="Vol"             curve="linear" onchange={set('volume')} readLive={live('volume')} />
  </div>
</div>

<style>
  .drummergirl-card { width: 320px; min-height: 320px; }
  .drummergirl-card .fader-row { padding: 0 30px; margin-top: 110px; }
</style>
