<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { meowboxDef } from '$lib/audio/modules/meowbox';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let pitch = $derived(node?.params.pitch ?? meowboxDef.params[0]!.defaultValue);
  let morph = $derived(node?.params.morph ?? meowboxDef.params[1]!.defaultValue);
  let decay = $derived(node?.params.decay ?? meowboxDef.params[2]!.defaultValue);
  let level = $derived(node?.params.level ?? meowboxDef.params[3]!.defaultValue);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };
</script>

<div class="mod-card meowbox-card">
  <div class="ear ear-left"></div>
  <div class="ear ear-right"></div>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">MEOWBOX</header>

  <Handle type="target" position={Position.Left} id="gate"  style="top: 56px;  --handle-color: var(--cable-gate);" />
  <Handle type="target" position={Position.Left} id="pitch" style="top: 92px;  --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="morph" style="top: 128px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="decay" style="top: 164px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="level" style="top: 200px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">gate</span>
  <span class="port-label left" style="top: 86px;">p cv</span>
  <span class="port-label left" style="top: 122px;">m cv</span>
  <span class="port-label left" style="top: 158px;">d cv</span>
  <span class="port-label left" style="top: 194px;">l cv</span>

  <Handle type="source" position={Position.Right} id="L" style="top: 56px; --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="R" style="top: 92px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 50px;">L</span>
  <span class="port-label right" style="top: 86px;">R</span>

  <div class="knob-row">
    <Knob value={pitch} min={-36}  max={36} defaultValue={0}    label="Ptch"  units="st" curve="linear" onchange={set('pitch')} readLive={live('pitch')} />
    <Knob value={morph} min={0}    max={1}  defaultValue={0.25} label="Morph"            curve="linear" onchange={set('morph')} readLive={live('morph')} />
    <Knob value={decay} min={0.05} max={2}  defaultValue={0.4}  label="Dcy"   units="s"  curve="log"    onchange={set('decay')} readLive={live('decay')} />
    <Knob value={level} min={0}    max={2}  defaultValue={1}    label="Lvl"              curve="linear" onchange={set('level')} readLive={live('level')} />
  </div>
</div>

<style>
  .meowbox-card {
    width: 240px;
    min-height: 340px;
    overflow: visible;
  }
  .meowbox-card .ear {
    position: absolute;
    top: -16px;
    width: 0;
    height: 0;
    border-left: 14px solid transparent;
    border-right: 14px solid transparent;
    border-bottom: 22px solid var(--meowbox-ear-color, #6e8aa6);
  }
  .meowbox-card .ear-left {
    left: 30px;
    transform: rotate(-12deg);
  }
  .meowbox-card .ear-right {
    right: 30px;
    transform: rotate(12deg);
  }
  .meowbox-card .knob-row {
    margin-top: 220px;
    display: flex;
    justify-content: center;
    gap: 14px;
    padding: 0 16px;
  }
</style>
