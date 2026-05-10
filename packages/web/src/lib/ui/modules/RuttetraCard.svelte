<script lang="ts">
  // RuttetraCard — UI for the true Rutt/Etra raster-scan-coordinate
  // processor. X/Y inputs are mono-video coordinate fields (typically
  // patched from SHAPEDRAMPS); Z is the source video. Combines
  // VideoOutCard's on-card visible canvas (pulled from the engine via
  // drawImage(engine.canvas, ...)) with input handles and faders for
  // intensity, X/Y luma displacement, and color tint.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { ruttetraDef } from '$lib/video/modules/ruttetra';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = ruttetraDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  const ENGINE_W = 640;
  const ENGINE_H = 360;

  const CANVAS_W = 280;
  const CANVAS_H = 158;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const srcAspect = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    if (dstAspect > srcAspect) {
      const h = ch;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    } else {
      const w = cw;
      const h = Math.round(w / srcAspect);
      return { x: 0, y: Math.round((ch - h) / 2), w, h };
    }
  }

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    let videoEngine: VideoEngine | undefined;
    try {
      videoEngine = e.getDomain<VideoEngine>('video');
    } catch {
      rafId = requestAnimationFrame(draw);
      return;
    }
    if (!videoEngine) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try {
        videoEngine.blitOutputToDrawingBuffer(id);
      } catch {
        // Never let an engine error nuke the rAF loop.
      }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      ctx2d.save();
      ctx2d.translate(r.x, r.y + r.h);
      ctx2d.scale(1, -1);
      ctx2d.drawImage(src, 0, 0, r.w, r.h);
      ctx2d.restore();
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });
</script>

<div class="card video" data-testid="ruttetra-card" data-node-id={id}>
  <div class="stripe"></div>
  <header class="title">RUTTETRA</header>

  <!-- 3 video inputs (x, y, z) + 3 cv inputs (intensity, xDisp, yDisp) -->
  <Handle type="target" position={Position.Left} id="x"         style="top: 56px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label left" style="top: 50px;">X</span>
  <Handle type="target" position={Position.Left} id="y"         style="top: 88px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label left" style="top: 82px;">Y</span>
  <Handle type="target" position={Position.Left} id="z"         style="top: 120px; --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 114px;">Z</span>
  <Handle type="target" position={Position.Left} id="intensity" style="top: 156px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 150px;">I</span>
  <Handle type="target" position={Position.Left} id="xDisp"     style="top: 188px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 182px;">XD</span>
  <Handle type="target" position={Position.Left} id="yDisp"     style="top: 220px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 214px;">YD</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="canvas-wrap">
    <canvas
      bind:this={canvasEl}
      width={CANVAS_W}
      height={CANVAS_H}
      data-testid="ruttetra-canvas"
      data-node-id={id}
    ></canvas>
  </div>

  <div class="fader-grid">
    <Fader value={p('intensity')} min={0}  max={2}  defaultValue={ruttetraDef.params.find((x) => x.id === 'intensity')!.defaultValue} label="I"   curve="linear" onchange={setParam('intensity')} />
    <Fader value={p('xDisp')}     min={-1} max={1}  defaultValue={ruttetraDef.params.find((x) => x.id === 'xDisp')!.defaultValue}     label="XD"  curve="linear" onchange={setParam('xDisp')} />
    <Fader value={p('yDisp')}     min={-1} max={1}  defaultValue={ruttetraDef.params.find((x) => x.id === 'yDisp')!.defaultValue}     label="YD"  curve="linear" onchange={setParam('yDisp')} />
    <Fader value={p('tintR')}     min={0}  max={1}  defaultValue={ruttetraDef.params.find((x) => x.id === 'tintR')!.defaultValue}     label="R"   curve="linear" onchange={setParam('tintR')} />
    <Fader value={p('tintG')}     min={0}  max={1}  defaultValue={ruttetraDef.params.find((x) => x.id === 'tintG')!.defaultValue}     label="G"   curve="linear" onchange={setParam('tintG')} />
    <Fader value={p('tintB')}     min={0}  max={1}  defaultValue={ruttetraDef.params.find((x) => x.id === 'tintB')!.defaultValue}     label="B"   curve="linear" onchange={setParam('tintB')} />
  </div>
</div>

<style>
  .card {
    width: 320px;
    min-height: 480px;
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
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
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
  .canvas-wrap {
    margin: 12px 18px 8px 40px;
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
  .fader-grid {
    margin-top: 10px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px 4px;
    justify-items: center;
  }
</style>
