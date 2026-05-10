<script lang="ts">
  // VideoOutCard — UI for the Phase 0 OUTPUT sink with Phase-1 resize
  // polish (task #17). The card body IS the visible canvas; we drive a
  // per-card 2D-context blit at rAF cadence, pulling THIS OUTPUT's
  // content out of the VideoEngine's OffscreenCanvas via
  // `engine.getDomain('video').canvas` after asking the engine to
  // selectively render this OUTPUT instance's FBO into its drawing
  // buffer (`videoEngine.blitOutputToDrawingBuffer(id)`).
  //
  // Multi-OUTPUT routing: with N OUTPUT cards in the same rack, each
  // card's draw() calls blitOutputToDrawingBuffer with its own node id
  // immediately before reading engine.canvas. The cards' rAF ticks run
  // sequentially in the JS event loop, and drawImage() from a WebGL
  // canvas takes a synchronization snapshot — so each card sees its own
  // freshly-blitted content instead of last-OUTPUT-wins (the pre-fix
  // behavior, where every card showed the same content).
  //
  // Resize:
  //   - Bottom-right corner-drag handle. Width + height stored in
  //     `node.data.width` / `node.data.height` so they sync via Y.Doc
  //     to other collaborators (data is part of ModuleNode and is
  //     persisted alongside params).
  //   - Resize is INDEPENDENT of Svelte Flow's canvas zoom: drag delta
  //     is divided by the current viewport zoom factor before being
  //     applied to the card's intrinsic size, so a 1px screen-drag
  //     always == 1px of card growth regardless of zoom.
  //   - The video content scales aspect-fit (letterbox) inside the
  //     resized card. VideoEngine renders to 640×360 (16:9); we fit
  //     that into the resized canvas-wrap, leaving black bars on the
  //     short axis.
  //
  // Y-flip: WebGL framebuffers use a bottom-left origin; the 2D canvas
  // 2d-context uses top-left. drawImage of an OffscreenCanvas backed by
  // a WebGL2 context reads the framebuffer bytes as-is (origin at
  // bottom-left of the WebGL surface), then writes them top-down on
  // the 2D destination — which renders the image upside-down.
  // Procedural sources happen to be Y-symmetric so the bug went
  // unnoticed at Phase-0; PICTUREBOX (real photos) made it visible.
  // Flip here so every module renders right-side-up downstream.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, useStore, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Read viewport reactively so resize math always uses the live zoom
  // factor. The store is provided by <SvelteFlow>; this card is
  // rendered inside it, so the call always succeeds.
  const flowStore = useStore();

  // Defaults: keep 16:9 aspect, plenty of room to read at the default
  // zoom level. Stored in node.data so they sync via Y.Doc.
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 240;
  const MIN_WIDTH = 240;
  const MIN_HEIGHT = 160;
  // Engine render resolution — must match VIDEO_RES in
  // packages/web/src/lib/video/engine.ts. Hardcoded here so we don't
  // need to import the engine module just for this constant (it
  // pulls in WebGL boot code).
  const ENGINE_W = 640;
  const ENGINE_H = 360;

  let cardWidth = $derived<number>(
    (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH,
  );
  let cardHeight = $derived<number>(
    (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT,
  );

  // Inside the card, the canvas-wrap fills the area minus header
  // (~52px) + padding. The actual <canvas> element gets sized to an
  // aspect-fit inside that area. Width/height of the <canvas>
  // attribute matches the container; the inner draw scales the engine
  // texture to fit-with-letterbox.
  const HEADER_PX = 56;
  const PAD_PX = 20;
  let innerWidth = $derived(Math.max(MIN_WIDTH - PAD_PX, cardWidth - PAD_PX));
  let innerHeight = $derived(Math.max(MIN_HEIGHT - HEADER_PX, cardHeight - HEADER_PX));

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  /** Compute the aspect-fit destination rect for an engine-resolution
   *  source drawn into a (cw, ch) canvas. Returns top-left (x, y) and
   *  width/height of the letterbox-fit area. */
  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const srcAspect = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    if (dstAspect > srcAspect) {
      // Destination is wider than source: letterbox left/right.
      const h = ch;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    } else {
      // Destination is taller: letterbox top/bottom.
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
      // Tell the engine to render THIS OUTPUT's per-instance FBO into
      // its drawing buffer right before we read it. With multiple
      // OUTPUT cards on the same engine, each card's draw() does this
      // step with its own id so cards stay independent (no
      // last-OUTPUT-wins coupling through the shared default FB).
      try {
        videoEngine.blitOutputToDrawingBuffer(id);
      } catch {
        // Engine method shouldn't throw, but we never want a single
        // OUTPUT card to nuke its own rAF loop on an unexpected error.
      }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      // Black background, then aspect-fit blit with Y-flip.
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      ctx2d.save();
      // Y-flip the engine canvas. Translate to dst.y + dst.h then
      // scale(1, -1) so a top-left drawImage at (dst.x, 0) produces a
      // visually-upright image inside the letterbox.
      ctx2d.translate(r.x, r.y + r.h);
      ctx2d.scale(1, -1);
      ctx2d.drawImage(src, 0, 0, r.w, r.h);
      ctx2d.restore();
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
  });

  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (resizeAbort) resizeAbort.abort();
  });

  // ---------- Corner-drag resize ----------
  // Pointer-driven; div coords are screen-space, so we divide by the
  // current viewport zoom to get card-intrinsic delta. We persist the
  // result onto node.data inside the patch store, which Svelte Flow
  // re-renders us against on next frame.
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;

  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          target.data.width = w;
          target.data.height = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }
</script>

<div
  class="card video"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="video-out-card"
  data-node-id={id}
>
  <div class="stripe"></div>
  <header class="title">OUTPUT</header>

  <Handle type="target" position={Position.Left} id="in" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">IN</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="canvas-wrap" style="width: {innerWidth}px; height: {innerHeight}px;">
    <canvas
      bind:this={canvasEl}
      width={innerWidth}
      height={innerHeight}
      data-testid="video-out-canvas"
      data-node-id={id}
    ></canvas>
  </div>

  <!-- Bottom-right corner-drag resize handle. The svelte-flow nodrag
       class is required so xyflow's node-drag listener doesn't
       hijack the pointerdown event before we see it. -->
  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize OUTPUT"
    data-testid="video-out-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .card {
    /* Solid black underlay + opaque module-bg overlay — even if a skin
     * shipped a translucent --module-bg, no cable routed behind the
     * OUTPUT card can bleed through the live-video canvas. */
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
    overflow: hidden;
    isolation: isolate;
  }
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.resizing {
    /* Avoid hover/selected pulses while the user drags. */
    transition: none;
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
  .port-label.right { right: 14px; }
  .canvas-wrap {
    margin: 18px auto 0;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .canvas-wrap canvas {
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: pixelated;
    width: 100%;
    height: 100%;
    display: block;
  }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    /* Triangle in the corner so it's visible without dominating the
     * card chrome. */
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-video) 50%,
      var(--cable-video) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-video) 70%,
      var(--cable-video) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
