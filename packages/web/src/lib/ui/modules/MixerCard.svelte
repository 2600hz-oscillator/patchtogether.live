<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { mixerDef } from '$lib/audio/modules/mixer';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Source-of-truth defaults from the module def — keeps UI fallback in sync
  // with engine defaults if either changes. Order in mixerDef.params is:
  //   [0] ch1 [1] ch2 [2] ch3 [3] ch4 [4] master
  let ch1    = $derived(node?.params.ch1    ?? mixerDef.params[0]!.defaultValue);
  let ch2    = $derived(node?.params.ch2    ?? mixerDef.params[1]!.defaultValue);
  let ch3    = $derived(node?.params.ch3    ?? mixerDef.params[2]!.defaultValue);
  let ch4    = $derived(node?.params.ch4    ?? mixerDef.params[3]!.defaultValue);
  let master = $derived(node?.params.master ?? mixerDef.params[4]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };
</script>

<div class="mod-card mixer-card">
  <div class="stripe" style="background: var(--text-dim);"></div>
  <header class="title">Mixer</header>

  <Handle type="target" position={Position.Left} id="in1" style="top: 56px;  --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="in2" style="top: 92px;  --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="in3" style="top: 128px; --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="in4" style="top: 164px; --handle-color: var(--cable-audio);" />
  <span class="port-label left" style="top: 50px;">in1</span>
  <span class="port-label left" style="top: 86px;">in2</span>
  <span class="port-label left" style="top: 122px;">in3</span>
  <span class="port-label left" style="top: 158px;">in4</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 110px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 104px;">out</span>

  <div class="fader-row">
    <Fader value={ch1}    min={0} max={1} defaultValue={1} label="Ch1"    curve="linear" onchange={set('ch1')}    readLive={live('ch1')} />
    <Fader value={ch2}    min={0} max={1} defaultValue={1} label="Ch2"    curve="linear" onchange={set('ch2')}    readLive={live('ch2')} />
    <Fader value={ch3}    min={0} max={1} defaultValue={1} label="Ch3"    curve="linear" onchange={set('ch3')}    readLive={live('ch3')} />
    <Fader value={ch4}    min={0} max={1} defaultValue={1} label="Ch4"    curve="linear" onchange={set('ch4')}    readLive={live('ch4')} />
    <Fader value={master} min={0} max={1} defaultValue={1} label="Master" curve="linear" onchange={set('master')} readLive={live('master')} />
  </div>
</div>

<style>
  .mixer-card { width: 260px; min-height: 230px; }
  .mixer-card .fader-row { padding: 0 12px; gap: 4px; }
</style>
