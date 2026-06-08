<script lang="ts">
  // CirclesCard — UI for the CIRCLES stateful particle video generator.
  //
  // Left rail: GATE (spawn trigger) + D/V/SPD/DECAY CV inputs + the VIDEO
  // input (used by the `mapped` output). Right rail: the four outputs (OVERLAP
  // / CONTOUR / COMBINE / MAPPED). Five knobs (D/V/SPD/DECAY/RATE) + a live
  // preview of the COMBINE output (blitted from the factory's scene canvas,
  // same pattern ShapegenCard uses).

  import type { NodeProps } from '@xyflow/svelte';
  import { Handle, Position } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { circlesDef, CIRCLES_GATE_PORT_ID } from '$lib/video/modules/circles';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { onMount, onDestroy } from 'svelte';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return circlesDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };

  // ----- Preview canvas: blit the engine's COMBINE scene canvas -----
  let previewEl: HTMLCanvasElement | null = $state(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    if (previewEl) {
      previewEl.width = 168;
      previewEl.height = 168;
    }
    pollTimer = setInterval(() => {
      const e = engineCtx.get(); if (!e || !node || !previewEl) return;
      const scene = e.read(node, 'sceneCanvas') as
        | OffscreenCanvas | HTMLCanvasElement | undefined;
      if (!scene) return;
      const c2d = previewEl.getContext('2d');
      if (!c2d) return;
      c2d.drawImage(scene as CanvasImageSource, 0, 0, previewEl.width, previewEl.height);
    }, 33); // ~30 Hz
  });
  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });

  // [GATED] hint: lights when the gate input is the target of any edge.
  let gatePatched = $derived<boolean>(
    Object.values(patch.edges ?? {}).some(
      (e) => e?.target?.nodeId === id && e?.target?.portId === CIRCLES_GATE_PORT_ID,
    ),
  );
</script>

<div class="mod-card circles-card" data-testid="circles-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="circles" />

  <!-- Left rail: gate spawn + D/V/SPD/DECAY CV + video input. -->
  <Handle type="target" position={Position.Left} id={CIRCLES_GATE_PORT_ID} style="top: 56px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">GATE</span>
  <Handle type="target" position={Position.Left} id="d"   style="top: 88px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 82px;">D</span>
  <Handle type="target" position={Position.Left} id="v"   style="top: 120px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 114px;">V</span>
  <Handle type="target" position={Position.Left} id="spd" style="top: 152px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 146px;">SPD</span>
  <Handle type="target" position={Position.Left} id="decay" style="top: 184px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 178px;">DEC</span>
  <Handle type="target" position={Position.Left} id="video" style="top: 216px; --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 210px;">VID</span>

  <!-- Right rail: the four outputs. -->
  <Handle type="source" position={Position.Right} id="overlap" style="top: 56px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">OVR</span>
  <Handle type="source" position={Position.Right} id="contour" style="top: 88px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 82px;">CNT</span>
  <Handle type="source" position={Position.Right} id="combine" style="top: 120px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 114px;">CMB</span>
  <Handle type="source" position={Position.Right} id="mapped"  style="top: 152px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 146px;">MAP</span>

  <div class="screen-wrap">
    {#if gatePatched}
      <span class="gated-badge" data-testid="circles-gated-badge">[GATED]</span>
    {/if}
    <canvas bind:this={previewEl} class="screen" data-testid="circles-screen"></canvas>
  </div>

  <div class="row">
    <Knob value={paramVal('d')}     min={0} max={1} defaultValue={defaultFor('d')}     label="D"    curve="linear" onchange={set('d')}     moduleId={id} paramId="d" />
    <Knob value={paramVal('v')}     min={0} max={1} defaultValue={defaultFor('v')}     label="V"    curve="linear" onchange={set('v')}     moduleId={id} paramId="v" />
    <Knob value={paramVal('spd')}   min={0} max={1} defaultValue={defaultFor('spd')}   label="SPD"  curve="linear" onchange={set('spd')}   moduleId={id} paramId="spd" />
    <Knob value={paramVal('decay')} min={0} max={1} defaultValue={defaultFor('decay')} label="DEC"  curve="linear" onchange={set('decay')} moduleId={id} paramId="decay" />
    <Knob value={paramVal('rate')}  min={0} max={1} defaultValue={defaultFor('rate')}  label="RATE" curve="linear" onchange={set('rate')}  moduleId={id} paramId="rate" />
  </div>
</div>

<style>
  .mod-card {
    width: 260px;
    min-height: 360px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .port-label { position: absolute; font-size: 0.6rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .screen-wrap {
    margin: 12px auto 12px;
    width: 168px;
    height: 168px;
    border: 1px solid #000;
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #000;
    border-radius: 3px;
    overflow: hidden;
    position: relative;
  }
  .gated-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.08em;
    color: #87c8ff;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid #87c8ff;
    border-radius: 2px;
    padding: 1px 4px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
    z-index: 2;
  }
  .screen { width: 168px; height: 168px; display: block; }
  .row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 8px;
  }
</style>
