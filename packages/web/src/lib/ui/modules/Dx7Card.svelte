<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { dx7Def } from '$lib/audio/modules/dx7';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let noteVal       = $derived(node?.params.note       ?? dx7Def.params[0]!.defaultValue);
  let algorithmVal  = $derived(node?.params.algorithm  ?? dx7Def.params[1]!.defaultValue);
  let brightnessVal = $derived(node?.params.brightness ?? dx7Def.params[2]!.defaultValue);
  let envelopeVal   = $derived(node?.params.envelope   ?? dx7Def.params[3]!.defaultValue);
  let velocityVal   = $derived(node?.params.velocity   ?? dx7Def.params[4]!.defaultValue);
  let levelVal      = $derived(node?.params.level      ?? dx7Def.params[5]!.defaultValue);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, k); };
</script>

<div class="mod-card dx7-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">DX7</header>

  <Handle type="target" position={Position.Left} id="pitch"   style="top: 56px;  --handle-color: var(--cable-pitch);" />
  <Handle type="target" position={Position.Left} id="trigger" style="top: 92px;  --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">pitch</span>
  <span class="port-label left" style="top: 86px;">trig</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="aux"   style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">audio</span>
  <span class="port-label right" style="top: 86px;">aux</span>

  <div class="fader-row">
    <Fader value={noteVal}       min={0}  max={127} defaultValue={60}  label="Note"     units="st" curve="linear" onchange={set('note')}       readLive={live('note')} />
    <Fader value={algorithmVal}  min={0}  max={1}   defaultValue={0}   label="Algo"                curve="linear" onchange={set('algorithm')}  readLive={live('algorithm')} />
    <Fader value={brightnessVal} min={0}  max={1}   defaultValue={0.5} label="Bright"              curve="linear" onchange={set('brightness')} readLive={live('brightness')} />
    <Fader value={envelopeVal}   min={0}  max={1}   defaultValue={0.5} label="Env"                 curve="linear" onchange={set('envelope')}   readLive={live('envelope')} />
    <Fader value={velocityVal}   min={0}  max={1}   defaultValue={0.5} label="Vel"                 curve="linear" onchange={set('velocity')}   readLive={live('velocity')} />
    <Fader value={levelVal}      min={0}  max={1}   defaultValue={1}   label="Level"               curve="linear" onchange={set('level')}      readLive={live('level')} />
  </div>
</div>

<style>
  .dx7-card { width: 320px; min-height: 240px; }
</style>
