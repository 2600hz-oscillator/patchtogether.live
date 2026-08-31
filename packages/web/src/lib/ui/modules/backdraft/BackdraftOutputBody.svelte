<script lang="ts">
  // BACKDRAFT's `fullViewBody` — the module's OWN PICTURE, at the head of its
  // dock faceplate, with the ⛶ OUTPUT menu that opens it larger.
  //
  // WHY THIS FILE HAS TO EXIST. Promotion swaps `BackdraftCard.svelte` for
  // `<ModuleShell view="dock-full">`, and the card is where the `⛶ OUTPUT`
  // button lives. That button is not a `ParamDef` — Full Frame is
  // `node.data.fullFrame`, Present and Full Screen are browser state — so no
  // `ParamCellKind` can express it (none of the ten mounts a canvas, and a
  // `custom` sidebar panel is read-only by contract). It is also the SOLE entry
  // to Full Frame / Full Screen / Present: the node menu offers Docs /
  // Duplicate / Delete and nothing else. Without this slot, promoting backdraft
  // would delete the only way to look at what the module makes — the
  // `warrensspectrum` failure verbatim.
  //
  // ⚠ THIS AUGMENTS THE FACEPLATE, IT DOES NOT REPLACE IT. `fullViewBody`
  // renders at the HEAD of the dock full view and the generic bands still paint
  // below it, so every one of backdraft's 30 user params still owes its own
  // cell and face completeness / dock-parity / faces-parity all still apply.
  //
  // ⚠ 2D CANVAS, DELIBERATELY — `getContext('2d')`, never `webgl`. The WebGL
  // attest basis includes any `.svelte` whose source creates a GL context, so a
  // direct GL surface here would put this file in the basis PERMANENTLY and
  // make every future edit to it cost a ~10-minute owner-machine re-attest. The
  // engine already renders to its own GL canvas; this is a `drawImage` blit of
  // it, which is what the legacy card does for exactly the same reason.

  import { untrack } from 'svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { backdraftPanic } from './panic';
  import { createFullscreen } from '../use-fullscreen.svelte';
  import { createFullFrame } from '../use-full-frame.svelte';
  import { attachRenderLease } from '../use-render-lease.svelte';
  import { createPresent } from '../use-present.svelte';
  import { fullscreenCanvasDims } from '../fullscreen-canvas-dims';
  import { liveEngineAspect } from '../video-card-aspect';
  import VideoCanvasContextMenu from '../VideoCanvasContextMenu.svelte';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';

  interface Props {
    /** The graph node this faceplate is showing. The ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`) — everything else is resolved here,
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

  // TRUE fullscreen: the wrap IS the fullscreen element.
  const fs = createFullscreen();
  $effect(() => { fs.setTarget(wrapEl); });
  $effect(() => fs.attach());

  // Present on a second display. NODE-keyed, not card-keyed
  // (node-present-registry) — which is why it survives this component
  // unmounting when the dock closes, the #1531/#1574/#1583 class.
  const present = createPresent({
    nodeId: () => nodeId,
    engine: () => engineCtx.get(),
    fullscreen: fs,
  });

  // Full Frame — the SAME `node.data.fullFrame` the legacy card persists, so
  // the state is shared with `?shell=legacy` and syncs over Y.Doc rather than
  // becoming a second competing truth. Here it means "fill the dock body".
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
  // Double-click while full-frame exits, mirroring the card's gesture.
  $effect(() => ff.attach(rootEl, () => fullFrame));

  /** The surface is LARGER than its resting size in exactly these modes. */
  let expanded = $derived(fs.isFullscreen || present.isPresenting || fullFrame);

  // ── PREVIEW ON/OFF (owner review round 1) ────────────────────────────────
  // *"the screen preview on the card should have an on/off button and when it's
  // off it collapses so we reclaim the vertical space. that on/off persists
  // through tab switches"*.
  //
  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT, and that is the whole
  // safety argument rather than a preference. A `$state` here dies with the
  // component, and this component unmounts on dock collapse / LRU eviction —
  // the card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` is the SAME seam the sibling toggle on this very surface
  // already uses (`node.data.fullFrame`), so this matches the shipped
  // affordance instead of inventing a second policy: it survives tab switches
  // (the stated floor), survives remount, survives reload, and syncs to
  // collaborators.
  //
  // ⚠ It is NOT transient render state — one boolean per click, never per
  // frame. The Y.Doc write-storm rule is about per-frame CV writes; a click is
  // exactly what `node.data` is for.
  //
  // Absent ⇒ false ⇒ the preview is ON, so an existing rack opens unchanged.
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

  /**
   * Is the in-dock picture taking space right now?
   *
   * ⚠ `expanded` OVERRIDES the collapse. Full Screen / Present / Full Frame all
   * blit from THIS canvas, so a collapsed preview must not black out the
   * projector — the toggle governs the DOCK's resting picture only.
   */
  let previewShown = $derived(expanded || !previewCollapsed);

  // Presenting = a surface that outlives this component's viewport rect. Without
  // the hard lease, pull-eval can freeze the node — and the projector with it
  // (owner report 2026-08-05: backdraft → present froze on scroll).
  attachRenderLease({
    engine: () => engineCtx.get(),
    nodeId: () => nodeId,
    presenting: () => expanded,
  });

  // ⚠ UNLIKE THE CARD, THE RESTING SURFACE IS REAL. The card holds a 0×0 ghost
  // and blits nothing in the rack; here the picture IS the reason the slot
  // exists, so the resting buffer is a real (small) one. It is deliberately
  // MODEST: the blit is a GL readback whose cost scales with the buffer, this
  // paints only while the dock full view is OPEN (one node at a time, since
  // `extBody` is dock-gated by `dockFullViewHeadPlan`), and expanding promotes
  // it to full engine dims anyway.
  const IDLE_BUFFER = { width: 320, height: 240 };
  let bufferDims = $derived(
    fullscreenCanvasDims(
      expanded,
      { canvas: { width: engineW, height: engineH } },
      IDLE_BUFFER,
    ),
  );

  // ── the output menu ───────────────────────────────────────────────────────
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);

  function openOutputMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ctxX = r.left;
    ctxY = r.bottom + 2;
    ctxOpen = true;
  }

  /** Right-click the PICTURE — the second entry point, restored now that there
   *  is a picture to right-click. `stopPropagation` so the SvelteFlow node menu
   *  does not also open. */
  function onPictureContextMenu(e: MouseEvent) {
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

  // ── rAF ───────────────────────────────────────────────────────────────────
  // The harness gate is the HONEST condition, not a test hack: when
  // `__videoEnginePause` is set the specs drive `vid.step()` themselves, and
  // when `__videoEngineFreezeRender` is set nothing renders at all — a frozen
  // engine has no new frame to present. Without it this body would blit at
  // 60 Hz underneath a spec that thinks it owns the clock.
  function harnessFrozen(): boolean {
    const g = globalThis as {
      __videoEngineFreezeRender?: boolean;
      __videoEnginePause?: boolean;
    };
    return g.__videoEngineFreezeRender === true || g.__videoEnginePause === true;
  }

  let rafId: number | null = null;

  function tick() {
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
        // ⚠ markWatched RUNS EVEN WHILE THE PREVIEW IS COLLAPSED, and that is
        // the load-bearing half of the on/off toggle. It keeps the node a PULL
        // ROOT so the engine goes on advancing the feedback nest with nothing
        // patched downstream. Stop it and the module loses its history: the
        // picture would come back BLACK (or as a stale frame) when the preview
        // is switched on again — the collapse-kills-the-producer class
        // (#1721 collapsing a group killed a CARD_PRODUCER pump; #1728
        // collapsing the card blanked the Launchpad). Collapsing here changes
        // what is PAINTED, never what is PRODUCED.
        videoEngine.markWatched?.(nodeId);
        // The BLIT is the only thing the toggle actually saves — a GL readback
        // into a surface nobody can see. Skipped while collapsed, resumed the
        // moment it is shown, and never skipped while expanded (fullscreen and
        // the Present popup both blit from this same canvas).
        if (previewShown) drawOutput(videoEngine);
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

<div class="bd-out" class:full-frame={fullFrame} bind:this={rootEl} data-testid="backdraft-face-output">
  <!-- ⚠ NEVER `{#if}`-ed AWAY. `requestFullscreen()` must be handed a real,
       rendered element at the moment the menu item is clicked, and the Present
       popup blits FROM this canvas every frame — so OFF collapses it to a
       zero-space ghost (the legacy card's own proven shape) rather than
       unmounting it. `.collapsed` takes it out of flow, which is what actually
       reclaims the vertical space; `display:none` would too, but it also
       forfeits the fullscreen target. -->
  <div
    bind:this={wrapEl}
    class="bd-canvas-wrap"
    class:fullscreen={fs.isFullscreen}
    class:collapsed={!previewShown}
    data-testid="backdraft-fs-wrap"
    data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    oncontextmenu={onPictureContextMenu}
    role="presentation"
  >
    <canvas
      bind:this={canvasEl}
      width={bufferDims.width}
      height={bufferDims.height}
      style="aspect-ratio: {bufferDims.aspectRatio};"
      data-testid="backdraft-canvas"
      data-node-id={nodeId}
    ></canvas>
  </div>

  <!-- PANIC sits ABOVE the SCREEN toggle (owner request), so it is on screen
       in every view that carries this chrome — the picture and its buttons
       persist across all dock tabs. One implementation, two triggers: this
       button and the `panic` gate input both run backdraftPanic (one undoable
       LOCAL_ORIGIN transaction; patching untouched — see ./panic.ts). -->
  <div class="bd-btns">
    <button
      type="button"
      class="bd-out-btn bd-panic nodrag"
      data-testid="backdraft-panic"
      title="PANIC — reset every control to its default in one undoable step. Nothing patched changes: cables stay, and a CV source keeps modulating its control around the restored default."
      onclick={() => backdraftPanic(nodeId)}
    >PANIC</button>

    <div class="bd-btn-row">
      <button
        type="button"
        class="bd-out-btn nodrag"
        class:on={!previewCollapsed}
        data-testid="backdraft-preview-toggle"
        aria-pressed={!previewCollapsed}
        title={previewCollapsed
          ? 'SCREEN is OFF — the preview is collapsed and its space reclaimed. The module keeps rendering: switching it back on shows the LIVE picture, not a stale frame.'
          : 'SCREEN — turn the preview off to collapse it and reclaim the vertical space. The module goes on rendering either way.'}
        onclick={togglePreview}
      >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>

      <button
        type="button"
        class="bd-out-btn nodrag"
        class:on={expanded}
        data-testid="backdraft-output-menu"
        title="OUTPUT — show BACKDRAFT's picture larger: Full Frame, Full Screen, or Present on another display. Right-clicking the picture opens the same menu."
        onclick={openOutputMenu}
      >⛶ OUTPUT</button>
    </div>
  </div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="BACKDRAFT"
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
  .bd-out {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    width: 100%;
    min-width: 0;
  }

  .bd-canvas-wrap {
    position: relative;
    flex: 0 0 auto;
    width: 260px;
    max-width: 100%;
    background: #050608;
    border: 1px solid var(--vp-border, #2a2f3a);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
  }

  /* FULL FRAME here means "fill the dock body" — the dock has no card border to
   * consume, so the in-app expansion is of this slot rather than of a card. The
   * PERSISTED flag is the same `node.data.fullFrame` the legacy card writes. */
  .bd-out.full-frame {
    flex-direction: column;
    align-items: stretch;
  }
  .bd-out.full-frame .bd-canvas-wrap {
    width: 100%;
  }

  .bd-canvas-wrap canvas {
    display: block;
    width: 100%;
    height: auto;
  }

  /* PREVIEW OFF — a zero-space ghost. `position: absolute` is what takes it
   * OUT OF FLOW, which is the "reclaim the vertical space" half of the
   * requirement; 1×1 + hidden is what makes it paint nothing. It stays a real,
   * rendered element so `requestFullscreen()` still has a target and the
   * Present popup still has a blit source. Copied in shape from
   * BackdraftCard's in-rack ghost, which has shipped this way for months. */
  .bd-canvas-wrap.collapsed {
    position: absolute;
    width: 1px;
    height: 1px;
    min-width: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
  }

  /* TRUE fullscreen: the wrap IS the fullscreen element, filling the screen. */
  .bd-canvas-wrap.fullscreen {
    width: 100vw;
    height: 100vh;
    border: 0;
    border-radius: 0;
  }
  .bd-canvas-wrap.fullscreen canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .bd-btns {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: stretch;
  }
  .bd-btn-row {
    display: flex;
    gap: 10px;
  }

  .bd-out-btn {
    flex: 0 0 auto;
    padding: 3px 8px;
    font-size: 0.62rem;
    letter-spacing: 0.04em;
    color: var(--vp-text, #c8cede);
    background: var(--vp-surface, #171b24);
    border: 1px solid var(--vp-border, #2a2f3a);
    border-radius: 3px;
    cursor: pointer;
  }
  .bd-out-btn:hover { border-color: var(--vp-accent, #4a90d9); }
  .bd-out-btn.on {
    color: var(--vp-accent, #4a90d9);
    border-color: var(--vp-accent, #4a90d9);
  }

  /* PANIC reads as the warning it is, without shouting at rest. After the
   * .bd-out-btn rules so its colours win at equal specificity. */
  .bd-out-btn.bd-panic {
    color: var(--vp-danger, #e05252);
    border-color: var(--vp-danger-border, #7a3232);
  }
  .bd-out-btn.bd-panic:hover {
    border-color: var(--vp-danger, #e05252);
  }
</style>
