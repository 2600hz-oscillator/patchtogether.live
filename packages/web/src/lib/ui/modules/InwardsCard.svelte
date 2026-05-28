<script lang="ts">
  // InwardsCard — radial pattern source. Mirrors LinesCard's shape; only
  // the param + handle list differs.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { inwardsDef } from '$lib/video/modules/inwards';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = inwardsDef.params.find((d) => d.id === name);
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
  <ModuleTitle {id} {data} defaultLabel="INWARDS" />

  <!-- CV inputs — one per modulatable param. The cross-domain CV
       bridge in VideoEngine routes audio-side cv onto setParam(portId),
       so the handle id MUST match the param id. -->
  <Handle type="target" position={Position.Left} id="speed"     style="top: 56px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">S</span>
  <Handle type="target" position={Position.Left} id="density"   style="top: 88px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 82px;">D</span>
  <Handle type="target" position={Position.Left} id="thickness" style="top: 120px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 114px;">T</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="fader-grid">
    <Fader value={p('speed')}     min={-2}  max={2}  defaultValue={inwardsDef.params.find((x) => x.id === 'speed')!.defaultValue}     label="Speed"     curve="linear" onchange={setParam('speed')} moduleId={id} paramId="speed" />
    <Fader value={p('density')}   min={1}   max={50} defaultValue={inwardsDef.params.find((x) => x.id === 'density')!.defaultValue}   label="Density"   curve="linear" onchange={setParam('density')} moduleId={id} paramId="density" />
    <Fader value={p('thickness')} min={0}   max={1}  defaultValue={inwardsDef.params.find((x) => x.id === 'thickness')!.defaultValue} label="Thick"     curve="linear" onchange={setParam('thickness')} moduleId={id} paramId="thickness" />
  </div>
</div>

<style>
  .card {
    width: 220px;
    /* Bumped from 230 to 280 so the 3 CV input handles (top 56, 88,
       120) plus port labels clear the fader grid below. */
    min-height: 280px;
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
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-mono-video);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  .port-label {
    position: absolute;
    font-size: 0.6rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .fader-grid {
    /* Pushed down so the top of the grid clears the lowest CV-input
       handle (top: 120px). Was 28px when INWARDS had no inputs. */
    margin-top: 60px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px 8px;
    justify-items: center;
  }
</style>
