<script lang="ts">
  // videoOut's `fullViewBody` — THE WHOLE FACE, because this module has nothing
  // else.
  //
  // ⚠ WHY THIS FILE IS THE FACEPLATE RATHER THAN A PIECE OF IT. `videoOutDef`
  // declares `params: []`. There is no knob to rank, no page to name, no readout
  // to derive — `face.order` is empty and the generic bands below this slot
  // render nothing at all. What OUTPUT *is* is a SCREEN, so its faceplate is the
  // picture plus the ways of making the picture bigger, and every one of those
  // is `node.data` or browser state that no `ParamCellKind` can express:
  //
  //   full frame   → node.data.fullFrame
  //   detach       → node.data.detached   (#1821)
  //   full screen  → the Fullscreen API
  //   present      → a popup on another display
  //
  // That is the `warrensspectrum` argument in its purest form: promote without
  // this slot and the module loses every route to its own output.
  //
  // ⚠ 2D CANVAS, DELIBERATELY — `getContext('2d')`, never `webgl`. The WebGL
  // attest basis includes any `.svelte` whose source creates a GL context, so a
  // direct GL surface here would put this file in the basis PERMANENTLY and make
  // every future edit cost an owner-machine re-attest. The engine already renders
  // to its own GL canvas; this is a `drawImage` of it, exactly as the legacy card
  // and BackdraftOutputBody do, and for the same reason.
  //
  // ⚠ COMPACT BY DEFAULT. The resting DRAWING BUFFER is modest (IDLE_BUFFER),
  // not the engine resolution — the blit is a GL readback whose cost scales with
  // it, and expanding promotes it to full engine dims anyway. The painted WIDTH
  // is a separate question and is handled in CSS: the picture stretches to fill
  // the plate so no grey space is left beside it (see `.vo-wrap`).

  import { untrack } from 'svelte';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { createFullscreen } from '../use-fullscreen.svelte';
  import { createFullFrame } from '../use-full-frame.svelte';
  import { attachRenderLease } from '../use-render-lease.svelte';
  import { createPresent } from '../use-present.svelte';
  import { fullscreenCanvasDims } from '../fullscreen-canvas-dims';
  import { liveEngineAspect } from '../video-card-aspect';
  import VideoCanvasContextMenu from '../VideoCanvasContextMenu.svelte';
  import {
    DETACHED_KEYS,
    REATTACH_CLEARS,
    detachPatch,
    detachedRect,
    isDetached,
    placeDetached,
  } from '../detached-display';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). Everything else is resolved here,
     *  exactly as the legacy card resolves it. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let wrapEl: HTMLDivElement | null = $state(null);
  let rootEl: HTMLDivElement | null = $state(null);

  // Mirrored each rAF so the drawing-buffer derive tracks a 4:3 ↔ 16:9 switch
  // (the engine is not a reactive store).
  let engineW = $state<number>(ENGINE_W);
  let engineH = $state<number>(ENGINE_H);

  const fs = createFullscreen();
  $effect(() => { fs.setTarget(wrapEl); });
  $effect(() => fs.attach());

  // NODE-keyed, not card-keyed (node-present-registry) — which is why the
  // projector survives this component unmounting when the dock closes: the
  // #1531/#1574/#1583 class.
  const present = createPresent({
    nodeId: () => nodeId,
    engine: () => engineCtx.get(),
    fullscreen: fs,
  });

  // The SAME `node.data.fullFrame` the legacy card persists, so the state is
  // shared with `?shell=legacy` and syncs over Y.Doc rather than becoming a
  // second competing truth. Here it means "fill the dock body".
  let fullFrame = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.fullFrame as boolean | undefined) ?? false,
  );
  const ff = createFullFrame({
    setFullFrame: (on) => {
      mutateNode(nodeId, (live) => {
        if (!live.data) live.data = {};
        live.data.fullFrame = on;
      });
    },
    exitFullscreen: () => void fs.exit(),
  });
  $effect(() => ff.attach(rootEl, () => fullFrame));

  // DETACH (#1821) — the same flag, the same two entry points, the same model
  // as the card's. See $lib/ui/modules/detached-display.
  let detached = $derived(isDetached(patch.nodes[nodeId]));

  function detachDisplay(): void {
    const vp = {
      width: typeof window === 'undefined' ? 1280 : window.innerWidth,
      height: typeof window === 'undefined' ? 720 : window.innerHeight,
    };
    const live = patch.nodes[nodeId];
    const saved = live?.data?.[DETACHED_KEYS.x] !== undefined;
    const box = rootEl?.getBoundingClientRect();
    const rect = saved
      ? detachedRect(live, vp)
      : placeDetached(vp, box ? { x: box.x, y: box.y, w: box.width, h: box.height } : undefined);
    const data = detachPatch(rect);
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      for (const [k, v] of Object.entries(data)) live.data[k] = v;
    });
    if (fullFrame) ff.exit();
    // DETACH SUPERSEDES BROWSER FULLSCREEN TOO. `detachPatch` clears the
    // `node.data` half; the Fullscreen API is browser state it cannot reach,
    // and this wrap is about to show the `display detached` plate.
    void fs.exit();
  }

  function reattachDisplay(): void {
    mutateNode(nodeId, (live) => {
      if (!live.data) return;
      for (const k of REATTACH_CLEARS) delete live.data[k];
    });
  }

  /** The surface is LARGER than its resting size in exactly these modes. */
  let expanded = $derived(fs.isFullscreen || present.isPresenting || fullFrame);

  // Presenting = a surface that outlives this component's viewport rect. Without
  // the hard lease, pull-eval can freeze the node — and the projector with it.
  attachRenderLease({
    engine: () => engineCtx.get(),
    nodeId: () => nodeId,
    presenting: () => expanded,
  });

  const IDLE_BUFFER = { width: 320, height: 240 };
  let bufferDims = $derived(
    fullscreenCanvasDims(expanded, { canvas: { width: engineW, height: engineH } }, IDLE_BUFFER),
  );

  // ── the display menu ──────────────────────────────────────────────────────
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);

  function openDisplayMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ctxX = r.left;
    ctxY = r.bottom + 2;
    ctxOpen = true;
  }

  /** Right-click the PICTURE — the second entry point, identical to the card's
   *  and to the floating panel's, because all three mount the same menu. */
  function onPictureContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

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

  /** The harness gate is the HONEST condition, not a test hack: when
   *  `__videoEnginePause` is set the specs drive `vid.step()` themselves, and
   *  when `__videoEngineFreezeRender` is set nothing renders at all. */
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
        // ⚠ WHILE DETACHED THIS SURFACE SHOWS THE `display detached` PLATE,
        // not the picture — so it neither blits NOR marks watched, and drops out
        // of the observer set. *"A card that is not showing anything must not be
        // an observer, and the way to stop being one is to stop blitting,
        // because the blit IS the watch mark"* (preview-gate.ts, #1802/#1836,
        // measured on a backdraft that kept a chain at 481 frames in 4 s for a
        // picture on no surface).
        //
        // The observer MOVED to `DetachedDisplay`, which blits this node every
        // frame and holds a render lease. Re-attaching brings it back here.
        if (!detached) {
          videoEngine.markWatched?.(nodeId);
          drawOutput(videoEngine);
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function drawOutput(videoEngine: VideoEngine): void {
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (!ctx2d) return;
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
    drawPreviewDownscaled(ctx2d, src, r.x, r.y, r.w, r.h);
  }

  $effect(() => {
    untrack(() => { rafId = requestAnimationFrame(tick); });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    };
  });
