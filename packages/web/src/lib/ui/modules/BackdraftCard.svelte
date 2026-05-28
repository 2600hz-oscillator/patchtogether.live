<script lang="ts">
  // BackdraftCard — UI for BACKDRAFT (video feedback generator).
  //
  // Two video inputs (in_a / in_b) + two KEY masks (lighten / darken) +
  // per-param CV inputs on the left; the `out` video port + an on-card
  // preview canvas (blit from the engine, same pattern as ReshaperCard).
  // Every Fader is wired with moduleId={id} + paramId so MIDI-Learn binds.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, useStore, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc } from '$lib/graph/store';
  import {
    backdraftDef,
    BACKDRAFT_MAX_DELAY_MS,
    BACKDRAFT_MAX_FEEDBACK,
    BACKDRAFT_ZOOM_MIN,
    BACKDRAFT_ZOOM_MAX,
    BACKDRAFT_ROTATE_MIN,
    BACKDRAFT_ROTATE_MAX,
    BACKDRAFT_OFFSET_MIN,
    BACKDRAFT_OFFSET_MAX,
  } from '$lib/video/modules/backdraft';
  import { startCornerResize } from './card-resize';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  function pdef(name: string): number {
    return backdraftDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function p(name: string): number {
    const def = backdraftDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  // ---- DELAY CLOCK override indicator ----
  // When a cable is patched into the `delay_clock` input, the clock drives
  // the feedback delay (one pulse = the delay time) and OVERRIDES the DELAY
  // knob. We show a small "CLK" badge + disable the Delay fader so it reads
  // as overridden. patch.edges is a SyncedStore/Yjs proxy (not a Svelte
  // signal), so we bump a real $state from a Yjs observer to stay reactive
  // on cable add/remove — same pattern as DoomCard's edgesVersion.
  let edgesVersion = $state(0);
  let clockPatched = $derived.by<boolean>(() => {
    void edgesVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && edge.target.portId === 'delay_clock') return true;
    }
    return false;
  });
  let edgesUnobserve: (() => void) | null = null;

  const ENGINE_W = 640;
  const ENGINE_H = 360;
  const CANVAS_W = 280;
  const CANVAS_H = 158;

  const MIN_WIDTH = 240;
  const MIN_HEIGHT = 160;
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 240;
  const HEADER_PX = 56;
  const PAD_PX = 20;

  let hideControls = $derived<boolean>(Boolean(node?.data?.hideControls));
  let resizedWidth = $derived<number>((node?.data?.resizedWidth as number | undefined) ?? DEFAULT_WIDTH);
  let resizedHeight = $derived<number>((node?.data?.resizedHeight as number | undefined) ?? DEFAULT_HEIGHT);
  let innerWidth = $derived(Math.max(MIN_WIDTH - PAD_PX, resizedWidth - PAD_PX));
  let innerHeight = $derived(Math.max(MIN_HEIGHT - HEADER_PX, resizedHeight - HEADER_PX));

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
      ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
    const edgesMap = ydoc.getMap('edges');
    const handler = (): void => { edgesVersion++; };
    edgesMap.observeDeep(handler);
    edgesUnobserve = () => edgesMap.unobserveDeep(handler);
    edgesVersion++; // seed for a patch loaded with the cable already present
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (resizeAbort) resizeAbort.abort();
    if (edgesUnobserve) { try { edgesUnobserve(); } catch { /* */ } edgesUnobserve = null; }
  });

  // ---------- Hide-controls toggle + corner-drag resize ----------
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;

  function toggleHideControls(ev: MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    const next = !target.data.hideControls;
    target.data.hideControls = next;
    if (!next) {
      delete target.data.resizedWidth;
      delete target.data.resizedHeight;
    }
  }

  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: resizedWidth, height: resizedHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          target.data.resizedWidth = w;
          target.data.resizedHeight = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }

  function onBodyDblClick(ev: MouseEvent) {
    if (!hideControls) return;
    const t = ev.target as HTMLElement | null;
    if (t && t.closest('.svelte-flow__handle')) return;
    ev.stopPropagation();
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    target.data.hideControls = false;
    delete target.data.resizedWidth;
    delete target.data.resizedHeight;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
<div
  class="card video"
  class:hide-controls={hideControls}
  class:resizing
  style={hideControls ? `width: ${resizedWidth}px; height: ${resizedHeight}px;` : ''}
  data-testid="backdraft-card"
  data-node-id={id}
  data-hide-controls={hideControls ? 'true' : 'false'}
  ondblclick={onBodyDblClick}
>
  <div class="stripe"></div>
  <header class="title">BACKDRAFT</header>

  <!-- 2 video inputs + 2 key masks -->
  <Handle type="target" position={Position.Left} id="in_a"    style="top: 56px;  --handle-color: var(--cable-video);" />
  {#if !hideControls}<span class="port-label left" style="top: 50px;">A</span>{/if}
  <Handle type="target" position={Position.Left} id="in_b"    style="top: 84px;  --handle-color: var(--cable-video);" />
  {#if !hideControls}<span class="port-label left" style="top: 78px;">B</span>{/if}
  <Handle type="target" position={Position.Left} id="lighten" style="top: 116px; --handle-color: var(--cable-video);" />
  {#if !hideControls}<span class="port-label left" style="top: 110px;">L+</span>{/if}
  <Handle type="target" position={Position.Left} id="darken"  style="top: 144px; --handle-color: var(--cable-video);" />
  {#if !hideControls}<span class="port-label left" style="top: 138px;">D-</span>{/if}

  <!-- CV inputs (port id == param id; lighten/darken CV use the _cv suffix) -->
  <Handle type="target" position={Position.Left} id="mix"        style="top: 180px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 174px;">M</span>{/if}
  <Handle type="target" position={Position.Left} id="feedback"   style="top: 208px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 202px;">FB</span>{/if}
  <Handle type="target" position={Position.Left} id="delay"      style="top: 236px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 230px;">DL</span>{/if}
  <Handle type="target" position={Position.Left} id="luma"       style="top: 264px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 258px;">LU</span>{/if}
  <Handle type="target" position={Position.Left} id="chroma"     style="top: 292px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 286px;">CH</span>{/if}
  <Handle type="target" position={Position.Left} id="r"          style="top: 320px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 314px;">R</span>{/if}
  <Handle type="target" position={Position.Left} id="g"          style="top: 348px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 342px;">G</span>{/if}
  <Handle type="target" position={Position.Left} id="b"          style="top: 376px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 370px;">B</span>{/if}
  <Handle type="target" position={Position.Left} id="lighten_cv" style="top: 404px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 398px;">L</span>{/if}
  <Handle type="target" position={Position.Left} id="darken_cv"  style="top: 432px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 426px;">D</span>{/if}
  <Handle type="target" position={Position.Left} id="zoom"       style="top: 460px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 454px;">ZM</span>{/if}
  <Handle type="target" position={Position.Left} id="rotate"     style="top: 488px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 482px;">RT</span>{/if}
  <Handle type="target" position={Position.Left} id="offsetx"    style="top: 516px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 510px;">OX</span>{/if}
  <Handle type="target" position={Position.Left} id="offsety"    style="top: 544px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 538px;">OY</span>{/if}
  <!-- DELAY CLOCK gate/clock input — overrides the DELAY knob when patched. -->
  <Handle type="target" position={Position.Left} id="delay_clock" style="top: 572px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 566px;">CLK</span>{/if}

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  {#if !hideControls}<span class="port-label right" style="top: 50px;">OUT</span>{/if}

  <button
    type="button"
    class="hide-toggle nodrag"
    aria-label={hideControls ? 'Show BACKDRAFT controls' : 'Hide BACKDRAFT controls'}
    title={hideControls ? 'Show controls (or double-click frame)' : 'Hide controls'}
    data-testid="backdraft-hide-toggle"
    onclick={toggleHideControls}
  >{hideControls ? '+' : '–'}</button>

  {#if hideControls}
    <div class="canvas-wrap canvas-wrap-resizable" style="width: {innerWidth}px; height: {innerHeight}px;">
      <canvas
        bind:this={canvasEl}
        width={innerWidth}
        height={innerHeight}
        data-testid="backdraft-canvas"
        data-node-id={id}
      ></canvas>
    </div>
    <div
      class="resize-handle nodrag"
      role="separator"
      aria-label="Resize BACKDRAFT"
      data-testid="backdraft-resize-handle"
      onpointerdown={onResizeStart}
    ></div>
  {:else}
    <div class="canvas-wrap">
      <canvas
        bind:this={canvasEl}
        width={CANVAS_W}
        height={CANVAS_H}
        data-testid="backdraft-canvas"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="fader-grid" data-testid="backdraft-controls">
      <Fader value={p('mix')}      min={0}  max={1}                     defaultValue={pdef('mix')}      label="Mix"  curve="linear" onchange={setParam('mix')}      moduleId={id} paramId="mix" />
      <Fader value={p('feedback')} min={0}  max={BACKDRAFT_MAX_FEEDBACK} defaultValue={pdef('feedback')} label="FB"   curve="linear" onchange={setParam('feedback')} moduleId={id} paramId="feedback" />
      <div class="delay-cell" class:clk-driven={clockPatched}>
        <Fader value={p('delay')}    min={0}  max={BACKDRAFT_MAX_DELAY_MS} units="ms" defaultValue={pdef('delay')} label={clockPatched ? 'Dly·CLK' : 'Delay'} curve="linear" onchange={setParam('delay')} moduleId={id} paramId="delay" />
        {#if clockPatched}<span class="clk-badge" data-testid="backdraft-clk-badge" title="DELAY CLOCK is driving the feedback delay (knob overridden)">CLK</span>{/if}
      </div>
      <Fader value={p('luma')}     min={-1} max={2}                     defaultValue={pdef('luma')}     label="Luma" curve="linear" onchange={setParam('luma')}     moduleId={id} paramId="luma" />
      <Fader value={p('chroma')}   min={-1} max={2}                     defaultValue={pdef('chroma')}   label="Chr"  curve="linear" onchange={setParam('chroma')}   moduleId={id} paramId="chroma" />
      <Fader value={p('r')}        min={-1} max={2}                     defaultValue={pdef('r')}        label="R"    curve="linear" onchange={setParam('r')}        moduleId={id} paramId="r" />
      <Fader value={p('g')}        min={-1} max={2}                     defaultValue={pdef('g')}        label="G"    curve="linear" onchange={setParam('g')}        moduleId={id} paramId="g" />
      <Fader value={p('b')}        min={-1} max={2}                     defaultValue={pdef('b')}        label="B"    curve="linear" onchange={setParam('b')}        moduleId={id} paramId="b" />
      <Fader value={p('lighten')}  min={0}  max={1}                     defaultValue={pdef('lighten')}  label="Lgt"  curve="linear" onchange={setParam('lighten')}  moduleId={id} paramId="lighten" />
      <Fader value={p('darken')}   min={0}  max={1}                     defaultValue={pdef('darken')}   label="Drk"  curve="linear" onchange={setParam('darken')}   moduleId={id} paramId="darken" />
      <Fader value={p('zoom')}     min={BACKDRAFT_ZOOM_MIN}   max={BACKDRAFT_ZOOM_MAX}   defaultValue={pdef('zoom')}    label="Zoom" curve="linear" onchange={setParam('zoom')}    moduleId={id} paramId="zoom" />
      <Fader value={p('rotate')}   min={BACKDRAFT_ROTATE_MIN} max={BACKDRAFT_ROTATE_MAX} units="°" defaultValue={pdef('rotate')} label="Rot"  curve="linear" onchange={setParam('rotate')}  moduleId={id} paramId="rotate" />
      <Fader value={p('offsetX')}  min={BACKDRAFT_OFFSET_MIN} max={BACKDRAFT_OFFSET_MAX} defaultValue={pdef('offsetX')} label="OffX" curve="linear" onchange={setParam('offsetX')} moduleId={id} paramId="offsetX" />
      <Fader value={p('offsetY')}  min={BACKDRAFT_OFFSET_MIN} max={BACKDRAFT_OFFSET_MAX} defaultValue={pdef('offsetY')} label="OffY" curve="linear" onchange={setParam('offsetY')} moduleId={id} paramId="offsetY" />
    </div>
  {/if}
</div>

<style>
  .card {
    width: 340px;
    min-height: 600px;
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
  .card.hide-controls {
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    min-height: 0;
    padding-bottom: 14px;
    overflow: hidden;
    isolation: isolate;
  }
  .card.resizing { transition: none; }
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
    margin: 12px 18px 8px 44px;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    line-height: 0;
    background: #050608;
  }
  .canvas-wrap-resizable {
    margin: 12px auto 0;
    display: flex;
    justify-content: center;
    align-items: center;
    border: 1px solid var(--cable-video);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    background: #050608;
  }
  .canvas-wrap:not(.canvas-wrap-resizable) canvas { height: auto; }
  .fader-grid {
    margin-top: 10px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px 4px;
    justify-items: center;
  }
  .delay-cell {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  /* When the DELAY CLOCK drives the delay, dim the track + thumb so the
     knob reads as overridden (the fader stays interactive + MIDI-learnable;
     the value-tag + label stay full-opacity so the badge is legible). */
  .delay-cell.clk-driven :global(.track),
  .delay-cell.clk-driven :global(.thumb) {
    opacity: 0.45;
  }
  .clk-badge {
    margin-top: 2px;
    font-size: 0.5rem;
    line-height: 1;
    letter-spacing: 0.05em;
    color: var(--cable-cv, #6cf);
    border: 1px solid var(--cable-cv, #6cf);
    border-radius: 2px;
    padding: 1px 2px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
  .hide-toggle {
    position: absolute;
    top: 4px;
    right: 6px;
    width: 16px;
    height: 16px;
    padding: 0;
    line-height: 14px;
    font-size: 12px;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: pointer;
    z-index: 6;
  }
  .hide-toggle:hover {
    color: var(--text);
    border-color: var(--cable-video);
  }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-video) 50%,
      var(--cable-video) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-video) 70%,
      var(--cable-video) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
