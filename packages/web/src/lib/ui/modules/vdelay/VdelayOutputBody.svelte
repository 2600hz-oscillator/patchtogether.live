<script lang="ts">
  // packages/web/src/lib/ui/modules/vdelay/VdelayOutputBody.svelte
  //
  // The VDELAY dock full-view body: the live echo picture plus the SCREEN
  // ON/OFF switch the 2026-08-18 owner ruling requires of every video module.
  //
  // ⚠ THE SCREEN SWITCH IS AN ADDITION HERE, NOT A PORT — and saying so is the
  // point, because the reverse (a promotion that silently DELETES a card
  // affordance) is the #1928 defect this slot exists to prevent. `VdelayCard.svelte`
  // has no preview canvas and no `previewCollapsed` key at all; it is a flat knob
  // card. So nothing is lost by promotion, and this face GAINS a control its card
  // never had, because the ruling is that every video face ships one and
  // `video-face-screen-source.test.ts` denies a faced video module without it.
  // Recorded so the next reader does not "restore parity" by deleting it.
  //
  // The shape below is `FourPlexVidOutputBody`'s deliberately: same key, same
  // overlay geometry, same watch-mark handling. Copying it is the point — a
  // second spelling of `previewCollapsed` is how these fork.
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
  // calls `markWatched` itself, after the gate, because "a refused frame is not
  // an observation" — and a node is a pull root only while that mark is younger
  // than `WATCH_TTL_MS = 1500`. A collapsed state that merely stopped blitting
  // would stop renewing the mark, and the switch would become a PRODUCER KILL
  // SWITCH wherever nothing downstream is watching. That is the live defect
  // #2015 reports against `spirographs`, and the ruling says the module KEEPS
  // RENDERING.
  //
  // ⚠ VDELAY IS THE ACCUMULATOR CASE, AND THE ONLY ONE IN THIS BATCH — so here
  // the mark protects the module's own CONTENT, not merely its downstream.
  // `grainsOfVision` and `bentbox` argue from accumulated state that empties if
  // the node stops being pulled, and this module is squarely in that class
  // rather than beside it: it keeps a RING OF 32 FRAME BUFFERS, and every draw
  // advances the head — `buffer[head] = input + buffer[head - delayTime] *
  // feedback`. The ring's contents are therefore a function of HOW MANY DRAWS
  // HAPPENED, and nothing reconstructs them.
  //
  // So a collapsed state that dropped the watch mark would not merely stall the
  // output — it would let the echo chain DECAY OUT of the ring while the screen
  // was off, and switching back on would show a picture with its trails
  // missing, rebuilding over the next 32 frames. That is a visible, module-
  // specific regression the SCREEN switch must not cause, and it is the
  // strongest #2015 case in this batch. The three siblings here are stateless
  // and would resume instantly; this one would not.
  //
  // (The DRY path would look fine, which is what makes it a nasty failure: at
  // low Mix the loss is a missing ghost rather than a black frame.)
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
      // Letterbox to the engine aspect — the picture is a VIEWPORT and never
      // changes the output resolution, which is what the def's docs promise.
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

<div class="vdelay-output" data-testid="vdelay-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="vdelay-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="vdelay-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the echo preview is collapsed and its space reclaimed. VDELAY keeps rendering and keeps feeding OUT: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the echo preview off to collapse it and reclaim the vertical space. VDELAY goes on rendering and feeding OUT either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<style>
  .vdelay-output {
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
