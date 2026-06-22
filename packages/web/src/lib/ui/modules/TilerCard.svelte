<script lang="ts">
  // TilerCard — UI for TILER (video multiscreen / TILE effect processor).
  //
  // Single video input (in) → video output (out). ONE knob: TILE — a 6-step
  // DISCRETE control. The knob value is the TOTAL tile count = 1 / 4 / 6 / 12
  // / 16 / 64, each realized as a LANDSCAPE cols×rows grid (idx 0 = total 1 =
  // 1:1 passthrough). The card shows the resulting grid (e.g. "8×8 GRID")
  // below it. A matching TILE CV input (discrete cvScale) modulates the grid —
  // it snaps + sums into the index, then the module snaps to the nearest valid
  // step. A live preview of the tiled OUT is shown (mirrors CellshadeCard's
  // blit).
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks). Port `id`s are byte-identical
  // to tilerDef so the CV bridge + persisted edges route unchanged.
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { tilerDef, tilerStepGrid, TILER_STEPS, TILER_GRID_STEPS } from '$lib/video/modules/tiler';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = tilerDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number {
    return tilerDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // --- TILE discrete display: the knob value is a step INDEX 0..5; show the
  // resolved grid (cols×rows or "1:1") below it. The labels are the TOTAL tile
  // count per step. ---
  const TILE_MAX_INDEX = TILER_STEPS.length - 1;
  // Tick rail: one mark per step, labelled with the TOTAL tile count.
  const TILE_TICKS = TILER_GRID_STEPS.map((total, i) => ({
    frac: TILE_MAX_INDEX > 0 ? i / TILE_MAX_INDEX : 0,
    label: String(total),
  }));
  function formatTile(v: number): string {
    const g = tilerStepGrid(v);
    return g.total === 1 ? '1:1' : `${g.cols}×${g.rows}`;
  }
  let grid = $derived(tilerStepGrid(p('tile')));
  let gridLabel = $derived(grid.total === 1 ? '1:1 PASSTHRU' : `${grid.cols}×${grid.rows} GRID`);

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

  const inputs: PortDescriptor[] = [
    { id: 'in',      label: 'IN',   cable: 'video' },
    { id: 'tile_cv', label: 'TILE', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];
</script>

<div class="card video" data-testid="tiler-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="TILER" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- OUT live preview -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={160}
        height={120}
        data-testid="tiler-preview"
        data-node-id={id}
      ></canvas>
      <span class="preview-label" data-testid="tiler-grid-readout">{gridLabel}</span>
    </div>

    <div class="fader-grid">
      <Fader
        value={p('tile')}
        min={0}
        max={TILE_MAX_INDEX}
        defaultValue={pdef('tile')}
        label="Tile"
        curve="discrete"
        formatValue={formatTile}
        ticks={TILE_TICKS}
        onchange={setParam('tile')}
        moduleId={id}
        paramId="tile"
      />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 200px;
    min-height: 200px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 9px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  /* Video stripe — same accent the OUT handle uses. */
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-video); }
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
    margin-top: 8px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px 6px;
    justify-items: center;
  }
</style>
