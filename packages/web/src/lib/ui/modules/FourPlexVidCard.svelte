<script lang="ts">
  // FourPlexVidCard — UI for 4PLEXVID, the 4-in / 4-out video router.
  //
  // Layout:
  //   Body: 4 discrete selector knobs (one per output) that pick which input
  //         (1..4) that output carries, plus a small live preview of OUT 1.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks). Port `id`s are byte-identical
  // to fourPlexVidDef so the CV bridge + persisted edges route unchanged:
  //   inputs  : in1..in4 (video) + gate1..gate4 (cv)
  //   outputs : out1..out4 (video)
  //
  // Each gate input advances its matching selector on a rising edge (the
  // edge-detect lives in the module factory's setParam). The selector
  // knobs are directly settable here too; both write node.params.sel{N},
  // which persists + syncs.
  import { onMount, onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { fourPlexVidDef } from '$lib/video/modules/4plexvid';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = fourPlexVidDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // Selector value-tag: show 1-based input number (IN1..IN4) instead of
  // the raw 0..3 index.
  function selFmt(v: number): string {
    return `IN${Math.round(v) + 1}`;
  }

  // Ports — ids byte-identical to fourPlexVidDef (in1..in4 = video,
  // gate1..gate4 = cv, out1..out4 = video).
  const inputs = portsFromDef(fourPlexVidDef.inputs, {
    gate1: 'G1', gate2: 'G2', gate3: 'G3', gate4: 'G4',
  });
  const outputs = portsFromDef(fourPlexVidDef.outputs);

  // --- Live preview of OUT 1 (the canonical surface.texture). Mirrors the
  // VideoOutCard blit: ask the engine to render this node's surface FBO
  // into its drawing buffer, then drawImage it into our small canvas. ---
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the rAF loop */ }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      // Aspect-fit the engine surface (4:3) into the small preview.
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      ctx2d.drawImage(src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => { if (rafId !== null) cancelAnimationFrame(rafId); });
</script>

<div class="vcard card video" data-testid="fourplexvid-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="4PLEXVID" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- OUT 1 live preview -->
      <div class="preview-wrap">
        <canvas
          bind:this={canvasEl}
          width={160}
          height={90}
          data-testid="fourplexvid-preview"
          data-node-id={id}
        ></canvas>
        <span class="preview-label">OUT 1</span>
      </div>

      <div class="fader-grid">
        <Fader value={p('sel1')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel1')!.defaultValue} label="OUT1" curve="discrete" formatValue={selFmt} onchange={setParam('sel1')} moduleId={id} paramId="sel1" />
        <Fader value={p('sel2')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel2')!.defaultValue} label="OUT2" curve="discrete" formatValue={selFmt} onchange={setParam('sel2')} moduleId={id} paramId="sel2" />
        <Fader value={p('sel3')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel3')!.defaultValue} label="OUT3" curve="discrete" formatValue={selFmt} onchange={setParam('sel3')} moduleId={id} paramId="sel3" />
        <Fader value={p('sel4')} min={0} max={3} defaultValue={fourPlexVidDef.params.find((x) => x.id === 'sel4')!.defaultValue} label="OUT4" curve="discrete" formatValue={selFmt} onchange={setParam('sel4')} moduleId={id} paramId="sel4" />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 280px;
    min-height: 300px;
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
  }
  .preview-wrap {
    margin: 0 auto;
    width: 160px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .preview-wrap canvas {
    width: 160px;
    height: 90px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: pixelated;
    display: block;
  }
  .preview-label { font-size: 0.55rem; color: var(--text-dim); letter-spacing: 0.1em; font-family: ui-monospace, monospace; }
  .fader-grid {
    margin-top: 16px;
    padding: 0 10px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px 4px;
    justify-items: center;
  }
</style>
