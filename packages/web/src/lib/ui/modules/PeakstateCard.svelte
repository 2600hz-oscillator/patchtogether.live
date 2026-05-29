<script lang="ts">
  // PeakstateCard — UI for PEAKSTATE, the animated mandala generator.
  //
  // Layout:
  //   Left side:  3 CV inputs (SPD, CMP, CLR) — one per modulatable param.
  //   Right side: 3 video outputs (MONO, RGB, 3D).
  //   Body:       3 knobs (SPEED, COMPLEXITY, COLOR) + a small 144×144
  //               preview canvas wired to the RGB output.
  //
  // The preview pulls `read('previewCanvas')` (the engine-owned
  // OffscreenCanvas the RGB output draws into) and drawImage()s it into
  // our DOM canvas at ~30 Hz. Cheap — no GL readback, no per-frame
  // allocation; same pattern ACIDWARP uses for its on-card preview.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { peakstateDef } from '$lib/video/modules/peakstate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return peakstateDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const setP = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };

  // ---- Preview canvas: poll the engine for the RGB output canvas + blit ----
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = 144;
      canvasEl.height = 144;
    }
    pollTimer = setInterval(() => {
      const e = engineCtx.get(); if (!e || !node || !canvasEl) return;
      const src = e.read(node, 'previewCanvas') as
        | OffscreenCanvas
        | HTMLCanvasElement
        | undefined;
      if (!src) return;
      const ctx2d = canvasEl.getContext('2d', { alpha: false });
      if (!ctx2d) return;
      ctx2d.fillStyle = '#000';
      ctx2d.fillRect(0, 0, canvasEl.width, canvasEl.height);
      try { ctx2d.drawImage(src as CanvasImageSource, 0, 0, canvasEl.width, canvasEl.height); }
      catch { /* never crash the rAF loop on a transient draw failure */ }
    }, 33); // ~30 Hz
  });
  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<div class="mod-card peakstate-card" data-testid="peakstate-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="PEAKSTATE" />

  <!-- CV inputs (left side) -->
  <Handle type="target" position={Position.Left}  id="speed_cv"       style="top: 56px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left"  style="top: 50px;">SPD</span>
  <Handle type="target" position={Position.Left}  id="complexity_cv"  style="top: 88px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left"  style="top: 82px;">CMP</span>
  <Handle type="target" position={Position.Left}  id="color_speed_cv" style="top: 120px; --handle-color: var(--cable-cv);" />
  <span class="port-label left"  style="top: 114px;">CLR</span>

  <!-- Video outputs (right side) -->
  <Handle type="source" position={Position.Right} id="mono_out" style="top: 56px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">MONO</span>
  <Handle type="source" position={Position.Right} id="rgb_out"  style="top: 88px;  --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 82px;">RGB</span>
  <Handle type="source" position={Position.Right} id="out_3d"   style="top: 120px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 114px;">3D</span>

  <div class="screen-wrap">
    <canvas bind:this={canvasEl} class="screen" data-testid="peakstate-preview"></canvas>
  </div>

  <div class="knob-row">
    <Knob
      value={paramVal('speed')}
      min={0.1} max={4} defaultValue={defaultFor('speed')}
      label="SPEED" curve="linear"
      onchange={setP('speed')} moduleId={id} paramId="speed"
    />
    <Knob
      value={paramVal('complexity')}
      min={4} max={32} defaultValue={defaultFor('complexity')}
      label="COMPLEXITY" curve="linear"
      onchange={setP('complexity')} moduleId={id} paramId="complexity"
    />
    <Knob
      value={paramVal('color_speed')}
      min={0} max={4} defaultValue={defaultFor('color_speed')}
      label="COLOR" curve="linear"
      onchange={setP('color_speed')} moduleId={id} paramId="color_speed"
    />
  </div>
</div>

<style>
  .mod-card {
    width: 240px;
    min-height: 320px;
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
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
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
  .screen-wrap {
    margin: 16px auto 12px;
    width: 144px;
    height: 144px;
    border: 1px solid #000;
    background: #000;
    box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.7);
    border-radius: 3px;
    overflow: hidden;
  }
  .screen {
    width: 144px;
    height: 144px;
    display: block;
    image-rendering: auto;
  }
  .knob-row {
    display: flex;
    justify-content: space-around;
    align-items: center;
    padding: 0 8px;
    gap: 4px;
  }
</style>
