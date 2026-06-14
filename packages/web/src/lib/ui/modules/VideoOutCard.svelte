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
  //     resized card. VideoEngine renders to 640×480 (4:3); we fit
  //     that into the resized canvas-wrap, leaving black bars on the
  //     short axis.
  //
  // Orientation: drawImage() from a WebGL canvas already presents the GL
  // drawing buffer in top-left CSS orientation — the browser accounts
  // for GL's bottom-left origin. So a straight blit (no manual Y-flip)
  // is upright for every source: procedural modules author against vUv,
  // and DOM/buffer sources (DOOM/CAMERA/PICTUREBOX) upload so their FBO
  // matches that same convention. An earlier scale(1,-1) here flipped
  // every source upside down; removing it is what makes OUTPUT (and the
  // other preview cards, which shared the same blit) render right-side-up.

  import { onMount, onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import { createPresent } from './use-present.svelte';
  import { fullscreenCanvasDims } from './fullscreen-canvas-dims';
  import { liveEngineAspect } from './video-card-aspect';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const inputs: PortDescriptor[] = [
    { id: 'in', label: 'IN', cable: 'video' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'video' },
  ];

  // Read viewport reactively so resize math always uses the live zoom
  // factor. The store is provided by <SvelteFlow>; this card is
  // rendered inside it, so the call always succeeds.
  const flowStore = useStore();

  // Defaults: card-size defaults (engine 4:3 output aspect-fits inside).
  // Stored in node.data so they sync via Y.Doc. Rounded to whole-u (180px) rack
  // tiles (#759) so default + min land on the grid; user-resizable so the rack
  // CSS doesn't clamp it.
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 360;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 180;
  // Engine render resolution — derived from VIDEO_RES so the preview's
  // fitRect aspect (and the fullscreen buffer-size derive below) always
  // tracks the live engine resolution.
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

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

  // Live engine canvas dims, mirrored each rAF in draw() (the engine isn't a
  // reactive store — engineCtx.get() is a plain getter — so we copy its dims
  // into $state for the fullscreen buffer-size derive below). Defaults to the
  // engine constants until the engine reports real dims.
  let engineW = $state<number>(ENGINE_W);
  let engineH = $state<number>(ENGINE_H);

  // ---------- True fullscreen ----------
  // The canvas-wrap is the element we fullscreen; it contains the live
  // <canvas>. While fullscreen, CSS scales the canvas to fill the viewport
  // (aspect-fit, black letterbox); the rAF blit keeps feeding it so the
  // fullscreen view stays live.
  const fs = createFullscreen();
  let wrapEl: HTMLDivElement | null = $state(null);
  $effect(() => {
    fs.setTarget(wrapEl);
  });
  $effect(() => fs.attach());

  // ---------- Present on a second display ----------
  // Opens a SEPARATE popup window on the chosen display and blits THIS card's
  // live canvas into it each frame — the main window stays interactive (unlike
  // true fullscreen, which relocates the whole tab). Capability-gated by the
  // menu (only shows when getScreenDetails exists + >1 screen).
  const present = createPresent({
    getCanvas: () => canvasEl,
    fullscreen: fs,
  });

  // ---------- Full Frame (in-app, NOT browser fullscreen) ----------
  // Expands the canvas to consume the card border, hiding chrome (port
  // labels + the card's own Handle jacks). The card stays in the rack and
  // remains resizable. Persisted in node.data.fullFrame so it survives
  // reload + syncs to rack-mates (wall-of-TVs layouts are shareable).
  let fullFrame = $derived<boolean>((node?.data?.fullFrame as boolean | undefined) ?? false);
  const ff = createFullFrame({
    setFullFrame: (on) => {
      const target = patch.nodes[id];
      if (target) {
        if (!target.data) target.data = {};
        target.data.fullFrame = on;
      }
    },
    // Mutual exclusion: entering full-frame drops any active true-fullscreen.
    exitFullscreen: () => void fs.exit(),
  });
  let cardEl: HTMLDivElement | null = $state(null);
  // Double-click a full-frame card exits back to normal chrome.
  $effect(() => ff.attach(cardEl, () => fullFrame));

  // Canvas drawing-buffer dims. In the rack: the card's inner dims (card
  // aspect). In TRUE fullscreen: the live ENGINE dims so the buffer carries the
  // ENGINE aspect — fitRect then fills it edge-to-edge (no baked bars) and the
  // CSS object-fit:contain pillarboxes the true source aspect into the screen
  // (height-fill, side pillarbox only for 4:3 — no top/bottom letterbox). See
  // fullscreen-canvas-dims.ts for the full rationale.
  let bufferDims = $derived(
    fullscreenCanvasDims(
      fs.isFullscreen,
      { canvas: { width: engineW, height: engineH } },
      { width: innerWidth, height: innerHeight },
    ),
  );

  // Right-click-on-canvas context menu (Fullscreen / Full Frame).
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function onCanvasContextMenu(e: MouseEvent) {
    // Claim the right-click on the video surface so it doesn't bubble to
    // the SvelteFlow node menu (Docs / Duplicate / Delete). The canvas
    // isn't a control surface, so there's nothing to steal.
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  /** Compute the aspect-fit destination rect for an engine-resolution
   *  source drawn into a (cw, ch) canvas. Returns top-left (x, y) and
   *  width/height of the letterbox-fit area. */
  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    // Letterbox at the LIVE engine aspect (mirrored into engineW/engineH each
    // rAF) so the in-rack thumbnail tracks a 4:3 ↔ 16:9 OUTPUT switch — not the
    // stale compile-time VIDEO_RES constant.
    const srcAspect = liveEngineAspect({ canvas: { width: engineW, height: engineH } });
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
      // Mirror the live engine dims into $state so the fullscreen buffer-size
      // derive (bufferDims) follows the engine resolution. Cheap guard so we
      // don't churn reactivity every frame when nothing changed.
      const ew = videoEngine.canvas.width || ENGINE_W;
      const eh = videoEngine.canvas.height || ENGINE_H;
      if (ew !== engineW) engineW = ew;
      if (eh !== engineH) engineH = eh;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      // Black background, then aspect-fit blit with Y-flip.
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      // drawImage() from a WebGL canvas already presents the GL drawing
      // buffer in top-left CSS orientation (the browser accounts for GL's
      // bottom-left origin). Procedural sources author against vUv and
      // DOOM/CAMERA upload with UNPACK_FLIP_Y so their FBOs are upright in
      // that same convention — so a straight blit is upright. (A manual
      // scale(1,-1) used to live here and flipped every source upside
      // down.)
      ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
  });

  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (resizeAbort) resizeAbort.abort();
    // Close any present popup + stop the blit loop when the card is gone.
    present.dispose();
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
  bind:this={cardEl}
  class="card video"
  class:resizing
  class:full-frame={fullFrame}
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="video-out-card"
  data-node-id={id}
  data-full-frame={fullFrame}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="OUTPUT" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={wrapEl}
    class="canvas-wrap"
    class:fullscreen={fs.isFullscreen}
    class:full-frame={fullFrame}
    style="width: {fs.isFullscreen || fullFrame ? '100%' : innerWidth + 'px'}; height: {fs.isFullscreen || fullFrame ? '100%' : innerHeight + 'px'};"
    data-testid="video-out-fs-wrap"
    oncontextmenu={onCanvasContextMenu}
  >
    <canvas
      bind:this={canvasEl}
      width={bufferDims.width}
      height={bufferDims.height}
      style="aspect-ratio: {bufferDims.aspectRatio};"
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
  </PatchPanel>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="OUTPUT"
  availableScreens={fs.availableScreens}
  onrequestscreens={() => void fs.loadScreens()}
  onfullscreen={(screenId) => { ff.exit(); void fs.enter(screenId); }}
  onfullframe={() => ff.toggle(fullFrame)}
  isFullFrame={fullFrame}
  onpresent={(screenId) => present.present(screenId)}
  onstoppresent={() => present.stop()}
  isPresenting={present.isPresenting}
  onclose={() => { ctxOpen = false; }}
