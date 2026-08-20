<script lang="ts">
  // packages/web/src/lib/ui/modules/grainsOfVision/GrainsOfVisionOutputBody.svelte
  //
  // The GRAINS OF VISION dock full-view body: its live picture plus the SCREEN
  // ON/OFF switch the 2026-08-18 owner ruling requires of every video module.
  //
  // ⚠ WHY IT IS HERE AND NOT ON THE CARD (#1928). Promotion sets
  // `migrated('grainsOfVision')` true, and neither surface renders
  // `GrainsOfVisionCard.svelte` after that — so a toggle authored only on the
  // card is deleted by the promotion meant to keep it. That is what
  // `spirographs` shipped and #1930 repaired.
  //
  // The LANE tile is deliberately untouched: `dockFullViewHeadPlan` renders
  // this slot at the dock only, because a 192 px lane tile cannot carry a
  // module surface. The lane keeps the generic `VideoTileThumb`.
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

  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on dock collapse / LRU eviction
  // — the card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` survives a tab switch (the owner's stated floor), a remount, a
  // reload, and syncs to collaborators. Absent ⇒ false ⇒ ON.
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

  /** Resolve the live video engine, or undefined mid-teardown. Never throws —
   *  an engine hiccup must not kill the rAF loop. */
  function videoEngine(): VideoEngine | undefined {
    const e = engineCtx.get();
    if (!e) return undefined;
    try {
      return e.getDomain<VideoEngine>('video');
    } catch {
      return undefined;
    }
  }

  // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK — AND ON THIS MODULE
  // THAT IS NOT A REFINEMENT, IT IS THE DIFFERENCE BETWEEN A SWITCH AND A
  // DESTRUCTIVE ONE. Measured off the engine rather than assumed:
  //
  //   * `blitOutputForPreview` IS the "someone is watching" signal — it calls
  //     `markWatched` itself, after the gate, because "a refused frame is not an
  //     observation".
  //   * a node is a pull root only while its mark is younger than
  //     `WATCH_TTL_MS = 1500`.
  //
  // So a SCREEN-OFF state that simply stops calling the blit stops marking the
  // node watched, and 1.5 s later it drops out of the pull set. On a stateless
  // module that merely pauses the picture. HERE THE MODULE'S ENTIRE SUBJECT IS
  // ACCUMULATED STATE: an 8-frame history ring, a feedback buffer that folds the
  // previous output back in, and a reverb accumulator that decays over frames.
  // Stop pulling it and the ring stops advancing — switching back ON would
  // resume from a frozen past rather than showing the live picture, which is
  // exactly the #1720/#1721 class the owner ruling names when it says the module
  // KEEPS RENDERING.
  //
  // Marking directly is the supported route — `markWatched` is public precisely
  // so bespoke presentation paths (and tests) can mark directly. It is one
  // `Map.set` per frame against a blit plus a downscale, so SCREEN OFF still
  // reclaims essentially all of the cost, which is what the switch is for. A
  // hard `renderLease` is deliberately NOT used: the engine reserves that for
  // surfaces that outlive their card's viewport, and a soft mark is what lets
  // this decay naturally once the dock closes and this component unmounts.
  //
  // ⚠ THIS DIVERGES FROM `SpirographsOutputBody.svelte`, DELIBERATELY AND WITH
  // AN ISSUE FILED. That one returns from `draw` without rescheduling while
  // collapsed and renews no mark; its comment argues the engine renders
  // throughout, which holds only while something ELSE is pulling the node. On a
  // rack where the faceplate is the only observer it does not, and on a module
  // with no accumulated state the consequence is invisible. It is visible here.
  function draw() {
    rafId = null;
    const ve = videoEngine();
    if (!ve) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      try { ve.markWatched(nodeId); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = ve.blitOutputForPreview(nodeId); } catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = ve.canvas as CanvasImageSource;
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

  // ONE place owns the loop, so it cannot be started twice. The loop runs in
  // BOTH screen states (see above), so nothing has to restart it on toggle —
  // which also removes the "switched back on and the picture never came back"
  // failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="gov-output" data-testid="grainsOfVision-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="grainsOfVision-face-canvas"
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="grainsOfVision-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the preview off to reclaim its space. The module keeps rendering."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .gov-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. See the
     OVERLAY paragraph in module-faceplates.md: stacking it under the canvas
     cost ~18.8px on a card with ~11px of slack and reddened io-spec-
     consistency's card sweep. It OVERLAYS the picture's bottom-right corner,
     so the body is exactly the height the picture is. */
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
