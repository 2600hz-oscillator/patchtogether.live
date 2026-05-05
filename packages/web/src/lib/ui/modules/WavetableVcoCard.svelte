<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { wavetableVcoDef } from '$lib/audio/modules/wavetable-vco';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let tune     = $derived(node?.params.tune     ?? wavetableVcoDef.params[0]!.defaultValue);
  let fine     = $derived(node?.params.fine     ?? wavetableVcoDef.params[1]!.defaultValue);
  let wavePos  = $derived(node?.params.wavePos  ?? wavetableVcoDef.params[2]!.defaultValue);
  let fmAmount = $derived(node?.params.fmAmount ?? wavetableVcoDef.params[3]!.defaultValue);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, k); };
</script>

<div class="mod-card wt-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">Wavetable VCO</header>

  <Handle type="target" position={Position.Left} id="pitch"   style="top: 56px;  --handle-color: var(--cable-pitch);" />
  <Handle type="target" position={Position.Left} id="fm"      style="top: 92px;  --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="wavePos" style="top: 128px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">pitch</span>
  <span class="port-label left" style="top: 86px;">fm</span>
  <span class="port-label left" style="top: 122px;">wave</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 56px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">audio</span>

  <div class="fader-row">
    <Fader value={tune}     min={-36} max={36}   defaultValue={0} label="Tune" units="st" curve="linear" onchange={set('tune')}     readLive={live('tune')} />
    <Fader value={fine}     min={-100} max={100} defaultValue={0} label="Fine" units="¢"  curve="linear" onchange={set('fine')}     readLive={live('fine')} />
    <Fader value={wavePos}  min={0}   max={1}    defaultValue={0} label="Wave"            curve="linear" onchange={set('wavePos')}  readLive={live('wavePos')} />
    <Fader value={fmAmount} min={0}   max={1}    defaultValue={0} label="FM"              curve="linear" onchange={set('fmAmount')} readLive={live('fmAmount')} />
  </div>
</div>

<style>
  .wt-card { width: 240px; min-height: 240px; }
</style>
