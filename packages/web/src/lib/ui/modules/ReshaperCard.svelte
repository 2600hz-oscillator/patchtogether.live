<script lang="ts">
  // ReshaperCard — UI for the RESHAPER fragment-shader raster-scan
  // coordinate REMAP (formerly RUTTETRA). X/Y inputs are mono-video coordinate fields (typically
  // patched from SHAPEDRAMPS); Z is the source video. Combines
  // VideoOutCard's on-card visible canvas (pulled from the engine via
  // drawImage(engine.canvas, ...)) with input handles and faders for
  // intensity, X/Y luma displacement, and color tint.

  import { onMount, onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { reshaperDef } from '$lib/video/modules/reshaper';
  import { startCornerResize } from './card-resize';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  function p(name: string): number {
    const def = reshaperDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // 3 video inputs (x, y, z) + 3 cv inputs (intensity, xDisp, yDisp). Port id
  // MUST match param id for the CV bridge.
  const inputs: PortDescriptor[] = [
    { id: 'x',         label: 'X',  cable: 'mono-video' },
    { id: 'y',         label: 'Y',  cable: 'mono-video' },
    { id: 'z',         label: 'Z',  cable: 'video' },
    { id: 'intensity', label: 'I',  cable: 'cv' },
    { id: 'xDisp',     label: 'XD', cable: 'cv' },
    { id: 'yDisp',     label: 'YD', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'video' },
  ];

  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  const CANVAS_W = 280;
  const CANVAS_H = 158;

  // Hide-controls (video-only resizable) defaults. Min keeps the canvas
  // legible at small zoom. Rounded to whole-u (180px) rack tiles (#759) so
  // default + min land on the grid; user-resizable so the rack CSS doesn't clamp.
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 180;
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 360;
  // Letterbox padding when in hide-controls mode (matches VideoOut).
  const HEADER_PX = 56;
  const PAD_PX = 20;

  let hideControls = $derived<boolean>(
    Boolean(node?.data?.hideControls),
  );
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
      // drawImage() from a WebGL canvas already presents upright; a
      // straight blit is correct. The old scale(1,-1) flipped it upside
      // down. See VideoOutCard for the full rationale.
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

  // Restore defaults via dblclick on the card body when in hide-controls.
  // We stop propagation so the document-level patch-to dblclick (which
  // only fires on .svelte-flow__handle anyway) never triggers; handle
  // dblclicks bubble past us because the handles sit OUTSIDE this body.
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
  data-testid="reshaper-card"
  data-node-id={id}
  data-hide-controls={hideControls ? 'true' : 'false'}
  ondblclick={onBodyDblClick}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="RESHAPER" />

  <button
    type="button"
    class="hide-toggle nodrag"
    aria-label={hideControls ? 'Show RESHAPER controls' : 'Hide RESHAPER controls'}
    title={hideControls ? 'Show controls (or double-click frame)' : 'Hide controls'}
    data-testid="reshaper-hide-toggle"
    onclick={toggleHideControls}
  >{hideControls ? '+' : '–'}</button>

  <PatchPanel nodeId={id} {inputs} {outputs}>
  {#if hideControls}
    <div class="canvas-wrap canvas-wrap-resizable" style="width: {innerWidth}px; height: {innerHeight}px;">
      <canvas
        bind:this={canvasEl}
        width={innerWidth}
        height={innerHeight}
        data-testid="reshaper-canvas"
        data-node-id={id}
      ></canvas>
    </div>
    <div
      class="resize-handle nodrag"
      role="separator"
      aria-label="Resize RESHAPER"
      data-testid="reshaper-resize-handle"
      onpointerdown={onResizeStart}
    ></div>
  {:else}
    <div class="canvas-wrap">
      <canvas
        bind:this={canvasEl}
        width={CANVAS_W}
        height={CANVAS_H}
        data-testid="reshaper-canvas"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="fader-grid" data-testid="reshaper-controls">
      <Fader value={p('intensity')} min={0}  max={2}  defaultValue={reshaperDef.params.find((x) => x.id === 'intensity')!.defaultValue} label="I"   curve="linear" onchange={setParam('intensity')} moduleId={id} paramId="intensity" />
      <Fader value={p('xDisp')}     min={-1} max={1}  defaultValue={reshaperDef.params.find((x) => x.id === 'xDisp')!.defaultValue}     label="XD"  curve="linear" onchange={setParam('xDisp')} moduleId={id} paramId="xDisp" />
      <Fader value={p('yDisp')}     min={-1} max={1}  defaultValue={reshaperDef.params.find((x) => x.id === 'yDisp')!.defaultValue}     label="YD"  curve="linear" onchange={setParam('yDisp')} moduleId={id} paramId="yDisp" />
      <Fader value={p('tintR')}     min={0}  max={1}  defaultValue={reshaperDef.params.find((x) => x.id === 'tintR')!.defaultValue}     label="R"   curve="linear" onchange={setParam('tintR')} moduleId={id} paramId="tintR" />
      <Fader value={p('tintG')}     min={0}  max={1}  defaultValue={reshaperDef.params.find((x) => x.id === 'tintG')!.defaultValue}     label="G"   curve="linear" onchange={setParam('tintG')} moduleId={id} paramId="tintG" />
      <Fader value={p('tintB')}     min={0}  max={1}  defaultValue={reshaperDef.params.find((x) => x.id === 'tintB')!.defaultValue}     label="B"   curve="linear" onchange={setParam('tintB')} moduleId={id} paramId="tintB" />
    </div>
  {/if}
  </PatchPanel>
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
  .card.hide-controls {
    /* Solid black underlay so cables routed behind don't bleed through. */
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
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
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
  .fader-grid {
    margin-top: 10px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px 4px;
    justify-items: center;
  }
  .hide-toggle {
    position: absolute;
    top: 4px;
    /* Sit left of the PatchPanel right-trigger affordance. */
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
