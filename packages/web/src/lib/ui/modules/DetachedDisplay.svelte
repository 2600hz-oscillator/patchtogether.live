<script lang="ts">
  // THE DETACHED DISPLAY (#1821) — one video OUTPUT's picture, floating free.
  //
  // Owner: *"free floating, no patch wires, can be resized. if it's detached we
  // can right click either it OR the underlying video output card, and click
  // 're-attach'. also if we delete the card the output goes away and if we right
  // click the floating output and delete it the card goes away"*
  //
  // The model — which flag, which geometry, which constraints and WHY each — is
  // `./detached-display.ts`. This file renders what that says and owns nothing
  // else. Read that header first; the notes below are only about the RENDER.
  //
  // ⚠ NO PATCH WIRES IS STRUCTURAL, NOT STYLED. Canvas mounts this OUTSIDE
  // `<SvelteFlow>` (beside the drop-patch scrim), so it is not a flow node:
  // there is no handle for a cable to attach to and nothing for the edge layer
  // to draw. Styling wires away would have been a promise; not being a node is
  // a proof.
  //
  // ⚠ 2D CANVAS, DELIBERATELY — `getContext('2d')`, never `webgl`. The WebGL
  // attest basis includes any `.svelte` whose source creates a GL context, so a
  // direct GL surface here would put this file in the basis PERMANENTLY and make
  // every future edit cost an owner-machine re-attest. The engine already renders
  // to its own GL canvas; this is a `drawImage` of it, exactly as VideoOutCard
  // and BackdraftOutputBody do, and for the same reason.
  //
  // ⚠ IT TAKES A RENDER LEASE. The panel is a live surface that outlives the
  // node's viewport rect: `video-card-visibility.ts` observes
  // `.svelte-flow__node[data-id]` elements only, so a lane card panned off-screen
  // is demoted after WATCH_TTL_MS and the panel would freeze ~1.5 s later while
  // looking fine in review. `attachRenderLease` is the shipped counter-measure
  // and is refcounted engine-side, so holding one here does NOT double-pay.
  //
  // ⚠ AND DETACHING DOES NOT DOUBLE-PAY THE BLIT EITHER. Only ONE surface blits
  // at a time: while detached, `VideoOutCard` skips its own `drawImage` (it still
  // calls `markWatched`, so the chain keeps PRODUCING — the collapse-kills-the-
  // producer class, #1721/#1728) and this panel does the readback instead.
  // Detaching MOVES the picture; it does not clone it.

  import { untrack } from 'svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { mutateNode } from '$lib/graph/mutate';
  import { startCornerResize } from './card-resize';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createPresent } from './use-present.svelte';
  import { attachRenderLease } from './use-render-lease.svelte';
  import { fullscreenCanvasDims } from './fullscreen-canvas-dims';
  import { liveEngineAspect } from './video-card-aspect';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import {
    DETACHED_KEYS,
    DETACHED_MIN_H,
    DETACHED_MIN_W,
    clampDetachedRect,
    type DetachedRect,
  } from './detached-display';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';

  interface Props {
    /** The node whose picture this is. */
    nodeId: string;
    /** Display name in the panel header + the context menu title. */
    label: string;
    /**
     * `var(--cable-<type>)` for this module — the DOMAIN CHAIN, resolved by the
     * caller from the live def via `spineCableVar`. ⚠ NEVER a hard-coded purple:
     * the violet border the owner asked for is the video cable token, so a skin
     * that re-tunes `--cable-video` re-tunes this border with it (#1812 is what
     * hard-coding a control colour produced).
     */
    domain?: string;
    /**
     * The panel's ALREADY-CLAMPED screen rectangle, resolved by Canvas from the
     * snapshot bus.
     *
     * ⚠ IT IS A PROP RATHER THAN A LOCAL READ OF `patch.nodes[nodeId]`, AND THAT
     * IS A MEASURED FIX, not a preference. A `$derived` here reading the
     * SyncedStore proxy registers no Svelte dependency, so it memoises the value
     * it saw at mount and never invalidates: dragging the grip moved
     * `node.data.detachedW` to 632 while this component's own box stayed at 480.
     * Canvas holds the ONE reactive read (`snapshot.nodes`) and hands the result
     * down. Writes are unaffected — `mutateNode` needs no reactivity.
     */
    rect: DetachedRect;
    /** RE-ATTACH — clears the one flag. The SAME callback the card's own
     *  right-click menu fires, so the two entry points cannot drift. */
    onreattach: () => void;
    /**
     * DELETE — routed into the node's OWN delete path by the caller, never a
     * second implementation. Deleting from here removes the card; deleting the
     * card removes this, because this only renders while its node is in the
     * graph. That is the bidirectional binding, and it is one code path.
     */
    ondelete: () => void;
  }

  let { nodeId, label, domain, rect, onreattach, ondelete }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let wrapEl: HTMLDivElement | null = $state(null);

  // Live engine dims, mirrored each rAF (the engine is not a reactive store) so
  // the drawing-buffer derive tracks a 4:3 ↔ 16:9 output switch.
  let engineW = $state<number>(ENGINE_W);
  let engineH = $state<number>(ENGINE_H);

  // ── GEOMETRY ──────────────────────────────────────────────────────────────
  // Screen space, not flow space: the panel does NOT pan or zoom with the rack
  // (see the model header). `rect` arrives already clamped — see the prop note.

  /**
   * THE GESTURE'S LIVE GEOMETRY, held locally while a drag/resize is in flight.
   *
   * ⚠ THE POINTER GESTURE DOES NOT TOUCH THE Y.DOC, and that is the rack's own
   * discipline rather than a micro-optimisation: node POSITIONS are written once
   * at `handleNodeDragStop`, never per move, because every `LOCAL_ORIGIN`
   * transaction fires `observeDeep` → a snapshot-bus rebuild → the whole Canvas
   * derive chain → a reconciler pass → a provider broadcast. Writing per
   * `pointermove` is ~60 of those per second for the length of the drag — the
   * update-storm shape `mutate.ts` names on `setControlColor`
   * ([[cv-modulation-live-store-write-storm]]).
   *
   * It also makes the gesture ONE undo entry instead of sixty.
   */
  let gestureRect = $state<DetachedRect | null>(null);
  /** What the panel PAINTS: the in-flight gesture if there is one, else the
   *  clamped rect Canvas derived from the node. */
  let live = $derived<DetachedRect>(gestureRect ?? rect);

  /** Commit geometry to the node — called ONCE, at the end of a gesture. */
  function commitRect(next: DetachedRect): void {
    mutateNode(nodeId, (n) => {
      if (!n.data) n.data = {};
      n.data[DETACHED_KEYS.x] = next.x;
      n.data[DETACHED_KEYS.y] = next.y;
      n.data[DETACHED_KEYS.w] = next.w;
      n.data[DETACHED_KEYS.h] = next.h;
    });
    gestureRect = null;
  }

  // ── DRAG (the header is the handle) ───────────────────────────────────────
  let dragging = $state(false);
  let dragAbort: AbortController | null = null;

  function onDragStart(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const from = { ...live };
    dragAbort?.abort();
    const ctl = new AbortController();
    dragAbort = ctl;
    dragging = true;
    const move = (m: PointerEvent): void => {
      // ⚠ SCREEN px, no zoom divisor. The panel is outside the flow transform,
      // so a 1 px pointer move is 1 px of panel move at every canvas zoom —
      // which is exactly why the divisor `startCornerResize` applies to a CARD
      // must NOT be applied here (`flowStore: null` below says the same).
      // Clamped per move so the panel cannot be dragged somewhere it could not
      // be dragged back from, and so what is committed is what was shown.
      gestureRect = clampDetachedRect(
        { ...from, x: from.x + (m.clientX - startX), y: from.y + (m.clientY - startY) },
        { width: window.innerWidth, height: window.innerHeight },
      );
    };
    const stop = (): void => {
      dragging = false;
      dragAbort = null;
      ctl.abort();
      if (gestureRect) commitRect(gestureRect);
    };
    window.addEventListener('pointermove', move, { signal: ctl.signal });
    window.addEventListener('pointerup', stop, { signal: ctl.signal });
    window.addEventListener('pointercancel', stop, { signal: ctl.signal });
  }

  // ── RESIZE (the corner grip) ──────────────────────────────────────────────
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;

  function onResizeStart(ev: PointerEvent): void {
    // ⚠ ABORT ANY LIVE RESIZE FIRST. Without this a second `pointerdown` on the
    // grip before the matching `pointerup` (multi-touch, or a dropped pointerup)
    // overwrites `resizeAbort` and leaks the first controller's three window
    // listeners — two gestures then applying against different start sizes.
    // `onDragStart` above already guards this way.
    resizeAbort?.abort();
    const start = { ...live };
    resizeAbort = startCornerResize(ev, {
      // Outside the SvelteFlow provider: screen px ARE panel px, no zoom divide.
      flowStore: null,
      minWidth: DETACHED_MIN_W,
      minHeight: DETACHED_MIN_H,
      // FREE-FORM, not the 180 px rack grid: this is not a rack tile, and the
      // owner asked for a resizable display, not one that jumps a whole u.
      // (STICKY takes the same `snapTo: 1` for the same reason.)
      snapTo: 1,
      getStartSize: () => ({ width: start.w, height: start.h }),
      // Local while dragging, committed once at the end — see `gestureRect`.
      apply: (w, h) =>
        (gestureRect = clampDetachedRect(
          { ...start, w, h },
          { width: window.innerWidth, height: window.innerHeight },
        )),
      onStart: () => { resizing = true; },
      onEnd: () => {
        resizing = false;
        resizeAbort = null;
        if (gestureRect) commitRect(gestureRect);
      },
    });
  }

  $effect(() => () => {
    dragAbort?.abort();
    resizeAbort?.abort();
  });

  // ── the output menu (the SAME component the card and the dock body use) ────
  const fs = createFullscreen();
  $effect(() => { fs.setTarget(wrapEl); });
  $effect(() => fs.attach());

  const present = createPresent({
    nodeId: () => nodeId,
    engine: () => engineCtx.get(),
    fullscreen: fs,
  });

  // Presenting = a surface that outlives this component's rect. The panel itself
  // is always one, so the lease is unconditional while it is mounted.
  attachRenderLease({
    engine: () => engineCtx.get(),
    nodeId: () => nodeId,
    presenting: () => true,
  });

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function onPanelContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  // ── the picture ───────────────────────────────────────────────────────────
  // The buffer carries ENGINE dims (not panel dims) so `fitRect` fills it
  // edge-to-edge and the CSS `object-fit: contain` does the ONLY letterboxing —
  // the doubly-letterboxed-preview bug `fullscreen-canvas-dims.ts` documents.
  let bufferDims = $derived(
    // ⚠ THE THIRD ARGUMENT IS IGNORED while the first is `true` — the buffer
    // always carries ENGINE dims here, which is what makes `fitRect` fill it
    // edge-to-edge and leaves the CSS `object-fit: contain` as the ONLY
    // letterboxing (the doubly-letterboxed-preview bug `fullscreen-canvas-dims`
    // documents). It is passed anyway so the call reads the same as every other
    // presenting surface's, and so flipping the first argument stays a one-word
    // change rather than a rewrite.
    fullscreenCanvasDims(true, { canvas: { width: engineW, height: engineH } }, { width: live.w, height: live.h }),
  );

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const srcAspect = liveEngineAspect({ canvas: { width: engineW, height: engineH } });
    const dstAspect = cw / ch;
    if (dstAspect > srcAspect) {
      const h = ch;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    }
    const w = cw;
    const h = Math.round(w / srcAspect);
    return { x: 0, y: Math.round((ch - h) / 2), w, h };
  }

  /** The harness gate, identical to BackdraftOutputBody's and honest for the
   *  same reason: when a spec drives `vid.step()` itself, a 60 Hz blit
   *  underneath it is a second clock. */
  function harnessFrozen(): boolean {
    const g = globalThis as { __videoEngineFreezeRender?: boolean; __videoEnginePause?: boolean };
    return g.__videoEngineFreezeRender === true || g.__videoEnginePause === true;
  }

  let rafId: number | null = null;

  function tick(): void {
    rafId = null;
    const e = engineCtx.get();
    let videoEngine: VideoEngine | undefined;
    if (e) {
      try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { /* not ready */ }
    }
    if (videoEngine) {
      const ew = videoEngine.canvas.width || ENGINE_W;
      const eh = videoEngine.canvas.height || ENGINE_H;
      if (ew !== engineW) engineW = ew;
      if (eh !== engineH) engineH = eh;
      if (!harnessFrozen() && !document.hidden) {
        videoEngine.markWatched?.(nodeId);
        drawOutput(videoEngine);
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function drawOutput(videoEngine: VideoEngine): void {
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    // ⚠ `blitOutputToDrawingBuffer`, NOT `blitOutputForPreview` (#1802/#1836) —
    // a DECISION, not an oversight. The gated call answers "should this CARD
    // repaint its preview this frame", and both of its gates read things that
    // are wrong for this surface:
    //
    //   · the VISIBILITY gate is fed by an IntersectionObserver over
    //     `.svelte-flow__node[data-id]` elements (video-card-visibility.ts). This
    //     panel is deliberately NOT a flow node — that is what makes "no patch
    //     wires" structural — so the only rect the gate could read is the CARD's,
    //     and the card's position says nothing about whether this window is on
    //     screen. Scrolling the rack away would blank a window sitting in front
    //     of the user.
    //   · the CADENCE cap exists to halve the cost of a preview thumbnail. This
    //     is the primary surface for the node, which is exactly the case
    //     preview-gate.ts exempts.
    //
    // The lease this component holds earns both exemptions — a leased node
    // bypasses every gate — so the two calls are equivalent while it is attached.
    //
    // ⚠ THE LEASE IS LOAD-BEARING AND SINGULAR. An earlier version of this note
    // called the ungated blit "braces" to the lease's "belt". MEASURED, that is
    // false: with the lease removed and THIS call left in place, the panel still
    // stops repainting once its card is panned off-screen. The reason is one
    // level down — the blit marks the node watched, but pull evaluation VETOES a
    // watch from a node whose card the IntersectionObserver has reported
    // invisible, so the upstream chain stops and this blit copies a stale FBO.
    // Ungating the blit buys nothing without the lease; the lease is the whole
    // mechanism. (Both legs are pinned: the spec's off-screen test fails with the
    // lease removed, whichever blit call is used.)
    //
    // ⚠ THE BLIT AND THE READ MUST BE ONE SYNCHRONOUS BLOCK. A WebGL drawing
    // buffer only holds its content until the frame ends, and every OUTPUT
    // surface re-blits its OWN node id immediately before reading — that is how
    // N surfaces stay independent instead of last-one-wins.
    try {
      videoEngine.blitOutputToDrawingBuffer(nodeId);
    } catch {
      // Never let an engine error nuke the rAF loop.
    }
    const src = videoEngine.canvas as CanvasImageSource;
    const cw = canvasEl.width;
    const ch = canvasEl.height;
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    const r = fitRect(cw, ch);
    // drawImage() from a WebGL canvas already presents upright.
    ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
  }

  $effect(() => {
    untrack(() => { rafId = requestAnimationFrame(tick); });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions — the picture's only handler is
     `oncontextmenu`, which the browser already dispatches from the keyboard (Menu key /
     Shift+F10), so a key handler would be a second route to the same menu. The panel's
     own actions all live in that menu plus the two header buttons, which are real
     <button>s. -->
<div
  class="detached-display"
  class:dragging
  class:resizing
  style="left: {live.x}px; top: {live.y}px; width: {live.w}px; height: {live.h}px; --domain: {domain ?? 'var(--cable-video)'};"
  data-testid="detached-display"
  data-node-id={nodeId}
  oncontextmenu={onPanelContextMenu}
  role="presentation"
>
  <!-- NEARLY BORDERLESS: a 1 px domain rule and a slim header that is the drag
       handle. Everything else is picture. -->
  <div
    class="dd-bar"
    data-testid="detached-display-bar"
    onpointerdown={onDragStart}
    role="presentation"
  >
    <span class="dd-name">{label}</span>
    <button
      type="button"
      class="dd-btn"
      data-testid="detached-display-reattach"
      title="re-attach this display to its card"
      onclick={(e) => { e.stopPropagation(); onreattach(); }}
    >re-attach</button>
  </div>

  <div bind:this={wrapEl} class="dd-wrap" class:fullscreen={fs.isFullscreen} data-testid="detached-display-wrap">
    <canvas
      bind:this={canvasEl}
      width={bufferDims.width}
      height={bufferDims.height}
      style="aspect-ratio: {bufferDims.aspectRatio};"
      data-testid="detached-display-canvas"
      data-node-id={nodeId}
    ></canvas>
  </div>

  <div
    class="dd-grip"
    role="separator"
    aria-label="Resize detached display"
    data-testid="detached-display-resize"
    onpointerdown={onResizeStart}
  ></div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title={label}
  availableScreens={fs.availableScreens}
  onrequestscreens={() => void fs.loadScreens()}
  onfullscreen={(screenId) => void fs.enter(screenId)}
  onpresent={(screenId) => present.present(screenId)}
  onpresentall={() => present.presentAll(fs.availableScreens.filter((s) => !s.isPrimary).map((s) => s.id))}
  onstoppresent={() => present.stop()}
  isPresenting={present.isPresenting}
  isDetached={true}
  onreattach={onreattach}
  ondelete={ondelete}
  onclose={() => { ctxOpen = false; }}
/>

<style>
  .detached-display {
    /* FIXED, not absolute: the panel is anchored to the VIEWPORT, so it neither
     * pans nor zooms with the rack and cannot be scrolled away from. */
    position: fixed;
    z-index: 60;
    display: flex;
    flex-direction: column;
    background: #000;
    /* THE VIOLET BORDER, from the DOMAIN CHAIN. `--domain` is set inline from
     * the live def's primary cable type (`spineCableVar`) — for a video module
     * that resolves to `--cable-video`. Never a literal. */
    border: 1px solid var(--domain, var(--cable-video));
    border-radius: 3px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    isolation: isolate;
  }
  .detached-display.dragging,
  .detached-display.resizing {
    /* No hover pulses mid-gesture, and the pointer must not be stolen by the
     * picture while the window is being moved. */
    user-select: none;
  }
  .dd-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 6px;
    cursor: move;
    background: color-mix(in srgb, var(--domain, var(--cable-video)) 14%, #000);
    color: var(--text-dim, #9aa3b5);
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    text-transform: lowercase;
  }
  .dd-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dd-btn {
    flex: 0 0 auto;
    padding: 1px 6px;
    font: inherit;
    color: var(--text, #c8cede);
    background: transparent;
    border: 1px solid var(--domain, var(--cable-video));
    border-radius: 2px;
    cursor: pointer;
  }
  .dd-btn:hover,
  .dd-btn:focus-visible {
    background: color-mix(in srgb, var(--domain, var(--cable-video)) 24%, transparent);
    outline: none;
  }
  .dd-wrap {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #050608;
  }
  .dd-wrap canvas {
    width: 100%;
    height: 100%;
    /* contain so the source is never cropped; black bars on the short axis. */
    object-fit: contain;
    display: block;
    image-rendering: pixelated;
  }
  .dd-wrap.fullscreen {
    width: 100vw;
    height: 100vh;
    background: #000;
  }
  .dd-grip {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    /* Same corner triangle the resizable cards draw, in the domain hue. */
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--domain, var(--cable-video)) 50%,
      var(--domain, var(--cable-video)) 60%,
      transparent 60%,
      transparent 70%,
      var(--domain, var(--cable-video)) 70%,
      var(--domain, var(--cable-video)) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .dd-grip:hover { opacity: 1; }
</style>
