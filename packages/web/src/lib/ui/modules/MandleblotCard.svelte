<script lang="ts">
  // MandleblotCard — UI for the MANDLEBLOT fractal generator.
  //
  // Card layout (compact, no resize):
  //   - Small live preview (~160×144) of the COLOUR output. Pulled from
  //     the engine via blitOutputToDrawingBuffer(id) + drawImage, exactly
  //     like MONOGLITCH / BENTBOX. The mono pass renders into its own
  //     FBO; the preview always shows colour (the "interesting" one).
  //   - Six knobs in two rows of three: ZOOM / ITER / COLOR + ROT / X / Y.
  //   - Patch panel: 1 input (zoom_cv), 2 outputs (MONO, COLOR).
  //   - Zoom readout below the ZOOM knob ("×10", "×1k", "×100k") so the
  //     user can read the real zoom factor (since the knob is presented
  //     0..1 and the mapping is log).

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { mandleblotDef, jsZoomFromKnob } from '$lib/video/modules/mandleblot';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const { defaultFor, paramVal, set } = cardParams(mandleblotDef, () => id, () => node);

  // Engine render resolution (VIDEO_RES). Used to letterbox the preview
  // so a 4:3 fractal render fits the card's preview rect without skew.
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  // Preview canvas — small, fixed. The card stays compact per spec.
  const CANVAS_W = 200;
  const CANVAS_H = Math.round(CANVAS_W * (ENGINE_H / ENGINE_W)); // 4:3 → 150

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
        // surface.texture == color_out's FBO texture, so the preview
        // shows the colour pass. (mono_out is reachable downstream via
        // the multi-output read('outputTexture:mono_out') path.)
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
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  // Zoom readout — show the post-mapping factor so the user can read
  // "I'm at 1000×" rather than the bare 0..1 knob position.
  let zoomFactor = $derived(jsZoomFromKnob(paramVal('zoom')));
  let zoomLabel = $derived(formatZoom(zoomFactor));

  function formatZoom(z: number): string {
    if (z < 10) return `${z.toFixed(1)}×`;
    if (z < 1000) return `${Math.round(z)}×`;
    if (z < 1_000_000) return `${(z / 1000).toFixed(z < 10000 ? 1 : 0)}k×`;
    return `${(z / 1_000_000).toFixed(1)}M×`;
  }

  const inputs = portsFromDef(mandleblotDef.inputs, { zoom_cv: 'ZOOM' });
  const outputs = portsFromDef(mandleblotDef.outputs, { mono_out: 'MONO', color_out: 'COLOR' });
</script>

<div class="mod-card mandleblot-card" data-testid="mandleblot-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="MANDLEBLOT" />

  <!-- Patch panel: 1 CV input (zoom_cv), 2 video outputs (MONO, COLOR). -->
  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="screen-wrap">
    <canvas
      bind:this={canvasEl}
      width={CANVAS_W}
      height={CANVAS_H}
      data-testid="mandleblot-canvas"
      data-node-id={id}
    ></canvas>
  </div>

  <div class="knob-grid" data-testid="mandleblot-controls">
    <div class="knob-cell">
      <Knob
        value={paramVal('zoom')}
        min={0} max={1} defaultValue={defaultFor('zoom')}
        label="ZOOM" curve="log"
        onchange={set('zoom')} moduleId={id} paramId="zoom"
      />
      <div class="zoom-readout" data-testid="mandleblot-zoom-readout">{zoomLabel}</div>
    </div>
    <Knob
      value={paramVal('iterations')}
      min={50} max={500} defaultValue={defaultFor('iterations')}
      label="ITER" curve="discrete"
      onchange={set('iterations')} moduleId={id} paramId="iterations"
    />
    <Knob
      value={paramVal('color_cycle')}
      min={0} max={4} defaultValue={defaultFor('color_cycle')}
      label="COLOR" curve="linear"
      onchange={set('color_cycle')} moduleId={id} paramId="color_cycle"
    />
    <Knob
      value={paramVal('rotation')}
      min={0} max={1} defaultValue={defaultFor('rotation')}
      label="ROT" curve="linear"
      onchange={set('rotation')} moduleId={id} paramId="rotation"
    />
    <Knob
      value={paramVal('center_x')}
      min={-2} max={2} defaultValue={defaultFor('center_x')}
      label="X" curve="linear"
      onchange={set('center_x')} moduleId={id} paramId="center_x"
    />
    <Knob
      value={paramVal('center_y')}
      min={-2} max={2} defaultValue={defaultFor('center_y')}
      label="Y" curve="linear"
      onchange={set('center_y')} moduleId={id} paramId="center_y"
    />
  </div>
  </PatchPanel>
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
  .screen-wrap {
    margin: 12px auto 8px;
    width: 200px;
    height: 112px;
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
  .knob-grid {
    margin-top: 6px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px 4px;
    justify-items: center;
  }
  .knob-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .zoom-readout {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    min-width: 44px;
    text-align: center;
  }
</style>
