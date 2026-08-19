<script lang="ts">
  // packages/web/src/lib/ui/modules/spirographs/SpirographsOutputBody.svelte
  //
  // The SPIROGRAPHS dock full-view body: its live picture plus the SCREEN
  // ON/OFF switch the owner ruling requires.
  //
  // ⚠ WHY THIS FILE EXISTS (#1928). The 2026-08-18 ruling is that EVERY video
  // module carries a screen on/off toggle. `spirographs` shipped one — on
  // `SpirographsCard.svelte` — and was then promoted into `STRICT_FACES`, which
  // makes `migrated()` true and stops BOTH surfaces from rendering that card.
  // The control was therefore unreachable from the thing that replaced it: the
  // ruling was met on a surface nobody sees any more.
  //
  // ⚠ AND THERE WAS NO GENERIC AFFORDANCE TO FALL BACK ON — `previewCollapsed`
  // appears in ZERO shell files. The seam for this is the `fullViewBody` shell
  // extension slot, which `backdraft` and `videoOut` already adopt; the owner's
  // instruction was to make spirographs behave the way backdraft does. So this
  // is that pattern applied, not a new one invented.
  //
  // The LANE tile is deliberately untouched. `dockFullViewHeadPlan` renders this
  // slot at the dock only, because a 192 px lane tile cannot carry a module
  // surface — the lane keeps the generic `VideoTileThumb`, exactly as backdraft's
  // does.
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

  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT, and that is a safety
  // argument rather than a preference. A `$state` here dies with the component,
  // and this component unmounts on dock collapse / LRU eviction — the
  // card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` survives a tab switch (the owner's stated floor), a remount, a
  // reload, and syncs to collaborators.
  //
  // ⚠ IT IS THE SAME KEY THE CARD USED, deliberately: a rack saved before this
  // promotion carries `previewCollapsed` already, and reading a different key
  // would silently reopen every collapsed preview. Absent ⇒ false ⇒ ON, so an
  // existing rack opens unchanged either way.
  //
  // One boolean per CLICK, never per frame — nowhere near the per-frame CV
  // write-storm rule.
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

  // ⚠ COLLAPSING STOPS A COPY, NEVER A PRODUCER — and on this module that is
  // structural rather than careful. Spirographs' picture is produced by the
  // VIDEO ENGINE's own module instance, which the engine owns; this component
  // only READS it through `blitOutputForPreview`. So the #1720/#1721 class
  // ("OFF tore the producer down, ON showed a stale frame") has no purchase
  // here: the engine renders throughout, so the first frame after switching
  // back ON is current by construction.
  function draw() {
    rafId = null;
    if (previewCollapsed) return; // nothing to draw into
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
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

  // The copy loop starts and stops WITH the SCREEN state. `draw` returns without
  // rescheduling while collapsed, so switching back ON needs an explicit restart
  // — without one the picture would never come back, which is precisely the
  // failure the toggle exists to avoid. ONE place owns the loop, so it cannot be
  // started twice.
  $effect(() => {
    if (previewCollapsed) {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      return;
    }
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="spiro-output" data-testid="spirographs-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="spirographs-face-canvas"
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="spirographs-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the preview off to reclaim its space. The module keeps rendering."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .spiro-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT, which is a fix rather than a style
     choice — see the OVERLAY paragraph in module-faceplates.md. Stacking it
     under the canvas cost ~18.8px on a card with ~11px of slack and reddened
     io-spec-consistency's card sweep. It OVERLAYS the picture's bottom-right
     corner, so the body is exactly the height the picture is. */
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
