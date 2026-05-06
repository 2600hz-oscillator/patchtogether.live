<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { qbrtDef } from '$lib/audio/modules/qbrt';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cutoff    = $derived(node?.params.cutoff    ?? qbrtDef.params[0]!.defaultValue);
  let resonance = $derived(node?.params.resonance ?? qbrtDef.params[1]!.defaultValue);
  let mode      = $derived(node?.params.mode      ?? qbrtDef.params[2]!.defaultValue);
  let pingDecay = $derived(node?.params.pingDecay ?? qbrtDef.params[3]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };
</script>

<div class="mod-card qbrt-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">QBRT</header>

  <Handle type="target" position={Position.Left} id="L"         style="top: 56px;  --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="R"         style="top: 92px;  --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="ping"      style="top: 128px; --handle-color: var(--cable-gate);" />
  <Handle type="target" position={Position.Left} id="cutoff"    style="top: 164px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="resonance" style="top: 200px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="mode"      style="top: 236px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="pingDecay" style="top: 272px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">L</span>
  <span class="port-label left" style="top: 86px;">R</span>
  <span class="port-label left" style="top: 122px;">ping</span>
  <span class="port-label left" style="top: 158px;">cut cv</span>
  <span class="port-label left" style="top: 194px;">res cv</span>
  <span class="port-label left" style="top: 230px;">mod cv</span>
  <span class="port-label left" style="top: 266px;">png cv</span>

  <Handle type="source" position={Position.Right} id="L" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="R" style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">L</span>
  <span class="port-label right" style="top: 86px;">R</span>

  <div class="fader-row">
    <Fader value={cutoff}    min={20}    max={20000} defaultValue={1000} label="Cut"  units="Hz" curve="log"    onchange={set('cutoff')}    readLive={live('cutoff')} />
    <Fader value={resonance} min={0}     max={0.99}  defaultValue={0.7}  label="Res"             curve="linear" onchange={set('resonance')} readLive={live('resonance')} />
    <Fader value={mode}      min={0}     max={1}     defaultValue={0}    label="Mode"            curve="linear" onchange={set('mode')}      readLive={live('mode')} />
    <Fader value={pingDecay} min={0.005} max={0.5}   defaultValue={0.15} label="Ping" units="s"  curve="log"    onchange={set('pingDecay')} readLive={live('pingDecay')} />
  </div>
</div>

<style>
  .qbrt-card { width: 280px; min-height: 360px; }
  .qbrt-card .fader-row { padding: 0 30px; margin-top: 130px; }
</style>
