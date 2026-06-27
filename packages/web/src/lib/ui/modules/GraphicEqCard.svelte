<script lang="ts">
  // GraphicEqCard — UI for the Winamp-style graphic-EQ / VU-meter video output.
  // STEREO audio in (A·L / A·R) + one video out. Two switch controls (STYLE:
  // bars|boxes, DISPLAY: mono|stereo) + Gain / Peak / Hue faders. The on-card
  // preview canvas pulls the engine output via blitOutputToDrawingBuffer +
  // drawImage (same path as RUTTETRA / VIDEO-OUT). Hiding the controls turns the
  // card into a resizable full-screen monitor.

  import { onMount, onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { graphicEqDef } from '$lib/video/modules/graphicEq';
  import { startCornerResize } from './card-resize';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  function pdef(name: string): number {
    const def = graphicEqDef.params.find((d) => d.id === name);
    return def?.defaultValue ?? 0;
  }
  function p(name: string): number {
    return node?.params[name] ?? pdef(name);
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs: PortDescriptor[] = [
    { id: 'audio_l', label: 'A·L', cable: 'audio' },
    { id: 'audio_r', label: 'A·R', cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'video' },
  ];

  // Discrete switches (0/1), mirrored from the def (SynesthesiaCard pattern).
  let isBoxes = $derived(Math.round(p('style')) === 1);
  let isStereo = $derived(Math.round(p('display')) === 1);
  function toggleStyle(): void {
    setParam('style')(isBoxes ? 0 : 1);
  }
  function toggleDisplay(): void {
    setParam('display')(isStereo ? 0 : 1);
  }

  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const CANVAS_W = 280;
  const CANVAS_H = 158;

  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 180;
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 360;
  const HEADER_PX = 56;
  const PAD_PX = 20;

  let hideControls = $derived<boolean>(Boolean(node?.data?.hideControls));
  let resizedWidth = $derived<number>(
    (node?.data?.resizedWidth as number | undefined) ?? DEFAULT_WIDTH,
  );
  let resizedHeight = $derived<number>(
    (node?.data?.resizedHeight as number | undefined) ?? DEFAULT_HEIGHT,
  );
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
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (resizeAbort) resizeAbort.abort();
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
  data-testid="graphicEq-card"
  data-node-id={id}
  data-hide-controls={hideControls ? 'true' : 'false'}
  ondblclick={onBodyDblClick}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="GRAPHIC EQ" />

  <button
    type="button"
    class="hide-toggle nodrag"
    aria-label={hideControls ? 'Show GRAPHIC EQ controls' : 'Hide GRAPHIC EQ controls'}
    title={hideControls ? 'Show controls (or double-click frame)' : 'Hide controls'}
    data-testid="graphicEq-hide-toggle"
    onclick={toggleHideControls}
  >{hideControls ? '+' : '–'}</button>

  <PatchPanel nodeId={id} {inputs} {outputs}>
  {#if hideControls}
    <div class="canvas-wrap canvas-wrap-resizable" style="width: {innerWidth}px; height: {innerHeight}px;">
      <canvas
        bind:this={canvasEl}
        width={innerWidth}
        height={innerHeight}
        data-testid="graphicEq-canvas"
        data-node-id={id}
      ></canvas>
    </div>
    <div
      class="resize-handle nodrag"
      role="separator"
      aria-label="Resize GRAPHIC EQ"
      data-testid="graphicEq-resize-handle"
      onpointerdown={onResizeStart}
    ></div>
  {:else}
    <div class="canvas-wrap">
      <canvas
        bind:this={canvasEl}
        width={CANVAS_W}
        height={CANVAS_H}
        data-testid="graphicEq-canvas"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="controls" data-testid="graphicEq-controls">
      <!-- STYLE + DISPLAY switches -->
      <div class="switches">
        <button
          type="button"
          class="switch nodrag"
          data-testid="graphicEq-style"
          aria-pressed={isBoxes}
          title="Toggle bar style"
          onclick={toggleStyle}
        >STYLE: {isBoxes ? 'BOXES' : 'BARS'}</button>
        <button
          type="button"
          class="switch nodrag"
          data-testid="graphicEq-display"
          aria-pressed={isStereo}
          title="Toggle mono / stereo display"
          onclick={toggleDisplay}
        >{isStereo ? 'STEREO' : 'MONO'}</button>
      </div>

      <div class="fader-grid three">
        <Fader value={p('gain')} min={0.5} max={4}    defaultValue={pdef('gain')} label="GAIN" curve="linear" onchange={setParam('gain')} moduleId={id} paramId="gain" />
        <Fader value={p('peak')} min={0.5} max={0.99} defaultValue={pdef('peak')} label="PEAK" curve="linear" onchange={setParam('peak')} moduleId={id} paramId="peak" />
        <Fader value={p('hue')}  min={0}   max={1}    defaultValue={pdef('hue')}  label="HUE"  curve="linear" onchange={setParam('hue')}  moduleId={id} paramId="hue" />
      </div>
    </div>
  {/if}
  </PatchPanel>
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
  .card.hide-controls {
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    min-height: 0;
    padding-bottom: 14px;
    overflow: hidden;
    isolation: isolate;
  }
  .card.resizing {
    transition: none;
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
  .canvas-wrap:not(.canvas-wrap-resizable) canvas {
    height: auto;
  }
  .controls {
    padding: 0 14px;
  }
  .switches {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 10px;
  }
  .switch {
    font-family: ui-monospace, monospace;
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 6px 4px;
    color: var(--text-dim);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: pointer;
  }
  .switch:hover { color: var(--text); border-color: var(--cable-video); }
  .switch[aria-pressed='true'] {
    color: var(--text);
    border-color: var(--cable-video);
    background: color-mix(in srgb, var(--cable-video) 14%, transparent);
  }
  .fader-grid {
    margin-top: 12px;
    display: grid;
    gap: 10px 4px;
    justify-items: center;
  }
  .fader-grid.three {
    grid-template-columns: repeat(3, 1fr);
  }
  .hide-toggle {
    position: absolute;
    top: 4px;
    right: 26px;
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
