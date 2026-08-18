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
  // ⚠ COMPACT BY DEFAULT. The resting picture is a MODEST buffer, not the engine
  // resolution: `.faceplate-body` is `width: max-content`, so this canvas'
  // painted width IS the dock plate's width for a face with no bands. Width has
  // to be earned, and a live picture earns exactly as much as it needs to be
  // read — not as much as the engine happens to render.

  import { untrack } from 'svelte';
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
    REATTACH_CLEARS,
    detachPatch,
    detachedRect,
    isDetached,
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
    const rect = detachedRect(patch.nodes[nodeId], {
      width: typeof window === 'undefined' ? 1280 : window.innerWidth,
      height: typeof window === 'undefined' ? 720 : window.innerHeight,
    });
    const data = detachPatch(rect);
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      for (const [k, v] of Object.entries(data)) live.data[k] = v;
    });
    if (fullFrame) ff.exit();
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
        // ⚠ markWatched RUNS EVEN WHILE DETACHED, and skipping the blit is
        // exactly why it has to. `blitOutputToDrawingBuffer` marks the node
        // watched as its first act — *"a blit IS the 'something is showing this
        // node' signal for pull evaluation"* (engine.ts) — so a surface that
        // stops blitting silently stops watching, and pull-eval drops the
        // upstream chain after WATCH_TTL_MS. Only the READBACK is skipped,
        // because the floating panel is doing it instead: detaching MOVES the
        // picture, it does not clone it (the #1802 per-card cost), and it never
        // stops the engine (the collapse-kills-the-producer class).
        videoEngine.markWatched?.(nodeId);
        if (!detached || expanded) drawOutput(videoEngine);
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

<div class="vo-face" class:full-frame={fullFrame} bind:this={rootEl} data-testid="videoout-face-output">
  <!-- ⚠ NEVER `{#if}`-ed AWAY. `requestFullscreen()` must be handed a real,
       rendered element at the moment the menu item is clicked, and the Present
       popup blits FROM this canvas every frame — so DETACHED covers it with the
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
  .vo-face {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    width: 100%;
    min-width: 0;
  }
  .vo-wrap {
    position: relative;
    flex: 0 0 auto;
    /* MODEST BY DEFAULT — this width IS the dock plate's width for a face with
     * no control bands, so it is the whole of what this face charges the
     * faceplate. Wide enough to read a video frame, not wide enough to be gray
     * space. */
    width: 260px;
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
    flex-direction: column;
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
