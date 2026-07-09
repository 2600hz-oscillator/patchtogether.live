<script lang="ts">
  // CellshadeCard — UI for CELLSHADE (cel-shader video processor).
  //
  // Single video input (in) → video output (out). Three knobs:
  //   THRESH (edge gate, from EDGES) + THICK (ink stroke width, from EDGES)
  //   + BITS (a 5-step DISCRETE knob snapping to 1/2/4/8/16-bit colour
  //   depth). BITS displays its current bit value (1/2/4/8/16) on the card.
  // Each knob has a matching per-param CV input. A live preview of the
  // cel-shaded OUT is shown (mirrors FreezeframeCard's blit).
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    cellshadeDef,
    cellshadeBitDepth,
    cellshadeColorCount,
    CELLSHADE_BIT_STEPS,
  } from '$lib/video/modules/cellshade';
  import { EDGES_MAX_THICKNESS } from '$lib/video/modules/edges';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = cellshadeDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number {
    return cellshadeDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // --- BITS discrete display: the knob value is a step INDEX 0..4; show the
  // bit value (1/2/4/8/16) + colour count below it. ---
  const BITS_MAX_INDEX = CELLSHADE_BIT_STEPS.length - 1;
  // Tick rail: one mark per step, labelled with the bit value.
  const BITS_TICKS = CELLSHADE_BIT_STEPS.map((s, i) => ({
    frac: BITS_MAX_INDEX > 0 ? i / BITS_MAX_INDEX : 0,
    label: String(s.bits),
  }));
  function formatBits(v: number): string {
    return String(cellshadeBitDepth(v));
  }
  let bitDepth = $derived(cellshadeBitDepth(p('bits')));
  let colorCount = $derived(cellshadeColorCount(p('bits')));

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

  const inputs = portsFromDef(cellshadeDef.inputs, { threshold: 'THRESH', thickness: 'THICK' });
  const outputs = portsFromDef(cellshadeDef.outputs);
</script>

<div class="vcard card video" data-testid="cellshade-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="CELLSHADE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- OUT live preview -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={160}
        height={120}
        data-testid="cellshade-preview"
        data-node-id={id}
      ></canvas>
      <span class="preview-label" data-testid="cellshade-bits-readout">{bitDepth}-BIT · {colorCount} COL</span>
    </div>

    <div class="fader-grid">
      <Fader value={p('threshold')} min={0} max={1}                  defaultValue={pdef('threshold')} label="Thresh" curve="linear" onchange={setParam('threshold')} moduleId={id} paramId="threshold" />
      <Fader value={p('thickness')} min={1} max={EDGES_MAX_THICKNESS} units="px" defaultValue={pdef('thickness')} label="Thick"  curve="linear" onchange={setParam('thickness')} moduleId={id} paramId="thickness" />
      <Fader
        value={p('bits')}
        min={0}
        max={BITS_MAX_INDEX}
        defaultValue={pdef('bits')}
        label="Bits"
        curve="discrete"
        formatValue={formatBits}
        ticks={BITS_TICKS}
        onchange={setParam('bits')}
        moduleId={id}
        paramId="bits"
      />
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
