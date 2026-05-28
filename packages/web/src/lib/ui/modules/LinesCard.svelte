<script lang="ts">
  // LinesCard — UI for the Phase 0 LINES procedural source.
  //
  // Mirrors the audio-side card pattern (one Handle per declared port,
  // one fader per param). Visual style sits in the video-domain palette
  // (border accent uses --cable-mono-video so users immediately read the
  // card as "video-domain output").
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { linesDef } from '$lib/video/modules/lines';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = linesDef.params.find((d) => d.id === name);
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
  <ModuleTitle {id} {data} defaultLabel="LINES" />

  <Handle type="target" position={Position.Left} id="fm"        style="top: 56px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label left" style="top: 50px;">FM</span>
  <!-- CV inputs — one per modulatable param. The cross-domain CV
       bridge in VideoEngine routes audio-side cv onto setParam(portId),
       so the handle id MUST match the param id. -->
  <Handle type="target" position={Position.Left} id="orient"    style="top: 92px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 86px;">O</span>
  <Handle type="target" position={Position.Left} id="amp"       style="top: 124px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 118px;">A</span>
  <Handle type="target" position={Position.Left} id="thickness" style="top: 156px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 150px;">T</span>
  <Handle type="target" position={Position.Left} id="phase"     style="top: 188px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 182px;">P</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="fader-grid">
    <Fader value={p('orient')}    min={0}    max={1}  defaultValue={linesDef.params.find((x) => x.id === 'orient')!.defaultValue}    label="Orient"    curve="linear" onchange={setParam('orient')} moduleId={id} paramId="orient" />
    <Fader value={p('amp')}       min={0.5}  max={50} defaultValue={linesDef.params.find((x) => x.id === 'amp')!.defaultValue}       label="Amp"       curve="linear" onchange={setParam('amp')} moduleId={id} paramId="amp" />
    <Fader value={p('thickness')} min={0}    max={1}  defaultValue={linesDef.params.find((x) => x.id === 'thickness')!.defaultValue} label="Thickness" curve="linear" onchange={setParam('thickness')} moduleId={id} paramId="thickness" />
    <Fader value={p('phase')}     min={0}    max={1}  defaultValue={linesDef.params.find((x) => x.id === 'phase')!.defaultValue}     label="Phase"     curve="linear" onchange={setParam('phase')} moduleId={id} paramId="phase" />
  </div>
</div>

<style>
  .card {
    width: 220px;
    /* Bumped from 230 to 320 so the extra 4 CV input handles (top 92,
       124, 156, 188) don't overlap the fader grid below. */
    min-height: 320px;
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
       handle (top: 188px). Was 28px when LINES had only the FM input. */
    margin-top: 110px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 16px;
    justify-items: center;
  }
</style>
