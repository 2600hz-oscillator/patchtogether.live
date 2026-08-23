<script lang="ts">
  // packages/web/src/lib/ui/modules/lushgarden/LushGardenScreenBody.svelte
  //
  // The LUSH GARDEN dock full-view body: the live garden plus the SCREEN ON/OFF
  // switch the 2026-08-18 owner ruling requires of every video module.
  //
  // ⚠ 2D CONTEXT ONLY, AND THAT IS AN ATTEST CONSTRAINT RATHER THAN A STYLE
  // CHOICE. `lushgarden.ts` and `lushgarden-scene.ts` are both in the WebGL
  // attest basis; `LushGardenCard.svelte` is correctly OUTSIDE it because it uses
  // a 2D context. This body blits the engine's already-rendered canvas the same
  // way. Creating a GL context here would pull this file into the basis through
  // the whole-directory sweep, and every future edit would cost a GPU re-attest.
  //
  // The mechanics are the fleet's (`ShapesOutputBody` / `FourPlexVidOutputBody`):
  // same node-data key, same overlay geometry, same watch-mark handling. Copying
  // them is the point — a second spelling of `previewCollapsed` is how these fork.
  // What is NOT copied is the watch-mark argument, which is per-module and is the
  // sharpest in the fleet here (see below).
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

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT. This component unmounts on dock
  // collapse / LRU eviction — the card-unmount-kills-node-lifetime-state class
  // (#1531 / #1574 / #1583) — and `node.data` is what survives a tab switch (the
  // owner's stated floor), a remount, a reload, and collab sync. Absent ⇒ false
  // ⇒ ON, which is the declared default the fleet already reads.
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
  // calls `markWatched` itself, after the gate — and a node is a pull root only
  // while that mark is younger than `WATCH_TTL_MS`. A collapsed state that merely
  // stopped blitting would stop renewing the mark, and SCREEN would become a
  // PRODUCER KILL SWITCH wherever nothing downstream is watching.
  //
  // ⚠ AND ON THIS MODULE THE CONSEQUENCE IS THE SHARPEST IN THE FLEET, for TWO
  // independent reasons — do not reduce it to the generic one.
  //
  //   1. IT IS A PURE SOURCE. LUSH GARDEN has no input requirement (its only
  //      video input is an optional backdrop), so it is the ORIGIN of whatever is
  //      downstream. A lapsed mark would not stall a preview, it would MUTE the
  //      generator every consumer is sampling.
  //
  //   2. ⚠ THE PICTURE IS AN ACCUMULATION, not a function of the current params.
  //      Plants spawn on a rate and each integrates a grow-in curve, so the frame
  //      is a running integration over the node's whole lifetime. If collapsing
  //      stopped `surface.draw`, the garden would stop GROWING — and re-opening
  //      SCREEN would show a garden YOUNGER THAN THE RACK. Every other adopter's
  //      picture is stateless enough that "keeps rendering" is a performance
  //      nicety; here it is a correctness requirement, and it is a permanent leg
  //      of `lushgarden-face-model.test.ts`.
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      // The mark, and nothing else. The engine goes on calling surface.draw, so
      // the garden goes on growing while the picture is hidden.
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
      // Letterbox to the engine aspect — the picture is a VIEWPORT and never
      // changes the output resolution.
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
  // nothing has to restart it on toggle — which removes the "switched back on and
  // the picture never came back" failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="lushgarden-output" data-testid="lushgarden-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="lushgarden-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="lushgarden-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the garden is collapsed and its space reclaimed. LUSH GARDEN keeps growing and keeps feeding all four outputs: switching it back on shows the garden as old as the rack, not a fresh one.'
        : 'SCREEN — turn the garden off to collapse it and reclaim the vertical space. LUSH GARDEN goes on growing and feeding its outputs either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<style>
  .lushgarden-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. A stacked
     row cost spirographs ~18.8 px against ~11 px of slack and overhung its card
     by 7.8 CSS px against a tolerance of 6. It OVERLAYS the picture's
     bottom-right corner, so the body is exactly the height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a floor
       the wrap would collapse to zero and take the absolutely-positioned button
       with it. Inert behind the canvas whenever the picture shows. */
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
