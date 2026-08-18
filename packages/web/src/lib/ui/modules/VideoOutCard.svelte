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
  import { type NodeProps } from '@xyflow/svelte';
  import { captureFlowStore } from './card-kit';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import { createPresent } from './use-present.svelte';
  import { attachRenderLease } from './use-render-lease.svelte';
  import { fullscreenCanvasDims } from './fullscreen-canvas-dims';
  import { liveEngineAspect } from './video-card-aspect';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import { mutateNode } from '$lib/graph/mutate';
  import {
    REATTACH_CLEARS,
    detachPatch,
    detachedRect,
    isDetached,
  } from './detached-display';
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
  // Guarded: the dock full-view plain-mounts this card OUTSIDE the
  // SvelteFlow provider, where a bare useStore() throws and killed the
  // card at init (no video in the expanded faceplate). Inside the
  // provider this is byte-identical; outside it's null -> zoom 1.
  const flowStore = captureFlowStore();

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
  // Opens a SEPARATE popup window on the chosen display and blits THIS NODE's
  // engine output into it each frame — not this card's canvas, and not owned by
  // this card at all (node-present-registry). The main window stays interactive
  // (unlike true fullscreen, which relocates the whole tab). Capability-gated by
  // the menu (only shows when getScreenDetails exists + >1 screen).
  //
  // ⚠ The blit reads the engine at ITS resolution, so what lands on the
  // projector no longer inherits this card's on-screen size — a small OUTPUT
  // card used to project an upscaled card-sized canvas.
  const present = createPresent({
    nodeId: () => id,
    engine: () => engineCtx.get(),
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

  // ---------- Pull-eval HARD LEASE while presenting ----------
  // True fullscreen / present-on-second-display / in-app full-frame put this
  // OUTPUT's pixels on a surface that outlives the flow node's viewport rect,
  // so the engine's sink-driven pull evaluation must keep the chain rendering
  // even if the card element itself is scrolled offscreen / demoted by the
  // Canvas visibility observer. The lease is refcounted and released the
  // moment every presenting mode ends ($effect cleanup). Shared seam since
  // 2026-08-06 (use-render-lease) — the four other presenting cards carried
  // the same three modes with NO lease and froze their presented surface on
  // scroll; ONE implementation means a sixth surface can't drift.
  attachRenderLease({
    engine: () => engineCtx.get(),
    nodeId: () => id,
    presenting: () => fs.isFullscreen || present.isPresenting || fullFrame,
  });

  // ---------- DETACHED DISPLAY (#1821) ----------
  // The picture leaves the card and floats free. STATE LIVES ON THE NODE
  // (`node.data.detached`, the `fullFrame` / `previewCollapsed` seam) — see
  // $lib/ui/modules/detached-display for the model and why node-ownership is
  // what makes the delete-either-destroys-both lifecycle structural. The PANEL
  // is rendered by Canvas, outside <SvelteFlow>, so it has no patch wires.
  let detached = $derived(isDetached(node));

  function detachDisplay(): void {
    // Geometry is written with the flag so the whole gesture is ONE undo entry,
    // and it is CLAMPED at write time against the live window rather than left
    // for the panel to fix on first paint.
    const rect = detachedRect(node, {
      width: typeof window === 'undefined' ? 1280 : window.innerWidth,
      height: typeof window === 'undefined' ? 720 : window.innerHeight,
    });
    const data = detachPatch(rect);
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      for (const [k, v] of Object.entries(data)) live.data[k] = v;
    });
    // Detaching supersedes in-card full frame — the picture is not in the card
    // any more, so a card expanded to "fill its border" around nothing is a
    // blank rectangle. (Mutual exclusion, exactly as full frame and true
    // fullscreen already have.)
    if (fullFrame) ff.exit();
  }

  function reattachDisplay(): void {
    mutateNode(id, (live) => {
      if (!live.data) return;
      for (const k of REATTACH_CLEARS) delete live.data[k];
    });
  }

  // Canvas drawing-buffer dims. In the rack: the card's inner dims (card
  // aspect). In TRUE fullscreen — OR while PRESENTING on a second display: the
  // live ENGINE dims so the buffer carries the ENGINE aspect — fitRect then
  // fills it edge-to-edge (no baked bars). The CSS object-fit:contain
  // pillarboxes the true source aspect into the screen (height-fill, side
  // pillarbox only for 4:3 — no top/bottom letterbox), and the present popup
  // mirrors this CLEAN engine-aspect buffer so a 16:9 output fills a 16:9
  // projector instead of the doubly-letterboxed card preview. See
  // fullscreen-canvas-dims.ts for the full rationale.
  let bufferDims = $derived(
    fullscreenCanvasDims(
      fs.isFullscreen || present.isPresenting,
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
    // ⚠ WHILE DETACHED THIS CARD IS NOT A SURFACE, so it neither blits NOR
    // marks watched — it drops out of the observer set entirely.
    //
    // ⚠ AN EARLIER VERSION OF THIS BRANCH CALLED `markWatched` HERE, on the
    // reasoning that "a blit IS the watch mark, so a card that stops blitting
    // stops watching". That reasoning is right and the conclusion was wrong, and
    // #1802/#1836 measured exactly why: a backdraft card that skipped its blit
    // but kept marking watched held `toybox → backdraft` at 481 frames in 4 s
    // for a picture presented on NO surface. *"A card that is not showing
    // anything must not be an observer, and the way to stop being one is to stop
    // blitting, because the blit IS the watch mark"* (preview-gate.ts).
    //
    // Detaching does not make the picture unobserved — it MOVES the observer.
    // `DetachedDisplay` blits this node every frame (which marks it watched) AND
    // holds a render lease, and a leased node bypasses the visibility gate and
    // the cadence cap by design. So the chain stays alive because the surface
    // that is actually showing it says so, which is the invariant #1836 asks
    // for, rather than because a card that shows nothing votes for it.
    if (detached) {
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
      // #1802 — blitOutputForPreview, NOT blitOutputToDrawingBuffer. It
      // applies the viewport gate and the preview cadence cap and reports
      // whether the drawing buffer actually holds our picture. `false` means
      // the card is off-screen (so it must stop being an observer of its node
      // — the blit IS the watch mark) or this frame is inside the cadence
      // window. Either way we skip the drawImage below, which is the
      // synchronising half and the expensive one. A LEASED node (fullscreen /
      // projector / full-frame) bypasses both gates and always returns true.
      let blitted = false;
      try {
        blitted = videoEngine.blitOutputForPreview(id);
      } catch {
        // Engine method shouldn't throw, but we never want a single
        // OUTPUT card to nuke its own rAF loop on an unexpected error.
      }
      // Mirror the live engine dims into $state so the fullscreen buffer-size
      // derive (bufferDims) follows the engine resolution. Cheap guard so we
      // don't churn reactivity every frame when nothing changed. OUTSIDE the
      // `blitted` guard on purpose: these are property reads, not engine work,
      // and the fullscreen buffer must track a resolution change even on a
      // frame whose preview was throttled.
      const ew = videoEngine.canvas.width || ENGINE_W;
      const eh = videoEngine.canvas.height || ENGINE_H;
      if (ew !== engineW) engineW = ew;
      if (eh !== engineH) engineH = eh;
      if (blitted) {
        const src = videoEngine.canvas as CanvasImageSource;
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
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
  });

  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (resizeAbort) resizeAbort.abort();
    // NO present teardown here — deliberately. The projector belongs to the
    // NODE, not to this card (see $lib/ui/modules/node-present-registry). This
    // card is a NON_SHELL_LANE_TYPE so it is never swapped out and never showed
    // the collapse bug, but the ownership rule is the same for all four
    // presenting cards and a per-card exception is how one of them drifts back.
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
  class="vcard card video"
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
  <!-- svelte-ignore a11y_no_static_element_interactions — the only handler here is `oncontextmenu`, which opens the canvas menu. Right-click
       already HAS a keyboard route the browser dispatches to this same event (the Menu key /
       Shift+F10), so an extra key handler would be a second path to the same menu. -->
  <div
    bind:this={wrapEl}
    class="canvas-wrap"
    class:fullscreen={fs.isFullscreen}
    class:full-frame={fullFrame}
    style="width: {fs.isFullscreen || fullFrame ? '100%' : innerWidth + 'px'}; height: {fs.isFullscreen || fullFrame ? '100%' : innerHeight + 'px'};"
    data-testid="video-out-fs-wrap"
    data-detached={detached ? 'true' : 'false'}
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
    <!-- ⚠ THE CANVAS IS NEVER `{#if}`-ed AWAY while detached. `requestFullscreen()`
         needs a real rendered element at the moment the menu item is clicked, and
         the Present popup blits from this same canvas — so detaching COVERS it
         with the plate below rather than unmounting it. The plate is what the
         user right-clicks to get "re-attach" back, which is why it sits inside
         the wrap that owns `oncontextmenu`. -->
    {#if detached}
      <div class="detached-plate" data-testid="video-out-detached-plate">
        <span>display detached</span>
        <button
          type="button"
          class="detached-reattach nodrag"
          data-testid="video-out-reattach"
          onclick={reattachDisplay}
        >re-attach</button>
      </div>
    {/if}
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
  onpresentall={() => present.presentAll(fs.availableScreens.filter((s) => !s.isPrimary).map((s) => s.id))}
  onstoppresent={() => present.stop()}
  isPresenting={present.isPresenting}
  isDetached={detached}
  ondetach={detachDisplay}
  onreattach={reattachDisplay}
  onclose={() => { ctxOpen = false; }}
/>

<style>
  .card {
    /* Solid black underlay + opaque module-bg overlay — even if a skin
     * shipped a translucent --module-bg, no cable routed behind the
     * OUTPUT card can bleed through the live-video canvas. */
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    overflow: hidden;
    isolation: isolate;
  }
  .card.resizing {
    /* Avoid hover/selected pulses while the user drags. */
    transition: none;
  }
  .canvas-wrap {
    margin: 18px auto 0;
    display: flex;
    justify-content: center;
    align-items: center;
    /* The detached plate is absolutely positioned over the live canvas. */
    position: relative;
  }
  /* DETACHED (#1821): the picture is in the floating panel, so the card says
   * where it went and offers the way back. It COVERS the canvas rather than
   * replacing it — see the markup note. */
  .detached-plate {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: #050608;
    border: 1px dashed var(--cable-video);
    color: var(--text-dim);
    font-size: 0.62rem;
    letter-spacing: 0.06em;
  }
  .detached-reattach {
    padding: 3px 8px;
    font: inherit;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--cable-video);
    border-radius: 3px;
    cursor: pointer;
  }
  .detached-reattach:hover,
  .detached-reattach:focus-visible {
    background: color-mix(in srgb, var(--cable-video) 22%, transparent);
    outline: none;
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
