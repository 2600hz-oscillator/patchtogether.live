<script lang="ts">
  // VideoOutCard — UI for the Phase 0 OUTPUT sink. The card body IS the
  // visible canvas; we drive a per-card 2D-context blit at rAF cadence,
  // pulling the most recent VideoEngine frame out of the engine's
  // OffscreenCanvas via `engine.getDomain('video').canvas` and drawing it
  // into our visible canvas.
  //
  // Why a 2D blit rather than a second WebGL2 context: the engine already
  // owns the only WebGL2 surface (one per page). Sharing that context
  // across multiple OUTPUT cards is messy (context bookkeeping, viewport
  // restoration). A 2D blit of the engine canvas — which the spec
  // explicitly endorses (drawImage of an OffscreenCanvas is well-defined)
  // — gives us per-card visible canvases without a second GL context.
  // Phase 1 will revisit if we need higher fidelity.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

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
      // No video engine registered (e.g. test that only spawns audio).
      rafId = requestAnimationFrame(draw);
      return;
    }
    if (!videoEngine) {
      rafId = requestAnimationFrame(draw);
      return;
    }

    // Draw the engine's offscreen canvas onto our visible canvas, scaled
    // to fit our card dimensions. drawImage handles OffscreenCanvas (and
    // HTMLCanvasElement for the SSR-fallback case) identically. The
    // OUTPUT module's draw() pass already wrote into the engine's
    // default framebuffer this frame; we just blit it across.
    //
    // Y-flip: WebGL framebuffers use a bottom-left origin; the 2D canvas
    // 2d-context uses top-left. drawImage of an OffscreenCanvas backed by
    // a WebGL2 context reads the framebuffer bytes as-is (origin at
    // bottom-left of the WebGL surface), then writes them top-down on the
    // 2D destination — which renders the image upside-down. Procedural
    // sources (LINES horizontal stripes, INWARDS concentric rings) are
    // visually Y-symmetric so the bug went unnoticed at Phase-0; PICTUREBOX
    // (real photos with an obvious "up") makes it visible. Flip here so
    // every module renders right-side-up downstream.
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      const src = videoEngine.canvas as CanvasImageSource;
      ctx2d.save();
      ctx2d.translate(0, canvasEl.height);
      ctx2d.scale(1, -1);
      ctx2d.drawImage(src, 0, 0, canvasEl.width, canvasEl.height);
      ctx2d.restore();
    }

    rafId = requestAnimationFrame(draw);
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
  });

  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });
</script>

<div class="card video">
  <div class="stripe"></div>
  <header class="title">OUTPUT</header>

  <Handle type="target" position={Position.Left} id="in" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">IN</span>

  <div class="canvas-wrap">
    <!-- Visible canvas at a sensible default size. Phase 1 polish adds a
         corner-drag resize handle; for now a fixed-aspect frame proves
         out the engine → visible-canvas pipeline. -->
    <canvas
      bind:this={canvasEl}
      width="320"
      height="180"
      data-testid="video-out-canvas"
      data-node-id={id}
    ></canvas>
  </div>
</div>

<style>
  .card {
    width: 360px;
    min-height: 240px;
    background: var(--module-bg);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
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
  .canvas-wrap {
    margin-top: 18px;
    padding: 0 16px;
    display: flex;
    justify-content: center;
  }
  .canvas-wrap canvas {
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: pixelated;
    /* Use a fixed display size so the visual is repeatable in screenshots
     * and ART. The engine renders to its own resolution and we scale. */
    width: 320px;
    height: 180px;
  }
</style>
