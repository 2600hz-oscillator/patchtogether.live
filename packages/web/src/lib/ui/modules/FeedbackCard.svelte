<script lang="ts">
  // FeedbackCard — analog-video-style feedback loop. Lots of CV inputs
  // (one per warp param) so external modulation can drive the warp
  // dynamically.
  //
  // A live VIDEO PREVIEW sits at the top: each rAF we ask the shared video
  // engine to blit THIS node's output into its drawing buffer, then draw that
  // buffer into the on-card canvas (the same blitOutputToDrawingBuffer pattern
  // BackdraftCard / QuadralogicalCard / ReshaperCard use). It shows the module's
  // canonical feedback render whether or not the OUT port is patched.
  import { type NodeProps } from '@xyflow/svelte';
  import { onMount, onDestroy } from 'svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { feedbackDef } from '$lib/video/modules/feedback';
  import { useEngine } from '$lib/audio/engine-context';
  import { VIDEO_RES, type VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = feedbackDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs: PortDescriptor[] = [
    { id: 'in',      label: 'IN',     cable: 'video' },
    { id: 'wet',     label: 'WET',    cable: 'cv' },
    { id: 'decay',   label: 'DECAY',  cable: 'cv' },
    { id: 'zoom',    label: 'ZOOM',   cable: 'cv' },
    { id: 'rotate',  label: 'ROTATE', cable: 'cv' },
    { id: 'offsetX', label: 'OFF X',  cable: 'cv' },
    { id: 'offsetY', label: 'OFF Y',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];

  // ---- live output preview (blit from the shared video engine) ----
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const CANVAS_W = 320;
  const CANVAS_H = 180;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // Letterbox the engine's aspect into the canvas without distortion.
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

  function draw(): void {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the loop */ }
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

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => { if (rafId !== null) cancelAnimationFrame(rafId); });
</script>

<div class="card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="FEEDBACK" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- live output preview (the canonical feedback render) -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={CANVAS_W}
        height={CANVAS_H}
        data-testid="feedback-canvas"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="fader-grid">
      <Fader value={p('wet')}     min={0}    max={1}   defaultValue={feedbackDef.params.find((x) => x.id === 'wet')!.defaultValue}     label="Wet"    curve="linear" onchange={setParam('wet')} moduleId={id} paramId="wet" />
      <Fader value={p('decay')}   min={0}    max={2}   defaultValue={feedbackDef.params.find((x) => x.id === 'decay')!.defaultValue}   label="Decay"  curve="linear" onchange={setParam('decay')} moduleId={id} paramId="decay" />
      <Fader value={p('zoom')}    min={0.9}  max={1.1} defaultValue={feedbackDef.params.find((x) => x.id === 'zoom')!.defaultValue}    label="Zoom"   curve="linear" onchange={setParam('zoom')} moduleId={id} paramId="zoom" />
      <Fader value={p('rotate')}  min={-3.14159} max={3.14159} defaultValue={feedbackDef.params.find((x) => x.id === 'rotate')!.defaultValue}  label="Rot"    curve="linear" onchange={setParam('rotate')} moduleId={id} paramId="rotate" />
      <Fader value={p('offsetX')} min={-1}   max={1}   defaultValue={feedbackDef.params.find((x) => x.id === 'offsetX')!.defaultValue} label="OffX"   curve="linear" onchange={setParam('offsetX')} moduleId={id} paramId="offsetX" />
      <Fader value={p('offsetY')} min={-1}   max={1}   defaultValue={feedbackDef.params.find((x) => x.id === 'offsetY')!.defaultValue} label="OffY"   curve="linear" onchange={setParam('offsetY')} moduleId={id} paramId="offsetY" />
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
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-video); }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  /* Live output preview at the top (the canonical feedback render). */
  .preview-wrap {
    margin: 4px 16px 0;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    line-height: 0;
    background: #050608;
  }
  .preview-wrap canvas {
    display: block;
    width: 100%;
    height: auto;
    image-rendering: auto;
    background: #050608;
  }
  .fader-grid {
    margin-top: 16px;
    padding: 0 10px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px 6px;
    justify-items: center;
  }
</style>
