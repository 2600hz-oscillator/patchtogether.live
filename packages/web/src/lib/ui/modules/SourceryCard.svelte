<script lang="ts">
  // SourceryCard — 2-video-input "region shape-match recolor" card.
  //
  // Two video inputs (A top / B bottom) on the left, one video output (OUT) on
  // the right, four knobs (ThrA, ThrB, Skew, Rot). An on-card preview canvas
  // shows the module's OWN output via blitOutputToDrawingBuffer (the same
  // pattern QuadralogicalCard / BackdraftCard use). All jacks render in the
  // shared yellow drill-down <PatchPanel> (post-#767: no raw side <Handle>).

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { sourceryDef } from '$lib/video/modules/sourcery';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/video-res';
  import type { ModuleNode } from '$lib/graph/types';
  import { onMount, onDestroy } from 'svelte';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return sourceryDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => setNodeParam(id, k, v);

  // ---- on-card preview canvas: blit the module's own output ----
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let drawRaf: number | null = null;

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
    drawRaf = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { drawRaf = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { drawRaf = requestAnimationFrame(draw); return; }
    if (!videoEngine) { drawRaf = requestAnimationFrame(draw); return; }
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
    drawRaf = requestAnimationFrame(draw);
  }

  onMount(() => {
    if (canvasEl) { canvasEl.width = 200; canvasEl.height = 150; }
    drawRaf = requestAnimationFrame(draw);
  });
  onDestroy(() => { if (drawRaf !== null) cancelAnimationFrame(drawRaf); });

  // Ports — ids byte-identical to sourceryDef (a/b = video in, out = video).
  const inputs: PortDescriptor[] = [
    { id: 'a', label: 'A', cable: 'video' },
    { id: 'b', label: 'B', cable: 'video' },
    { id: 'thresholdA', label: 'ThrA', cable: 'cv' },
    { id: 'thresholdB', label: 'ThrB', cable: 'cv' },
    { id: 'colorSkew', label: 'Skew', cable: 'cv' },
    { id: 'rotate', label: 'Rot', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [{ id: 'out', label: 'OUT', cable: 'video' }];
</script>

<div class="mod-card sourcery-card" data-testid="sourcery-card" data-node-id={id}>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="SOURCERY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="screen-wrap">
        <canvas bind:this={canvasEl} class="screen" data-testid="sourcery-canvas"></canvas>
      </div>

      <div class="row">
        <Knob
          value={paramVal('thresholdA')}
          min={0} max={1} defaultValue={defaultFor('thresholdA')}
          label="ThrA" curve="linear"
          onchange={set('thresholdA')} moduleId={id} paramId="thresholdA"
        />
        <Knob
          value={paramVal('thresholdB')}
          min={0} max={1} defaultValue={defaultFor('thresholdB')}
          label="ThrB" curve="linear"
          onchange={set('thresholdB')} moduleId={id} paramId="thresholdB"
        />
        <Knob
          value={paramVal('colorSkew')}
          min={0} max={1} defaultValue={defaultFor('colorSkew')}
          label="SKEW" curve="linear"
          onchange={set('colorSkew')} moduleId={id} paramId="colorSkew"
        />
        <Knob
          value={paramVal('rotate')}
          min={0} max={1} defaultValue={defaultFor('rotate')}
          label="ROT" curve="linear"
          onchange={set('rotate')} moduleId={id} paramId="rotate"
        />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 300px;
    min-height: 304px;
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
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
  }
  .screen-wrap {
    margin: 12px auto 12px;
    width: 200px;
    height: 150px;
    border: 1px solid #000;
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #050608;
    border-radius: 3px;
    overflow: hidden;
  }
  .screen {
    width: 200px;
    height: 150px;
    display: block;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0 12px;
  }
</style>