/>

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
  /* TRUE fullscreen: the wrap IS the fullscreen element (filling the
   * physical screen). Center the live canvas + scale it to fit with
   * aspect preserved (object-fit:contain semantics for a <canvas>:
   * max-width/height 100% + the inline aspect-ratio), black bars on the
   * short axis. The rAF blit keeps feeding the same canvas. */
  .canvas-wrap.fullscreen {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #000;
  }
  /* Zoom-fit: scale the live canvas UP to fill the fullscreen viewport as
   * large as possible while preserving aspect. The canvas drawing buffer is
   * small (card-sized px) so width/height:auto kept it tiny + un-scaled —
   * fill the wrap (100% × 100%) + object-fit:contain so it scales up,
   * centered, with black bars on the off-axis. */
  .canvas-wrap.fullscreen canvas {
    border: none;
    border-radius: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }
  /* FULL FRAME (in-app): the canvas consumes the whole card border — hide
   * the chrome (title, port labels, stripe) + drop the card padding so the
   * video fills edge-to-edge. The card stays in the rack + remains
   * resizable; double-click exits. Distinct from .fullscreen above, which
   * escapes the rack to the physical screen via the Fullscreen API. */
  .card.full-frame {
    padding: 0;
  }
  .card.full-frame .title,
  .card.full-frame .stripe {
    display: none;
  }
  /* Hide the card's OWN Svelte Flow jacks + patch-panel triggers while
   * full-frame — keep handles in the DOM (opacity/pointer-events, not
   * display:none) so existing cables stay connected; we're hiding the jacks
   * visually, not disconnecting. */
  .card.full-frame :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }
  .card.full-frame :global(.patch-trigger) {
    display: none;
  }
  .canvas-wrap.full-frame {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #000;
    cursor: pointer;
  }
  .canvas-wrap.full-frame canvas {
    border: none;
    border-radius: 0;
    width: 100%;
    height: 100%;
    /* contain so the engine source is never cropped; black letterbox bars
     * on the short axis. */
    object-fit: contain;
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
