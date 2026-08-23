<script lang="ts">
  // packages/web/src/lib/ui/modules/warrensvisions/WarrensvisionsOutputBody.svelte
  //
  // The WARREN'S VISIONS dock full-view body: its live resynthesis picture plus
  // the SCREEN ON/OFF switch the 2026-08-18 owner ruling requires of every
  // video module.
  //
  // ⚠ WHY THIS FILE EXISTS (#1928 class). `WarrensvisionsCard.svelte` owns the
  // only live preview this module has ever had, and promotion is exactly what
  // stops that card rendering: `migrated(type)` becomes true and
  // `DockFullView.svelte` mounts `<ModuleShell>` instead. The card's own header
  // states the stakes better than a gate can — *"this module has an obvious
  // hero visual and the whole point of every knob is what it does to that
  // picture"*. Eleven of the twelve controls describe the resynthesis; a
  // faceplate with no picture asks the player to sculpt blind.
  //
  // The shape below is `FourPlexVidOutputBody`'s deliberately: same key, same
  // overlay geometry, same watch-mark handling. Copying it is the point — a
  // second spelling of this control is how `previewCollapsed` would fork.
  //
  // The LANE tile is untouched: `dockFullViewHeadPlan` renders this slot at the
  // dock only, and the lane keeps the generic `VideoTileThumb`.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';

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
  let rafId: number | null = null;

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT. This component unmounts on dock
  // collapse / LRU eviction — the card-unmount-kills-node-lifetime-state class
  // (#1531 / #1574 / #1583) — and `node.data` is what survives a tab switch (the
  // owner's stated floor), a remount, a reload, and collab sync.
  //
  // ⚠ IT IS THE SAME `previewCollapsed` KEY EVERY OTHER VIDEO BODY USES,
  // deliberately: reading a different key would silently re-open every preview
  // collapsed before the promotion. Absent ⇒ false ⇒ ON.
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

  // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937 / #2015).
  // `blitOutputForPreview` IS the engine's "someone is watching" signal — it
  // calls `markWatched` itself (`video/engine.ts:1679`, deliberately after the
  // gate, because *"a refused frame is not an observation"*) — and a node is a
  // pull root only while its mark is younger than `WATCH_TTL_MS = 1500`
  // (`engine.ts:676, :1147`). So a collapsed state that merely stops blitting
  // stops renewing the mark, and 1.5 s later the module drops out of the pull
  // set: the toggle becomes a PRODUCER KILL SWITCH wherever nothing downstream
  // is watching. That is the #1720/#1721 class the ruling names when it says the
  // module KEEPS RENDERING, and it is the live defect #2015 reports against
  // `spirographs`.
  //
  // ⚠ AND THIS IS THE MODULE WHERE THAT COSTS THE MOST, which is worth stating
  // rather than inheriting from the file this was copied from. #2015's own
  // analysis draws the line at STATEFULNESS: `spirographs` is a pure function of
  // `frame.time`, so a resumed producer catches up and the only symptom is a
  // brief stale frame. WARREN'S VISIONS is the opposite case in every respect
  // that matters:
  //
  //   * its component bank is a TRACKER — peaks are matched frame to frame so a
  //     slowly-changing pattern stays one component, and STABILITY ramps a
  //     component in over N consecutive commits;
  //   * every component's contrast and every residual ring runs a SLEW envelope
  //     (0.02…4 s) advanced once per drawn frame;
  //   * the analysis itself fires every SLICE *rendered frames*, not on a clock.
  //
  // All three advance from `frame.time` inside `surface.draw`, so they advance
  // ONLY when the node is pulled. Dropping the mark here would not show a stale
  // frame on the way back — it would show a BANK STOPPED AT THE MOMENT THE
  // SCREEN WENT OFF, which then re-converges over several SLICE periods while
  // the player watches. Downstream consumers of `out` see the same stall.
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
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); } catch { /* never nuke the rAF loop */ }
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

<div class="wv-output" data-testid="warrensvisions-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="warrensvisions-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="warrensvisions-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the preview is collapsed and its space reclaimed. WARREN\'S VISIONS keeps analysing, tracking and rendering: switching it back on shows the LIVE picture, not a bank stopped where you left it.'
        : 'SCREEN — turn the preview off to collapse it and reclaim the vertical space. The component bank goes on tracking and rendering either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<style>
  .wv-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. See the
     OVERLAY paragraph in module-faceplates.md: a stacked row cost ~18.8 px on a
     card with ~11 px of slack and reddened the card sweep. It OVERLAYS the
     picture's bottom-right corner, so the body is exactly the height the
     picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
  }
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #050608;
    max-width: 100%;
    height: auto;
  }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over a live picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
