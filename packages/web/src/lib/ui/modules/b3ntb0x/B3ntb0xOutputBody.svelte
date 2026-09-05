<script lang="ts">
  // packages/web/src/lib/ui/modules/b3ntb0x/B3ntb0xOutputBody.svelte
  //
  // The B3NTB0X dock full-view body: the live CRT picture, the SCREEN ON/OFF
  // switch the 2026-08-18 owner ruling requires of every video module, and the
  // FOUR affordances that live only on `B3ntb0xCard.svelte` and would otherwise
  // be deleted by promotion (#1896's STOP-2 inventory, read rather than
  // grepped):
  //
  //   1. fullscreen / full-frame / present-on-second-display + the canvas
  //      context menu that reaches all three;
  //   2. the render LEASE that keeps the node evaluating while a surface
  //      outlives this component's viewport rect;
  //   3. the RESIZE handle writing `data.width` / `data.height`;
  //   4. `data.fullFrame`.
  //
  // Promotion is what makes this file necessary: `migrated(type)` becomes true
  // and `DockFullView` mounts `<ModuleShell>` INSTEAD of the card, so every one
  // of the above disappears from both surfaces at once unless the face carries
  // it. That is the #1934 shape — the control deleted by the promotion meant to
  // keep it — and `video-face-screen-source.test.ts` (#1935) is the gate that
  // refuses it by name for the SCREEN switch specifically.
  //
  // Template: `videoOut/VideoOutBody.svelte` for the display affordances and
  // `freezeframe/FreezeframeOutputBody.svelte` for the screen switch and its
  // watch-mark rule. Nothing here is a second implementation of either.
  //
  // The LANE tile is untouched: `dockFullViewHeadPlan` renders this slot at the
  // dock only, because a 192 px lane tile cannot carry a module surface.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import { createFullscreen } from '../use-fullscreen.svelte';
  import { createFullFrame } from '../use-full-frame.svelte';
  import { attachRenderLease } from '../use-render-lease.svelte';
  import { createPresent } from '../use-present.svelte';
  import VideoCanvasContextMenu from '../VideoCanvasContextMenu.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let wrapEl: HTMLDivElement | null = $state(null);
  let rootEl: HTMLDivElement | null = $state(null);
  let rafId: number | null = null;

  // ── SCREEN ON/OFF ─────────────────────────────────────────────────────────
  //
  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT. This component unmounts on dock
  // collapse / LRU eviction — the card-unmount-kills-node-lifetime-state class
  // (#1531 / #1574 / #1583) — and `node.data` is what survives a tab switch
  // (the owner's stated floor), a remount, a reload, and collab sync.
  //
  // ⚠ THE SAME `previewCollapsed` KEY THE CARD USES, deliberately: a rack saved
  // before this promotion already carries it, and reading a different key would
  // silently re-open every collapsed preview. Absent ⇒ false ⇒ ON.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ── the display affordances, all four NODE-keyed ─────────────────────────
  const fs = createFullscreen();
  $effect(() => { fs.setTarget(wrapEl); });
  $effect(() => fs.attach());

  // NODE-keyed, not card-keyed (node-present-registry) — which is why the
  // projector survives this component unmounting when the dock closes.
  const present = createPresent({
    nodeId: () => nodeId,
    engine: () => engineCtx.get(),
    fullscreen: fs,
  });

  // The SAME `node.data.fullFrame` a rack saved before this promotion already
  // carries, so the switch keeps its state across the change and syncs over
  // Y.Doc rather than becoming component-local — a second, competing truth.
  // Here it means "fill the dock body", the same meaning shift `videoOut`'s
  // body documents for the same key.
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

  /** The surface is LARGER than its resting size in exactly these modes. */
  let expanded = $derived(fs.isFullscreen || present.isPresenting || fullFrame);

  // Presenting = a surface that outlives this component's viewport rect.
  // Without the hard lease, pull-eval can freeze the node — and the projector
  // with it.
  attachRenderLease({
    engine: () => engineCtx.get(),
    nodeId: () => nodeId,
    presenting: () => expanded,
  });

  // ── the RESIZE handle (#1896 item 3) ─────────────────────────────────────
  //
  // ⚠ THE CARD'S HANDLE RESIZES THE CANVAS NODE through `flowStore`; there is no
  // xyflow node to resize here, so this one sizes the PREVIEW inside the dock
  // pane. It writes the SAME `data.width` / `data.height` keys, which is the
  // deliberate reuse `videoOut` makes for `fullFrame`: one persisted truth per
  // idea, with the meaning stated where it shifts. A rack saved from either
  // surface therefore reopens at the size its author chose.
  //
  // The floors are the ones the module's own `docs` promise ("default 540x540,
  // min 360x540"), read off the card's constants rather than re-typed.
  const MIN_W = 360;
  const MIN_H = 540;
  const DEF_W = 540;
  const DEF_H = 540;
  let boxW = $derived<number>(
    Math.max(MIN_W, (patch.nodes[nodeId]?.data?.width as number | undefined) ?? DEF_W),
  );
  let boxH = $derived<number>(
    Math.max(MIN_H, (patch.nodes[nodeId]?.data?.height as number | undefined) ?? DEF_H),
  );
  let resizing = $state(false);
  function onResizeStart(ev: PointerEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const w0 = boxW;
    const h0 = boxH;
    resizing = true;
    const ac = new AbortController();
    const move = (e: PointerEvent) => {
      const w = Math.max(MIN_W, Math.round(w0 + (e.clientX - startX)));
      const h = Math.max(MIN_H, Math.round(h0 + (e.clientY - startY)));
      // guard:allow-raw-write — fires per pointermove during a drag; a tracked
      // write per frame would storm the doc and flood the undo stack.
      const target = patch.nodes[nodeId];
      if (target) {
        if (!target.data) target.data = {};
        target.data.width = w;
        target.data.height = h;
      }
    };
    const end = () => { resizing = false; ac.abort(); };
    window.addEventListener('pointermove', move, { signal: ac.signal });
    window.addEventListener('pointerup', end, { signal: ac.signal });
    window.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // ── the display menu ─────────────────────────────────────────────────────
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function onPictureContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937).
  // `blitOutputForPreview` IS the engine's "someone is watching" signal — it
  // calls `markWatched` itself — and a node is a pull root only while that mark
  // is younger than `WATCH_TTL_MS`. A collapsed state that merely stopped
  // blitting would stop marking the node watched, and the toggle would become a
  // PRODUCER KILL SWITCH wherever nothing downstream is watching, showing a
  // stale frame when switched back on. That is the #1720/#1721 class the ruling
  // names when it says the module KEEPS RENDERING.
  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); }
      catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
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
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop, and it runs in BOTH screen states (see above), so
  // nothing has to restart it on toggle — which removes the "switched back on
  // and the picture never came back" failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="bx-output" bind:this={rootEl} data-testid="b3ntb0x-output-body">
  <div
    class="preview-wrap"
    bind:this={wrapEl}
    data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    style={previewCollapsed ? undefined : `width:${boxW}px;max-width:100%;`}
  >
    {#if !previewCollapsed}
      <!-- svelte-ignore a11y_no_static_element_interactions — the only handler
           here is `oncontextmenu`, which opens the display menu; the same
           affordance the card and the floating panel mount. -->
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        class="bx-canvas"
        data-testid="b3ntb0x-face-canvas"
        oncontextmenu={onPictureContextMenu}
      ></canvas>
      <div
        class="resize-handle nodrag"
        class:resizing
        role="separator"
        aria-label="Resize B3NTB0X preview"
        data-testid="b3ntb0x-face-resize-handle"
        onpointerdown={onResizeStart}
      ></div>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="b3ntb0x-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the preview is collapsed and its space reclaimed. B3NTB0X keeps rendering: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the preview off to collapse it and reclaim the vertical space. The module goes on rendering either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="B3NTB0X"
  availableScreens={fs.availableScreens}
  onrequestscreens={() => void fs.loadScreens()}
  onfullscreen={(screenId) => { ff.exit(); void fs.enter(screenId); }}
  onfullframe={() => ff.toggle(fullFrame)}
  isFullFrame={fullFrame}
  onpresent={(screenId) => present.present(screenId)}
  onpresentall={() => present.presentAll(fs.availableScreens.filter((s) => !s.isPrimary).map((s) => s.id))}
  onstoppresent={() => present.stop()}
  isPresenting={present.isPresenting}
  onclose={() => { ctxOpen = false; }}
/>

<style>
  .bx-output {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .preview-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .bx-canvas {
    display: block;
    width: 100%;
    height: auto;
    background: #050608;
    border: 1px solid var(--border);
    border-radius: 2px;
  }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 26px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    opacity: 0.5;
    background: linear-gradient(135deg, transparent 50%, var(--border) 50%);
  }
  .resize-handle:hover,
  .resize-handle.resizing { opacity: 1; }
  .screen-btn {
    align-self: flex-start;
    font: inherit;
    font-size: 0.62rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
