<script lang="ts">
  // WavvizCard — WAVVIZ is the wavetable-VCO sister with a built-in
  // wavefolder + a mono-video scope output.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { wavvizDef } from '$lib/audio/modules/wavviz';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let tune       = $derived(node?.params.tune       ?? wavvizDef.params[0]!.defaultValue);
  let fine       = $derived(node?.params.fine       ?? wavvizDef.params[1]!.defaultValue);
  let wavePos    = $derived(node?.params.wavePos    ?? wavvizDef.params[2]!.defaultValue);
  let fmAmount   = $derived(node?.params.fmAmount   ?? wavvizDef.params[3]!.defaultValue);
  let foldAmount = $derived(node?.params.foldAmount ?? wavvizDef.params[4]!.defaultValue);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, k); };
</script>

<div class="mod-card wv-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">WAVVIZ</header>

  <Handle type="target" position={Position.Left} id="pitch"      style="top: 56px;  --handle-color: var(--cable-pitch);" />
  <Handle type="target" position={Position.Left} id="fm"         style="top: 92px;  --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="wavePos"    style="top: 128px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="foldAmount" style="top: 164px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">pitch</span>
  <span class="port-label left" style="top: 86px;">fm</span>
  <span class="port-label left" style="top: 122px;">wave</span>
  <span class="port-label left" style="top: 158px;">fold</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 56px;  --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="scope" style="top: 92px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">audio</span>
  <span class="port-label right" style="top: 86px;">scope</span>

  <div class="fader-row">
    <Fader value={tune}       min={-36}  max={36}  defaultValue={0} label="Tune" units="st" curve="linear" onchange={set('tune')}       readLive={live('tune')} />
    <Fader value={fine}       min={-100} max={100} defaultValue={0} label="Fine" units="¢"  curve="linear" onchange={set('fine')}       readLive={live('fine')} />
    <Fader value={wavePos}    min={0}    max={1}   defaultValue={0} label="Wave"            curve="linear" onchange={set('wavePos')}    readLive={live('wavePos')} />
    <Fader value={fmAmount}   min={0}    max={1}   defaultValue={0} label="FM"              curve="linear" onchange={set('fmAmount')}   readLive={live('fmAmount')} />
    <Fader value={foldAmount} min={0}    max={1}   defaultValue={0} label="Fold"            curve="linear" onchange={set('foldAmount')} readLive={live('foldAmount')} />
  </div>
</div>

<style>
  .wv-card { width: 280px; min-height: 260px; }
</style>
