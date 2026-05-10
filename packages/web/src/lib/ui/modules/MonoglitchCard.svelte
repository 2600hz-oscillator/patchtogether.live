<script lang="ts">
  // MonoglitchCard — UI for the MONOGLITCH luma-displacement OUTPUT.
  // Combines VideoOutCard's on-card visible canvas (pulled from the engine
  // via drawImage(engine.canvas, ...)) with extra CV inputs + faders for
  // the H/V ramps, Z displacement, line count, spacing, and color tint.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { monoglitchDef } from '$lib/video/modules/monoglitch';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = monoglitchDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  // Engine render resolution — matches VIDEO_RES in
  // packages/web/src/lib/video/engine.ts. Hardcoded so we don't pull in
  // WebGL boot code just for the constant.
  const ENGINE_W = 640;
  const ENGINE_H = 360;

  // Card-internal canvas size. Matches the small fixed footprint of
  // SCOPE — MONOGLITCH shares "compact display + controls" footprint
  // rather than VideoOutCard's resizable card. Keeps the patch dense.
  const CANVAS_W = 280;
  const CANVAS_H = 158; // 16:9-ish

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
      // PR-85 multi-OUTPUT pattern: ask the engine to copy THIS instance's
      // FBO to its drawing buffer right before we read it, so multiple
      // MONOGLITCH / OUTPUT cards on one engine each render independently.
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
      // Y-flip — same reason as VideoOutCard: WebGL framebuffer is
      // bottom-left origin, 2D canvas is top-left.
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

<div class="card video" data-testid="monoglitch-card" data-node-id={id}>
  <div class="stripe"></div>
  <header class="title">MONOGLITCH</header>

  <!-- Video input + 3 CV inputs. Port id MUST match param id for the CV
       bridge (PatchEngine routes audio cv → setParam(portId)). -->
  <Handle type="target" position={Position.Left} id="in"        style="top: 56px;  --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">VIDEO</span>
  <Handle type="target" position={Position.Left} id="hRamp"     style="top: 92px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 86px;">H</span>
  <Handle type="target" position={Position.Left} id="vRamp"     style="top: 124px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 118px;">V</span>
  <Handle type="target" position={Position.Left} id="intensity" style="top: 156px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 150px;">Z</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="canvas-wrap">
    <canvas
      bind:this={canvasEl}
      width={CANVAS_W}
      height={CANVAS_H}
      data-testid="monoglitch-canvas"
      data-node-id={id}
    ></canvas>
  </div>

  <div class="fader-grid">
    <Fader value={p('hRamp')}     min={-1} max={1}   defaultValue={monoglitchDef.params.find((x) => x.id === 'hRamp')!.defaultValue}     label="H"     curve="linear" onchange={setParam('hRamp')} />
    <Fader value={p('vRamp')}     min={-1} max={1}   defaultValue={monoglitchDef.params.find((x) => x.id === 'vRamp')!.defaultValue}     label="V"     curve="linear" onchange={setParam('vRamp')} />
    <Fader value={p('intensity')} min={0}  max={1}   defaultValue={monoglitchDef.params.find((x) => x.id === 'intensity')!.defaultValue} label="Z"     curve="linear" onchange={setParam('intensity')} />
    <Fader value={p('lines')}     min={8}  max={240} defaultValue={monoglitchDef.params.find((x) => x.id === 'lines')!.defaultValue}     label="Lines" curve="linear" onchange={setParam('lines')} />
    <Fader value={p('spacing')}   min={0}  max={0.95} defaultValue={monoglitchDef.params.find((x) => x.id === 'spacing')!.defaultValue}  label="Gap"   curve="linear" onchange={setParam('spacing')} />
    <Fader value={p('tintR')}     min={0}  max={1}   defaultValue={monoglitchDef.params.find((x) => x.id === 'tintR')!.defaultValue}     label="R"     curve="linear" onchange={setParam('tintR')} />
    <Fader value={p('tintG')}     min={0}  max={1}   defaultValue={monoglitchDef.params.find((x) => x.id === 'tintG')!.defaultValue}     label="G"     curve="linear" onchange={setParam('tintG')} />
    <Fader value={p('tintB')}     min={0}  max={1}   defaultValue={monoglitchDef.params.find((x) => x.id === 'tintB')!.defaultValue}     label="B"     curve="linear" onchange={setParam('tintB')} />
  </div>
</div>

<style>
  .card {
    width: 320px;
    min-height: 420px;
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
    margin: 12px 18px 8px 28px;
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
    grid-template-columns: repeat(4, 1fr);
    gap: 10px 4px;
    justify-items: center;
  }
</style>
