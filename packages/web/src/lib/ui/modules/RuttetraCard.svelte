<script lang="ts">
  // RuttetraCard — UI for the AUTHENTIC forward-scatter Rutt-Etra scope
  // (port of p10entrancer XYZ). ONE Z video input + CV inputs for the
  // expressive params. On-card visible canvas pulled from the engine via
  // drawImage(engine.canvas, ...) (same path as RESHAPER / VIDEO-OUT).
  //
  // Layout follows ReshaperCard: X/Y shape sliders show the
  // linear/triangle/soft/radial label (XYZSettingsSheet.shapeName);
  // X/Y disp + intensity sliders; tint as small R/G/B sliders; and an
  // "Advanced" disclosure for xFreq/yFreq/xPhase/yPhase (matches p10).

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, useStore, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { ruttetraDef } from '$lib/video/modules/ruttetra';
  import { startCornerResize } from './card-resize';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  function pdef(name: string): number {
    const def = ruttetraDef.params.find((d) => d.id === name);
    return def?.defaultValue ?? 0;
  }
  function p(name: string): number {
    return node?.params[name] ?? pdef(name);
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  // XYZSettingsSheet.shapeName — the morph label shown under each shape slider.
  function shapeName(v: number): string {
    const m = Math.max(0, Math.min(1, v));
    if (m < 0.083) return 'linear';
    if (m < 0.25) return 'linear↔triangle';
    if (m < 0.416) return 'triangle';
    if (m < 0.583) return 'triangle↔soft';
    if (m < 0.75) return 'soft';
    if (m < 0.916) return 'soft↔radial';
    return 'radial';
  }
  let xShapeName = $derived(shapeName(p('xShape')));
  let yShapeName = $derived(shapeName(p('yShape')));

  const ENGINE_W = 640;
  const ENGINE_H = 480;
  const CANVAS_W = 280;
  const CANVAS_H = 158;

  const MIN_WIDTH = 240;
  const MIN_HEIGHT = 160;
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 240;
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
  data-testid="ruttetra-card"
  data-node-id={id}
  data-hide-controls={hideControls ? 'true' : 'false'}
  ondblclick={onBodyDblClick}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="RUTTETRA" />

  <!-- 1 video input (z) + 7 cv inputs -->
  <Handle type="target" position={Position.Left} id="z"         style="top: 56px;  --handle-color: var(--cable-video);" />
  {#if !hideControls}<span class="port-label left" style="top: 50px;">Z</span>{/if}
  <Handle type="target" position={Position.Left} id="xShape"    style="top: 92px;  --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 86px;">XS</span>{/if}
  <Handle type="target" position={Position.Left} id="yShape"    style="top: 120px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 114px;">YS</span>{/if}
  <Handle type="target" position={Position.Left} id="xDisp"     style="top: 148px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 142px;">XD</span>{/if}
  <Handle type="target" position={Position.Left} id="yDisp"     style="top: 176px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 170px;">YD</span>{/if}
  <Handle type="target" position={Position.Left} id="intensity" style="top: 204px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 198px;">I</span>{/if}
  <Handle type="target" position={Position.Left} id="xFreq"     style="top: 232px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 226px;">XF</span>{/if}
  <Handle type="target" position={Position.Left} id="yFreq"     style="top: 260px; --handle-color: var(--cable-cv);" />
  {#if !hideControls}<span class="port-label left" style="top: 254px;">YF</span>{/if}

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  {#if !hideControls}<span class="port-label right" style="top: 50px;">OUT</span>{/if}

  <button
    type="button"
    class="hide-toggle nodrag"
    aria-label={hideControls ? 'Show RUTTETRA controls' : 'Hide RUTTETRA controls'}
    title={hideControls ? 'Show controls (or double-click frame)' : 'Hide controls'}
    data-testid="ruttetra-hide-toggle"
    onclick={toggleHideControls}
  >{hideControls ? '+' : '–'}</button>

  {#if hideControls}
    <div class="canvas-wrap canvas-wrap-resizable" style="width: {innerWidth}px; height: {innerHeight}px;">
      <canvas
        bind:this={canvasEl}
        width={innerWidth}
        height={innerHeight}
        data-testid="ruttetra-canvas"
        data-node-id={id}
      ></canvas>
    </div>
    <div
      class="resize-handle nodrag"
      role="separator"
      aria-label="Resize RUTTETRA"
      data-testid="ruttetra-resize-handle"
      onpointerdown={onResizeStart}
    ></div>
  {:else}
    <div class="canvas-wrap">
      <canvas
        bind:this={canvasEl}
        width={CANVAS_W}
        height={CANVAS_H}
        data-testid="ruttetra-canvas"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="controls" data-testid="ruttetra-controls">
      <!-- Shape morph sliders. The current morph name (linear/triangle/
           soft/radial) is shown above each, matching XYZSettingsSheet. -->
      <div class="shape-names">
        <span class="shape-name" data-testid="ruttetra-xshape-name">XS: {xShapeName}</span>
        <span class="shape-name" data-testid="ruttetra-yshape-name">YS: {yShapeName}</span>
      </div>

      <div class="fader-grid five">
        <Fader value={p('xShape')}    min={0}  max={1} defaultValue={pdef('xShape')}    label="XS" curve="linear" onchange={setParam('xShape')}    moduleId={id} paramId="xShape" />
        <Fader value={p('yShape')}    min={0}  max={1} defaultValue={pdef('yShape')}    label="YS" curve="linear" onchange={setParam('yShape')}    moduleId={id} paramId="yShape" />
        <Fader value={p('xDisp')}     min={-1} max={1} defaultValue={pdef('xDisp')}     label="XD" curve="linear" onchange={setParam('xDisp')}     moduleId={id} paramId="xDisp" />
        <Fader value={p('yDisp')}     min={-1} max={1} defaultValue={pdef('yDisp')}     label="YD" curve="linear" onchange={setParam('yDisp')}     moduleId={id} paramId="yDisp" />
        <Fader value={p('intensity')} min={0}  max={2} defaultValue={pdef('intensity')} label="I"  curve="linear" onchange={setParam('intensity')} moduleId={id} paramId="intensity" />
      </div>

      <!-- Tint as small R/G/B sliders. -->
      <div class="fader-grid tint" data-testid="ruttetra-tint">
        <Fader value={p('tintR')} min={0} max={1} defaultValue={pdef('tintR')} label="R" curve="linear" onchange={setParam('tintR')} moduleId={id} paramId="tintR" />
        <Fader value={p('tintG')} min={0} max={1} defaultValue={pdef('tintG')} label="G" curve="linear" onchange={setParam('tintG')} moduleId={id} paramId="tintG" />
        <Fader value={p('tintB')} min={0} max={1} defaultValue={pdef('tintB')} label="B" curve="linear" onchange={setParam('tintB')} moduleId={id} paramId="tintB" />
      </div>

      <!-- Frequency/phase under an Advanced disclosure (matches p10). -->
      <details class="advanced" data-testid="ruttetra-advanced">
        <summary>ADVANCED</summary>
        <div class="fader-grid">
          <Fader value={p('xFreq')}  min={0.25} max={8} defaultValue={pdef('xFreq')}  label="XF" curve="linear" onchange={setParam('xFreq')}  moduleId={id} paramId="xFreq" />
          <Fader value={p('yFreq')}  min={0.25} max={8} defaultValue={pdef('yFreq')}  label="YF" curve="linear" onchange={setParam('yFreq')}  moduleId={id} paramId="yFreq" />
          <Fader value={p('xPhase')} min={0}    max={1} defaultValue={pdef('xPhase')} label="XP" curve="linear" onchange={setParam('xPhase')} moduleId={id} paramId="xPhase" />
          <Fader value={p('yPhase')} min={0}    max={1} defaultValue={pdef('yPhase')} label="YP" curve="linear" onchange={setParam('yPhase')} moduleId={id} paramId="yPhase" />
        </div>
      </details>
    </div>
  {/if}
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
  .shape-names {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    font-family: ui-monospace, monospace;
  }
  .shape-name {
    font-size: 0.58rem;
    color: var(--text-dim);
  }
  .fader-grid {
    margin-top: 10px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px 4px;
    justify-items: center;
  }
  .fader-grid.five {
    grid-template-columns: repeat(5, 1fr);
  }
  .fader-grid.tint {
    grid-template-columns: repeat(3, 1fr);
  }
  .advanced {
    margin-top: 12px;
  }
  .advanced > summary {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    cursor: pointer;
    font-family: ui-monospace, monospace;
    list-style: none;
  }
  .advanced > summary::-webkit-details-marker { display: none; }
  .advanced[open] > summary { color: var(--text); }
  .advanced .fader-grid {
    grid-template-columns: repeat(4, 1fr);
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
