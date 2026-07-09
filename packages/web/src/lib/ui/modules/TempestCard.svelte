<script lang="ts">
  // TempestCard — UI for the TEMPEST module (P1). A live preview of the vector
  // well (blitted from the engine output, same path as RUTTETRA / VIDEO-OUT), a
  // RIM knob (also the CV target for the claw's rim position), and a SHAPE button
  // cycling the tube cross-section. Enemies / fire / score arrive in later phases.

  import { onMount, onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { tempestDef } from '$lib/video/modules/tempest';
  import { TUBE_SHAPES } from '$lib/video/tempest/tempest-core';
  import { VIDEO_RES, type VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function pdef(name: string): number {
    return tempestDef.params.find((d) => d.id === name)?.defaultValue ?? 0;
  }
  function p(name: string): number {
    const v = node?.params?.[name];
    return typeof v === 'number' ? v : pdef(name);
  }
  const { set } = cardParams(tempestDef, () => id, () => node);

  const inputs = portsFromDef(tempestDef.inputs);
  const outputs = portsFromDef(tempestDef.outputs);

  const SHAPE_NAMES = TUBE_SHAPES;
  let shapeName = $derived(SHAPE_NAMES[Math.round(p('shape')) % SHAPE_NAMES.length]);

  function cycleShape() {
    const t = patch.nodes[id];
    if (!t) return;
    const cur = Math.round((t.params.shape as number) ?? 0);
    t.params.shape = (cur + 1) % SHAPE_NAMES.length;
  }

  // ---- Live preview: blit this node's engine output to the card canvas. ----
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const CANVAS_W = 280;
  const CANVAS_H = 210;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const srcA = ENGINE_W / ENGINE_H;
    const dstA = cw / ch;
    if (dstA > srcA) {
      const h = ch;
      const w = Math.round(h * srcA);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    }
    const w = cw;
    const h = Math.round(w / srcA);
    return { x: 0, y: Math.round((ch - h) / 2), w, h };
  }

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never kill the rAF loop */ }
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      ctx2d.drawImage(videoEngine.canvas as CanvasImageSource, r.x, r.y, r.w, r.h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => { if (rafId !== null) cancelAnimationFrame(rafId); });
</script>

<div class="card video tempest-card" data-testid="tempest-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="TEMPEST" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="canvas-wrap">
      <canvas
        bind:this={canvasEl}
        width={CANVAS_W}
        height={CANVAS_H}
        data-testid="tempest-canvas"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="controls">
      <div class="knob-box">
        <Knob
          value={p('rim')}
          min={0} max={1} defaultValue={pdef('rim')}
          label="RIM" curve="linear"
          onchange={set('rim')} moduleId={id} paramId="rim"
        />
      </div>
      <button
        class="btn"
        onclick={cycleShape}
        data-testid="tempest-shape"
        title="Cycle the tube cross-section"
      >SHAPE: {shapeName}</button>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 320px;
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
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
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
  .canvas-wrap {
    margin: 12px 18px 8px;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    line-height: 0;
    background: #050608;
  }
  canvas {
    display: block;
    width: 100%;
    height: auto;
    image-rendering: pixelated;
    background: #050608;
  }
  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 0 16px;
  }
  .knob-box {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    padding: 6px 12px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .btn:hover { border-color: var(--accent-dim); }
</style>
