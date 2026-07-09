<script lang="ts">
  // OneToNineCard — UI for ONE TO NINE (fixed 3×3 screen splitter).
  //
  // Layout:
  //   * A live PREVIEW of the MONITOR (the canonical surface = input + 3×3 grid
  //     + numbered cells), pulled via blitOutputToDrawingBuffer — the same
  //     pattern as MappyCard / QuadralogicalCard.
  //   * A "show grid" toggle (the grid + numbers overlay on the MONITOR only;
  //     the nine outputs are always clean crops).
  //   * Ports via the yellow PatchPanel (no raw side jacks): IN + OUT1..OUT9.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { oneToNineDef, OUTPUT_IDS } from '$lib/video/modules/onetonine';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // showGrid lives on node.data (mirrored to the param). ON by default.
  let showGrid = $derived<boolean>(
    ((node?.data as { showGrid?: unknown } | undefined)?.showGrid as boolean) ?? true,
  );

  function toggleGrid(): void {
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    const d = t.data as { showGrid?: boolean };
    const next = !showGrid;
    d.showGrid = next;
    // mirror to the param so the factory reads it via either path + it persists
    setNodeParam(id, 'showGrid', next ? 1 : 0);
  }

  // ───────── live monitor preview ─────────
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const CANVAS_W = 300;
  const CANVAS_H = Math.round((CANVAS_W * ENGINE_H) / ENGINE_W);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let drawRaf: number | null = null;

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
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, canvasEl.width, canvasEl.height);
      ctx2d.drawImage(src, 0, 0, canvasEl.width, canvasEl.height);
    }
    drawRaf = requestAnimationFrame(draw);
  }

  onMount(() => {
    drawRaf = requestAnimationFrame(draw);
  });
  onDestroy(() => {
    if (drawRaf !== null) cancelAnimationFrame(drawRaf);
  });

  // ───────── patch panel ports ─────────
  const inputs = portsFromDef(oneToNineDef.inputs);
  const outputs: PortDescriptor[] = OUTPUT_IDS.map((portId, i) => ({
    id: portId,
    label: `OUT${i + 1}`,
    cable: 'video',
  }));

  void oneToNineDef; // referenced for parity with sibling cards
</script>

<div class="mod-card onetonine-card" data-testid="onetonine-card" data-node-id={id} data-show-grid={showGrid}>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="ONE TO NINE" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={320}>
    <div class="body">
      <div class="preview-wrap" style="width: {CANVAS_W}px; height: {CANVAS_H}px;">
        <canvas
          bind:this={canvasEl}
          width={CANVAS_W}
          height={CANVAS_H}
          data-testid="onetonine-canvas"
          data-node-id={id}
        ></canvas>
      </div>

      <div class="controls">
        <button
          class="grid-toggle nodrag"
          class:on={showGrid}
          type="button"
          onclick={toggleGrid}
          data-testid="onetonine-grid-toggle"
          title="Show the 3×3 grid + cell numbers on the monitor (outputs stay clean)"
        >GRID {showGrid ? 'ON' : 'OFF'}</button>
        <p class="hint">OUT N = cell N (reading order). monitor only shows the grid + numbers.</p>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .onetonine-card { width: 360px; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    margin-top: 8px;
  }
  .preview-wrap {
    position: relative;
    align-self: center;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    background: #050608;
    line-height: 0;
  }
  .preview-wrap canvas {
    display: block;
    image-rendering: pixelated;
    background: #050608;
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 6px;
  }
  .grid-toggle {
    align-self: flex-start;
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    border-radius: 3px;
    padding: 3px 10px;
    font-size: 0.66rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .grid-toggle.on {
    background: rgba(255, 220, 0, 0.15);
    border-color: var(--yellow, #ffd24a);
    color: var(--yellow, #ffd24a);
  }
  .hint {
    font-size: 0.62rem;
    color: var(--text-dim, #889);
    font-family: ui-monospace, monospace;
    margin: 0;
    line-height: 1.3;
  }
</style>
