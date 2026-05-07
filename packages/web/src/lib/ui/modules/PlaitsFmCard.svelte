<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { plaitsFmDef } from '$lib/audio/modules/plaits-fm';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let noteVal      = $derived(node?.params.note      ?? plaitsFmDef.params[0]!.defaultValue);
  let harmonicsVal = $derived(node?.params.harmonics ?? plaitsFmDef.params[1]!.defaultValue);
  let timbreVal    = $derived(node?.params.timbre    ?? plaitsFmDef.params[2]!.defaultValue);
  let morphVal     = $derived(node?.params.morph     ?? plaitsFmDef.params[3]!.defaultValue);
  let levelVal     = $derived(node?.params.level     ?? plaitsFmDef.params[4]!.defaultValue);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, k); };
</script>

<div class="mod-card plaits-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">PlaitsFM</header>

  <Handle type="target" position={Position.Left} id="pitch"   style="top: 56px;  --handle-color: var(--cable-pitch);" />
  <Handle type="target" position={Position.Left} id="trigger" style="top: 92px;  --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">pitch</span>
  <span class="port-label left" style="top: 86px;">trig</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="sub"   style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">audio</span>
  <span class="port-label right" style="top: 86px;">sub</span>

  <div class="fader-row">
    <Fader value={noteVal}      min={0}  max={127} defaultValue={60}  label="Note"     units="st" curve="linear" onchange={set('note')}      readLive={live('note')} />
    <Fader value={harmonicsVal} min={0}  max={1}   defaultValue={0.5} label="Ratio"               curve="linear" onchange={set('harmonics')} readLive={live('harmonics')} />
    <Fader value={timbreVal}    min={0}  max={1}   defaultValue={0.5} label="Index"               curve="linear" onchange={set('timbre')}    readLive={live('timbre')} />
    <Fader value={morphVal}     min={0}  max={1}   defaultValue={0.5} label="Feedbk"              curve="linear" onchange={set('morph')}     readLive={live('morph')} />
    <Fader value={levelVal}     min={0}  max={1}   defaultValue={1}   label="Level"               curve="linear" onchange={set('level')}     readLive={live('level')} />
  </div>
</div>

<style>
  .plaits-card { width: 280px; min-height: 240px; }
</style>
