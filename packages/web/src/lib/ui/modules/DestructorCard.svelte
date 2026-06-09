<script lang="ts">
  // DestructorCard — RGB-shift / scanline / posterize glitch effect.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { destructorDef } from '$lib/video/modules/destructor';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = destructorDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
</script>

<div class="card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="DESTRUCTOR" />

  <Handle type="target" position={Position.Left} id="in"     style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">IN</span>
  <Handle type="target" position={Position.Left} id="mangle" style="top: 92px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 86px;">M</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="fader-grid">
    <Fader value={p('shift')}     min={0} max={1} defaultValue={destructorDef.params.find((x) => x.id === 'shift')!.defaultValue}     label="Shift"  curve="linear" onchange={setParam('shift')} moduleId={id} paramId="shift" />
    <Fader value={p('scanline')}  min={0} max={1} defaultValue={destructorDef.params.find((x) => x.id === 'scanline')!.defaultValue}  label="Scan"   curve="linear" onchange={setParam('scanline')} moduleId={id} paramId="scanline" />
    <Fader value={p('posterize')} min={0} max={1} defaultValue={destructorDef.params.find((x) => x.id === 'posterize')!.defaultValue} label="Post"   curve="linear" onchange={setParam('posterize')} moduleId={id} paramId="posterize" />
    <Fader value={p('mangle')}    min={0} max={1} defaultValue={destructorDef.params.find((x) => x.id === 'mangle')!.defaultValue}    label="Mangle" curve="linear" onchange={setParam('mangle')} moduleId={id} paramId="mangle" />
  </div>
</div>

<style>
  .card {
    width: 260px;
    min-height: 240px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-video); }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .port-label { position: absolute; font-size: 0.6rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .fader-grid {
    margin-top: 50px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 12px 6px;
    justify-items: center;
  }
</style>
