<script lang="ts">
  // MandelbulbCard — UI for the MANDELBULB 3D ray-marched fractal source.
  //
  // Card layout:
  //   - Live preview (~200×150) of the video_out render. Pulled from the
  //     engine via blitOutputToDrawingBuffer(id) + drawImage, exactly like
  //     MANDLEBLOT / MONOGLITCH / BENTBOX.
  //   - Six knobs (ZOOM / ROT X / ROT Y / POWER / DETAIL / HUE) — EACH also
  //     has a matching CV input port on the left (zoom + spatial controls
  //     under both CV and knobs, per the user's requirement).
  //   - SPIN + SCRN toggle buttons (auto-rotate; screen-off perf gate).
  //   - Patch panel: 6 CV inputs, 1 mono-video output (VIDEO).
  //
  // PERF: the SCRN toggle drives the `screen_on` param. When OFF *and*
  // video_out is unpatched, the engine module skips the (expensive)
  // raymarch entirely. When SCRN is OFF we also stop pulling the preview so
  // the on-card rAF does no work either.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { mandelbulbDef } from '$lib/video/modules/mandelbulb';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return mandelbulbDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function minFor(k: string): number {
    return mandelbulbDef.params.find((p) => p.id === k)?.min ?? 0;
  }
  function maxFor(k: string): number {
    return mandelbulbDef.params.find((p) => p.id === k)?.max ?? 1;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  // Engine render resolution (VIDEO_RES) — letterbox the 4:3 render.
  const ENGINE_W = 640;
  const ENGINE_H = 480;
  const CANVAS_W = 200;
  const CANVAS_H = Math.round(CANVAS_W * (ENGINE_H / ENGINE_W)); // 150

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // SCRN / SPIN toggles.
  let screenOn = $derived(paramVal('screen_on') >= 0.5);
  let spinOn = $derived(paramVal('autospin') >= 0.5);
  function toggleScreen(): void { set('screen_on')(screenOn ? 0 : 1); }
  function toggleSpin(): void { set('autospin')(spinOn ? 0 : 1); }

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const srcAspect = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    if (dstAspect > srcAspect) {
      const h = ch;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    }
    const w = cw;
    const h = Math.round(w / srcAspect);
    return { x: 0, y: Math.round((ch - h) / 2), w, h };
  }

  // Paint a flat "screen off" panel (cheap + idempotent).
  let screenOffPainted = false;
  function paintScreenOff(): void {
    if (screenOffPainted || !canvasEl) return;
    const c2d = canvasEl.getContext('2d', { alpha: false });
    if (!c2d) return;
    c2d.fillStyle = '#050608';
    c2d.fillRect(0, 0, canvasEl.width, canvasEl.height);
    c2d.fillStyle = 'rgba(255,255,255,0.28)';
    c2d.font = '11px monospace';
    c2d.fillText('SCREEN OFF', 10, 20);
    screenOffPainted = true;
  }

  function draw() {
    rafId = requestAnimationFrame(draw);
    // SCRN off ⇒ skip the preview pull entirely (the engine module also
    // skips its render when video_out is unpatched).
    if (!screenOn) { paintScreenOff(); return; }
    screenOffPainted = false;
    const e = engineCtx.get();
    if (!e || !canvasEl) return;
    let videoEngine: VideoEngine | undefined;
    try {
      videoEngine = e.getDomain<VideoEngine>('video');
    } catch {
      return;
    }
    if (!videoEngine) return;
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    try {
      videoEngine.blitOutputToDrawingBuffer(id);
    } catch {
      // Don't let engine errors nuke the rAF loop.
    }
    const src = videoEngine.canvas as CanvasImageSource;
    const cw = canvasEl.width;
    const ch = canvasEl.height;
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    const r = fitRect(cw, ch);
    ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  // Knob + matching CV-input descriptor list (the CV port id is `${pid}_cv`).
  const CONTROLS: Array<{ pid: string; label: string; portLabel: string; curve: 'linear' | 'log' | 'discrete' }> = [
    { pid: 'zoom',     label: 'ZOOM',  portLabel: 'ZOOM', curve: 'log' },
    { pid: 'rotate_x', label: 'ROT X', portLabel: 'RTX',  curve: 'linear' },
    { pid: 'rotate_y', label: 'ROT Y', portLabel: 'RTY',  curve: 'linear' },
    { pid: 'power',    label: 'POWER', portLabel: 'PWR',  curve: 'linear' },
    { pid: 'detail',   label: 'DETAIL',portLabel: 'DET',  curve: 'discrete' },
    { pid: 'hue',      label: 'HUE',   portLabel: 'HUE',  curve: 'linear' },
  ];
</script>

<div class="mod-card mandelbulb-card" data-testid="mandelbulb-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="MANDELBULB" />

  <!-- CV inputs (one per spatial/zoom control) down the left edge. -->
  {#each CONTROLS as c, i (c.pid)}
    <Handle
      type="target"
      position={Position.Left}
      id={`${c.pid}_cv`}
      style={`top: ${56 + i * 26}px; --handle-color: var(--cable-cv);`}
    />
    <span class="port-label left" style={`top: ${50 + i * 26}px;`}>{c.portLabel}</span>
  {/each}

  <!-- Mono-video output. -->
  <Handle type="source" position={Position.Right} id="video_out" style="top: 56px; --handle-color: var(--cable-mono-video, var(--cable-video));" />
  <span class="port-label right" style="top: 50px;">VIDEO</span>

  <div class="screen-wrap">
    <canvas
      bind:this={canvasEl}
      width={CANVAS_W}
      height={CANVAS_H}
      data-testid="mandelbulb-canvas"
      data-node-id={id}
    ></canvas>
  </div>

  <div class="toggles">
    <button
      class="toggle"
      class:on={spinOn}
      onclick={toggleSpin}
      data-testid="mandelbulb-spin-toggle"
      title="SPIN: auto-rotate the bulb's yaw"
    >SPIN: {spinOn ? 'ON' : 'OFF'}</button>
    <button
      class="toggle"
      class:on={screenOn}
      onclick={toggleScreen}
      data-testid="mandelbulb-screen-toggle"
      title="SCREEN: turn the preview OFF to save performance. When OFF and VIDEO is unpatched, the raymarch is skipped entirely."
    >SCRN: {screenOn ? 'ON' : 'OFF'}</button>
  </div>

  <div class="knob-grid" data-testid="mandelbulb-controls">
    {#each CONTROLS as c (c.pid)}
      <Knob
        value={paramVal(c.pid)}
        min={minFor(c.pid)} max={maxFor(c.pid)} defaultValue={defaultFor(c.pid)}
        label={c.label} curve={c.curve}
        onchange={set(c.pid)} moduleId={id} paramId={c.pid}
        readLive={live(c.pid)}
      />
    {/each}
  </div>
</div>

<style>
  .mod-card {
    width: 280px;
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
  .port-label.left  { left: 14px; }
  .port-label.right { right: 14px; }
  .screen-wrap {
    margin: 12px auto 8px;
    width: 200px;
    height: 150px;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    background: #050608;
    line-height: 0;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    background: #050608;
  }
  .toggles {
    display: flex;
    gap: 8px;
    padding: 0 14px;
    margin-bottom: 6px;
  }
  .toggle {
    flex: 1; font-family: ui-monospace, monospace; font-size: 0.6rem;
    padding: 4px 6px; border-radius: 3px; cursor: pointer;
    background: var(--module-bg); color: var(--text-dim);
    border: 1px solid var(--border);
  }
  .toggle:hover { border-color: var(--accent-dim); }
  .toggle.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }
  .knob-grid {
    margin-top: 6px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px 4px;
    justify-items: center;
  }
</style>
