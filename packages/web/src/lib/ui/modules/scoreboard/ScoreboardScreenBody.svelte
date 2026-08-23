<script lang="ts">
  // packages/web/src/lib/ui/modules/scoreboard/ScoreboardScreenBody.svelte
  //
  // THE SCOREBOARD DISPLAY — the dock full-view body: the 4-digit neon counter
  // plus the SCREEN ON/OFF switch the 2026-08-18 ruling requires of every video
  // module.
  //
  // ⚠ WHY THIS FILE EXISTS (#1928 class). `ScoreboardCard.svelte` owns the only
  // view of the counter, and promotion is what stops that card rendering. On
  // most modules losing the preview costs a monitor; here it costs the ANSWER —
  // the module's whole product is a number, and the face's only other control
  // is what colour that number glows. A hue wheel attached to nothing you can
  // see is not a faceplate.
  //
  // ⚠ WHAT IT DELIBERATELY DOES NOT CARRY, and this one is a non-finding worth
  // stating: NOTHING. Unlike the other two faces this lane shipped, the card
  // paints no resting derived text at all — no readout row, no state word, no
  // decimal — so there is nothing to delete and nothing to relocate into
  // `aria-valuetext`. The DIGITS are the module's OUTPUT PICTURE, what the
  // `out` port emits, not a printed reading of a control.
  //
  // ⚠ NO WIDTH TRANSITION HERE, deliberately. A sibling face in this lane
  // animated its frame's width on toggle, and a one-shot `boundingBox()` read
  // then became a race that passed on a GPU and failed 3/3 under SwiftShader.
  // This body collapses its canvas outright — instant, no intermediate state to
  // sample — so its render legs have no geometry race to design around.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // ⚠ THE MODULE IS 8:3, NOT THE ENGINE'S 4:3. SCOREBOARD rasterizes its digits
  // into an 8:3 source and its own shader letterboxes that into the 4:3 engine
  // frame with black bands top and bottom. Sampling the ENGINE output and
  // showing it at 4:3 would reproduce those bands on the faceplate — a display
  // widget framed by two thick black stripes. So the canvas is authored at the
  // module's own 8:3 and the letterbox fit below collapses to a no-op, which
  // puts the digits edge to edge where they belong.
  const CANVAS_W = 640;
  const CANVAS_H = 240;
  const ENGINE_ASPECT = 4 / 3;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT. This component unmounts on dock
  // collapse / LRU eviction (the #1531 / #1574 / #1583 class), and `node.data`
  // is what survives a tab switch (the owner's stated floor), a remount, a
  // reload, and collab sync.
  //
  // ⚠ IT IS THE SAME `previewCollapsed` KEY EVERY OTHER VIDEO SURFACE USES,
  // deliberately: a rack saved before this promotion already carries it, and a
  // different key would silently re-open every preview collapsed before it.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function toggleScreen(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  function draw(): void {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937 / #2015).
      // `blitOutputForPreview` IS the engine's "someone is watching" signal, and
      // a node is a pull root only while that mark is fresh — so a collapsed
      // state that merely stopped blitting would make this switch a PRODUCER
      // KILL SWITCH for everything downstream of `out`.
      //
      // ⚠ AND THE COUNTER IS AN ACCUMULATOR, which makes it load-bearing on
      // STATE rather than only on the picture. The score advances on gate edges
      // the factory detects; if the node drops out of the pull set its draw
      // stops running, the edges arriving on SCORE go uncounted, and the number
      // is WRONG when the screen comes back — not merely stale. That is worse
      // than a dropped frame and is the reason this branch exists at all.
      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); }
      catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#0a0a0a';
      ctx2d.fillRect(0, 0, cw, ch);
      // Fit the ENGINE's 4:3 frame into this 8:3 canvas: width-locked, so the
      // engine's own black letterbox bands fall outside the visible box and the
      // digits fill it.
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > ENGINE_ASPECT) { w = cw; h = Math.round(w / ENGINE_ASPECT); y = Math.round((ch - h) / 2); }
      else { h = ch; w = Math.round(h * ENGINE_ASPECT); x = Math.round((cw - w) / 2); }
      // The helper, never a bare drawImage (#1846) — the 7-segment glow has
      // fine edges that a single resampling tap aliases badly.
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop, and it runs in BOTH screen states (see above), so
  // nothing has to restart it on toggle — which removes the "switched it back
  // on and the picture never came back" failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
  onDestroy(() => {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  });
</script>

<div class="sb-screen" data-testid="scoreboard-screen-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={CANVAS_W}
        height={CANVAS_H}
        data-testid="scoreboard-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={toggleScreen}
      data-testid="scoreboard-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the counter display is collapsed and its space reclaimed. SCOREBOARD keeps counting: gates arriving on SCORE and RESET are still counted, so the number is correct when you switch it back on, not stale.'
        : 'SCREEN — turn the counter display off to collapse it and reclaim the vertical space. The counter goes on counting either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<style>
  .sb-screen {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. A
     stacked row cost ~18.8 px on a card with ~11 px of slack and reddened the
     card sweep (spirographs). It OVERLAYS the picture's bottom-right corner. */
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
    /* The module's own backdrop, so the plate does not frame the display in a
       second, slightly different black. */
    background: #0a0a0a;
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
