<script lang="ts">
  // PosterboxCard — UI for POSTERBOX (retro palette-crush video processor).
  //
  // Single video input (in) → video output (out). Three knobs:
  //   DEPTH (a 5-step DISCRETE knob snapping to the retro bit-allocation
  //   ladder 1-1-1 / 2-2-2 / 3-3-2 / 4-4-4 / 5-6-5) + DITHER (Bayer 4×4
  //   ordered-dither amount) + MIX (dry/wet). DEPTH displays its current
  //   allocation name + palette size on the card. Each knob has a matching
  //   per-param CV input. A live preview of the crushed OUT is shown
  //   (mirrors CellshadeCard's blit).
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    posterboxDef,
    posterboxDepthIndex,
    posterboxColorCount,
    POSTERBOX_DEPTH_STEPS,
  } from '$lib/video/modules/posterbox';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = posterboxDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number {
    return posterboxDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // --- DEPTH discrete display: the knob value is a step INDEX 0..4; show
  // the per-channel allocation name (1-bit/2-2-2/3-3-2/4-4-4/5-6-5) + the
  // palette size below it. Ticks are labelled with the TOTAL bit depth. ---
  const DEPTH_MAX_INDEX = POSTERBOX_DEPTH_STEPS.length - 1;
  const DEPTH_TICKS = POSTERBOX_DEPTH_STEPS.map((s, i) => ({
    frac: DEPTH_MAX_INDEX > 0 ? i / DEPTH_MAX_INDEX : 0,
    label: String(s.bits[0] + s.bits[1] + s.bits[2]),
  }));
  function formatDepth(v: number): string {
    return POSTERBOX_DEPTH_STEPS[posterboxDepthIndex(v)]!.name;
  }
  let depthName = $derived(POSTERBOX_DEPTH_STEPS[posterboxDepthIndex(p('depth'))]!.name);
  let colorCount = $derived(posterboxColorCount(p('depth')));

  // --- Live preview of OUT (the canonical surface.texture). ---
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

  const inputs = portsFromDef(posterboxDef.inputs);
  const outputs = portsFromDef(posterboxDef.outputs);
</script>

<div class="vcard card video" data-testid="posterbox-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="POSTERBOX" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- OUT live preview -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={160}
        height={120}
        data-testid="posterbox-preview"
        data-node-id={id}
      ></canvas>
      <span class="preview-label" data-testid="posterbox-depth-readout">{depthName} · {colorCount} COL</span>
    </div>

    <div class="fader-grid">
      <Fader
        value={p('depth')}
        min={0}
        max={DEPTH_MAX_INDEX}
        defaultValue={pdef('depth')}
        label="Depth"
        curve="discrete"
        formatValue={formatDepth}
        ticks={DEPTH_TICKS}
        onchange={setParam('depth')}
        moduleId={id}
        paramId="depth"
      />
      <Fader value={p('dither')} min={0} max={1} defaultValue={pdef('dither')} label="Dither" curve="linear" onchange={setParam('dither')} moduleId={id} paramId="dither" />
      <Fader value={p('mix')}    min={0} max={1} defaultValue={pdef('mix')}    label="Mix"    curve="linear" onchange={setParam('mix')}    moduleId={id} paramId="mix" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 220px;
    min-height: 200px;
    /* Rack-compaction (#759): tighter bottom padding to fit the 2u tier. */
    padding-bottom: 9px;
  }
  .preview-wrap {
    margin: 6px auto 0;
    width: 160px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .preview-wrap canvas {
    width: 160px;
    height: 120px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: pixelated;
    display: block;
  }
  .preview-label { font-size: 0.55rem; color: var(--text-dim); letter-spacing: 0.08em; font-family: ui-monospace, monospace; }
  .fader-grid {
    /* Rack-compaction (#759): tighter top margin to fit the 2u tier. */
    margin-top: 8px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px 6px;
    justify-items: center;
  }
</style>
