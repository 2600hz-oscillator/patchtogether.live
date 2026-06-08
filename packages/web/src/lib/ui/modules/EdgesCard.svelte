<script lang="ts">
  // EdgesCard — UI for EDGES (Sobel edge-detection video processor).
  //
  // Single video input (in) → mono-video output (out). Two knobs:
  // THRESHOLD (edge trigger) + THICKNESS (rendered edge width), each with
  // a matching per-param CV input. Mirrors the LUMA / CHROMA processor-card
  // layout (handles on the left, OUT on the right, fader grid below).
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { edgesDef, EDGES_MAX_THICKNESS } from '$lib/video/modules/edges';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = edgesDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number {
    return edgesDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
</script>

<div class="card video" data-testid="edges-card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="EDGES" />

  <Handle type="target" position={Position.Left} id="in"        style="top: 56px;  --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">IN</span>
  <!-- CV inputs — one per modulatable param. handle id MUST match the param
       id (the cross-domain CV bridge routes cv onto setParam(portId)). -->
  <Handle type="target" position={Position.Left} id="threshold" style="top: 92px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 86px;">T</span>
  <Handle type="target" position={Position.Left} id="thickness" style="top: 124px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 118px;">W</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="fader-grid">
    <Fader value={p('threshold')} min={0} max={1}                  defaultValue={pdef('threshold')} label="Thresh" curve="linear" onchange={setParam('threshold')} moduleId={id} paramId="threshold" />
    <Fader value={p('thickness')} min={1} max={EDGES_MAX_THICKNESS} units="px" defaultValue={pdef('thickness')} label="Thick"  curve="linear" onchange={setParam('thickness')} moduleId={id} paramId="thickness" />
  </div>
</div>

<style>
  .card {
    width: 200px;
    min-height: 250px;
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
  /* Mono-video stripe — same accent the OUT handle uses, so the card reads
     as a mono-video producer at a glance. */
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-mono-video); }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .port-label { position: absolute; font-size: 0.6rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .fader-grid {
    /* Clear the lowest CV-input handle (top: 124px). */
    margin-top: 80px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 16px;
    justify-items: center;
  }
</style>
