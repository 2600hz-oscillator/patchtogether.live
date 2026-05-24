<script lang="ts">
  // LumaCard — single-input POSTERIZE / CONTRAST / GAMMA / BIAS processor.
  // The old version was a confused mask-extractor; see luma.ts header for
  // the migration story. Use LUMAKEY for the proper 2-input luma-key
  // compositor.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { lumaDef } from '$lib/video/modules/luma';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = lumaDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
</script>

<div class="card video">
  <div class="stripe"></div>
  <header class="title">LUMA</header>

  <Handle type="target" position={Position.Left} id="in"              style="top: 56px;  --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">IN</span>
  <Handle type="target" position={Position.Left} id="gamma"           style="top: 92px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 86px;">G</span>
  <Handle type="target" position={Position.Left} id="contrast"        style="top: 124px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 118px;">C</span>
  <Handle type="target" position={Position.Left} id="posterizeLevels" style="top: 156px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 150px;">P</span>
  <Handle type="target" position={Position.Left} id="bias"            style="top: 188px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 182px;">B</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="fader-grid">
    <Fader value={p('gamma')}           min={0.1} max={3.0}  defaultValue={lumaDef.params.find((x) => x.id === 'gamma')!.defaultValue}           label="Gamma" curve="linear" onchange={setParam('gamma')}           moduleId={id} paramId="gamma" />
    <Fader value={p('contrast')}        min={0}   max={2}    defaultValue={lumaDef.params.find((x) => x.id === 'contrast')!.defaultValue}        label="Cntr"  curve="linear" onchange={setParam('contrast')}        moduleId={id} paramId="contrast" />
    <Fader value={p('posterizeLevels')} min={2}   max={16}   defaultValue={lumaDef.params.find((x) => x.id === 'posterizeLevels')!.defaultValue} label="Post"  curve="linear" onchange={setParam('posterizeLevels')} moduleId={id} paramId="posterizeLevels" />
    <Fader value={p('bias')}            min={-0.5} max={0.5} defaultValue={lumaDef.params.find((x) => x.id === 'bias')!.defaultValue}            label="Bias"  curve="linear" onchange={setParam('bias')}            moduleId={id} paramId="bias" />
  </div>
</div>

<style>
  .card {
    width: 220px;
    min-height: 260px;
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
    margin-top: 130px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px 6px;
    justify-items: center;
  }
</style>
