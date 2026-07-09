<script lang="ts">
  // FreezeframeCard — UI for FREEZEFRAME, the video sample & hold +
  // per-channel posterize module.
  //
  // Layout:
  //   Left:   video_in (VID) + gate_in (GATE).
  //   Right:  video_out (OUT) + r_out / g_out / b_out / luma_out (R/G/B/L).
  //   Body:   4 QUANT knobs (R/G/B/LUMA) + a live preview of video_out.
  //
  // The S&H + posterize logic lives in the module factory; this card just
  // wires the knobs to node.params and shows a small preview of the
  // combined output (the canonical surface.texture), mirroring
  // FourPlexVidCard's blit.
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { freezeframeDef } from '$lib/video/modules/freezeframe';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = freezeframeDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function def(name: string) {
    return freezeframeDef.params.find((x) => x.id === name)!;
  }

  const inputs = portsFromDef(freezeframeDef.inputs, { video_in: 'VIDEO', gate_in: 'GATE' });
  const outputs = portsFromDef(freezeframeDef.outputs, {
    video_out: 'OUT', r_out: 'R', g_out: 'G', b_out: 'B', luma_out: 'LUMA',
  });

  // --- Live preview of video_out (the canonical surface.texture). ---
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  // Bigger on-card preview (fills the previously-empty card body). 4:3 box.
  const PREVIEW_W = 228;
  const PREVIEW_H = Math.round(PREVIEW_W * (ENGINE_H / ENGINE_W)); // 171
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

<div class="vcard card video" data-testid="freezeframe-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="FREEZEFRAME" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- video_out live preview (enlarged to fill the card body) -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={PREVIEW_W}
        height={PREVIEW_H}
        data-testid="freezeframe-preview"
        data-node-id={id}
      ></canvas>
      <span class="preview-label">OUT</span>
    </div>

    <div class="fader-grid">
      <Fader value={p('quant_r')}    min={0} max={1} defaultValue={def('quant_r').defaultValue}    label="QUANT R"    curve="linear" onchange={setParam('quant_r')}    moduleId={id} paramId="quant_r" />
      <Fader value={p('quant_g')}    min={0} max={1} defaultValue={def('quant_g').defaultValue}    label="QUANT G"    curve="linear" onchange={setParam('quant_g')}    moduleId={id} paramId="quant_g" />
      <Fader value={p('quant_b')}    min={0} max={1} defaultValue={def('quant_b').defaultValue}    label="QUANT B"    curve="linear" onchange={setParam('quant_b')}    moduleId={id} paramId="quant_b" />
      <Fader value={p('quant_luma')} min={0} max={1} defaultValue={def('quant_luma').defaultValue} label="QUANT LUMA" curve="linear" onchange={setParam('quant_luma')} moduleId={id} paramId="quant_luma" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 260px;
    min-height: 460px;
  }
  .preview-wrap {
    margin: 8px auto 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .preview-wrap canvas {
    width: 228px;
    height: 171px;
    max-width: calc(100% - 28px);
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: pixelated;
    display: block;
  }
  .preview-label { font-size: 0.55rem; color: var(--text-dim); letter-spacing: 0.1em; font-family: ui-monospace, monospace; }
  .fader-grid {
    margin-top: 22px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 26px 6px;
    justify-items: center;
  }
</style>
