<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { adsrDef } from '$lib/audio/modules/adsr';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let attack  = $derived(node?.params.attack  ?? adsrDef.params[0]!.defaultValue);
  let decay   = $derived(node?.params.decay   ?? adsrDef.params[1]!.defaultValue);
  let sustain = $derived(node?.params.sustain ?? adsrDef.params[2]!.defaultValue);
  let release = $derived(node?.params.release ?? adsrDef.params[3]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };
</script>

<div class="mod-card adsr-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">ADSR</header>

  <Handle type="target" position={Position.Left} id="gate" style="top: 56px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">gate</span>

  <Handle type="source" position={Position.Right} id="env" style="top: 56px; --handle-color: var(--cable-cv);" />
  <span class="port-label right" style="top: 50px;">env</span>

  <div class="fader-row">
    <Fader value={attack}  min={0.001} max={10} defaultValue={0.005} label="A" units="s" curve="log"    onchange={set('attack')}  readLive={live('attack')} />
    <Fader value={decay}   min={0.001} max={10} defaultValue={0.1}   label="D" units="s" curve="log"    onchange={set('decay')}   readLive={live('decay')} />
    <Fader value={sustain} min={0}     max={1}  defaultValue={0.7}   label="S"           curve="linear" onchange={set('sustain')} readLive={live('sustain')} />
    <Fader value={release} min={0.001} max={10} defaultValue={0.3}   label="R" units="s" curve="log"    onchange={set('release')} readLive={live('release')} />
  </div>
</div>

<style>
  .adsr-card { width: 240px; min-height: 200px; }
</style>