</script>

<div class="vo-face" class:full-frame={fullFrame} bind:this={rootEl} data-testid="videoout-face-output">
  <!-- ⚠ NEVER `{#if}`-ed AWAY. `requestFullscreen()` must be handed a real,
       rendered element at the moment the menu item is clicked, and the Present
       popup is NODE-keyed and blits the ENGINE, not this canvas — so DETACHED covers it with the
       plate rather than unmounting it. The plate sits inside the wrap that owns
       `oncontextmenu`, so right-clicking it is how "re-attach" is reached from
       the faceplate. -->
  <!-- svelte-ignore a11y_no_static_element_interactions — the only handler is
       `oncontextmenu`, which the browser already dispatches from the keyboard
       (Menu key / Shift+F10); a key handler would be a second route to one menu. -->
  <div
    bind:this={wrapEl}
    class="vo-wrap"
    class:fullscreen={fs.isFullscreen}
    data-testid="videoout-fs-wrap"
    data-detached={detached ? 'true' : 'false'}
    oncontextmenu={onPictureContextMenu}
    role="presentation"
  >
    <canvas
      bind:this={canvasEl}
      width={bufferDims.width}
      height={bufferDims.height}
      style="aspect-ratio: {bufferDims.aspectRatio};"
      data-testid="videoout-face-canvas"
      data-node-id={nodeId}
    ></canvas>
    {#if detached}
      <div class="vo-detached" data-testid="videoout-face-detached-plate">display detached</div>
    {/if}
  </div>

  <div class="vo-actions">
    <button
      type="button"
      class="vo-btn nodrag"
      class:on={expanded}
      data-testid="videoout-display-menu"
      title="display — show this output larger: full frame, full screen, detach it as a floating window, or present it on another display. Right-clicking the picture opens the same menu."
      onclick={openDisplayMenu}
    >⛶ display</button>
    <button
      type="button"
      class="vo-btn nodrag"
      class:on={detached}
      data-testid="videoout-face-detach"
      title={detached
        ? 're-attach the floating display to this module'
        : 'detach the display: the picture floats free of the rack, resizable, with no patch wires'}
      onclick={() => (detached ? reattachDisplay() : detachDisplay())}
    >{detached ? 're-attach' : 'detach'}</button>
  </div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="output"
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
  /* ⚠ A COLUMN, AND THE REASON IS MEASURED. Side-by-side (picture | buttons)
   * made the rightmost thing in the face the BUTTON'S TEXT, and a button has
   * 8 px of inner padding plus a border — so the content extent stopped ~10 px
   * short of the button's own edge and `face-videoOut-dock` reported 42 CSS px
   * of empty plate against a 40 px ceiling. Measured across faces, the plate
   * carries ~32-33 px of chrome slack for everyone (adsr 33, delay 33,
   * backdraft 32); videoOut was the outlier only because of that trailing
   * padding.
   *
   * Stacking makes the CANVAS the rightmost element — a box the gate measures
   * directly rather than a text range inside a padded control — so the slack
   * lands on the same chrome baseline as every sibling. It is also the better
   * layout: a live picture is the thing that EARNS width, and it now gets the
   * whole plate instead of sharing a row with two small buttons. */
  .vo-face {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    width: 100%;
    min-width: 0;
  }
  .vo-wrap {
    position: relative;
    /* ⚠ THE PICTURE ABSORBS THE PLATE'S SLACK, and that is the fix for a real
     * gate failure rather than a preference. A fixed 260 px left `face-videoOut-
     * dock` with 42 CSS px of EMPTY PLATE to the right of the content (measured:
     * content 354, plate 396, against a 40 px ceiling) — the "reserving width
     * nothing draws in" defect the owner's compact rule is aimed at.
     *
     * Stretching is the RIGHT answer here rather than a tuned width, twice over:
     * a live picture is the canonical thing that EARNS width, and `flex: 1 1 auto`
     * makes the slack zero BY CONSTRUCTION instead of by a number that cancels a
     * padding somebody may change. `min-width: 0` is required or the flex item
     * refuses to shrink below its content. */
    /* The picture spans the plate. A floor so it cannot collapse to a stripe
     * on a narrow pane; the plate follows the content above that. */
    width: 100%;
    min-width: 260px;
    max-width: 100%;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
  }
  .vo-wrap canvas {
    display: block;
    width: 100%;
    height: auto;
  }
  /* FULL FRAME here means "fill the dock body" — the dock has no card border to
   * consume, so the in-app expansion is of this slot rather than of a card. The
   * PERSISTED flag is the same `node.data.fullFrame` the legacy card writes. */
  .vo-face.full-frame {
    flex-direction: column;
    align-items: stretch;
  }
  .vo-face.full-frame .vo-wrap {
    width: 100%;
  }
  /* TRUE fullscreen: the wrap IS the fullscreen element, filling the screen. */
  .vo-wrap.fullscreen {
    width: 100vw;
    height: 100vh;
    border: 0;
    border-radius: 0;
  }
  .vo-wrap.fullscreen canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .vo-detached {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #050608;
    border: 1px dashed var(--cable-video);
    color: var(--vp-text, #c8cede);
    font-size: 0.62rem;
    letter-spacing: 0.06em;
    line-height: 1;
  }
  .vo-actions {
    display: flex;
    flex-direction: row;
    gap: 6px;
  }
  .vo-btn {
    flex: 0 0 auto;
    padding: 3px 8px;
    font-size: 0.62rem;
    letter-spacing: 0.04em;
    color: var(--vp-text, #c8cede);
    background: var(--vp-surface, #171b24);
    border: 1px solid var(--vp-border, #2a2f3a);
    border-radius: 3px;
    cursor: pointer;
    white-space: nowrap;
  }
  .vo-btn:hover { border-color: var(--cable-video); }
  .vo-btn.on {
    color: var(--cable-video);
    border-color: var(--cable-video);
  }
</style>
