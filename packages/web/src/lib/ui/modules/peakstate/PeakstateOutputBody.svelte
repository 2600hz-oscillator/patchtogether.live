<script lang="ts">
  // packages/web/src/lib/ui/modules/peakstate/PeakstateOutputBody.svelte
  //
  // The PEAKSTATE dock full-view body: the live mandala picture plus the SCREEN
  // ON/OFF switch the 2026-08-18 owner ruling requires of every video module.
  //
  // ⚠ THIS ONE IS A PORT, NOT AN ADDITION — unlike its batch sibling `lines`.
  // `PeakstateCard.svelte` already draws a 144x144 preview, and promotion is
  // exactly what stops that card rendering, so a face without this slot would
  // DELETE a picture the module has always had. That is the #1928 defect in its
  // original form.
  //
  // ⚠ AND IT DELIBERATELY DOES NOT PORT THE CARD'S MECHANISM. The card polls
  // `engine.read(node, 'previewCanvas')` on a 33 ms `setInterval` and blits the
  // engine-owned OffscreenCanvas itself. This body uses the FLEET path,
  // `blitOutputForPreview(nodeId)`, and the swap is an upgrade rather than a
  // rewrite for its own sake:
  //   * it is the same surface. `peakstate.ts` records that `rgb_out` "is the
  //     canonical `surface.texture` AND the OffscreenCanvas handed to the card
  //     through `read('previewCanvas')`", and `blitOutputForPreview` blits
  //     `handle.surface.texture` — so the picture is identical;
  //   * it goes through the VISIBILITY + CADENCE gate instead of a fixed 30 Hz
  //     interval that ran whether or not anyone could see the card; and
  //   * it MARKS THE NODE WATCHED, which the card poll explicitly does not —
  //     the def calls that out ("a card poll is invisible to the port seam").
  // So the faceplate observer is legible to the engine where the card's was
  // not. Recorded because a reader comparing the two files will otherwise think
  // one of them is wrong.
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
  // ⚠ THE REASON HERE IS THE OUTPUT, NOT AN ACCUMULATOR, and the two arguments
  // are worth keeping apart. `grainsOfVision` and `bentbox` argue from
  // ACCUMULATED STATE (a history ring, a feedback ping-pong) that empties if the
  // node stops being pulled. ⚠ PEAKSTATE IS SQUARELY IN THAT CLASS, and it is
  // the strongest case in this batch — do NOT copy a stateless sibling's
  // comment here. The module is a PEN: it keeps a ring buffer of trace samples
  // and `advancePen` walks it every frame, so the picture IS accumulated
  // history. Its own header says the state advance "stays UNCONDITIONAL" while
  // per-port rasterization is gated, precisely so a re-patched output "resumes
  // at the correct phase with the whole trail already in the ring — no jump".
  // A lapsed watch mark drops the node from the pull set entirely, which stops
  // the ADVANCE, not merely a rasterize — the trail stops being drawn and the
  // mandala the player was watching freezes mid-figure.
  //
  // What the mark protects is therefore the FIGURE and all THREE outputs:
  // `mono_out`, `rgb_out` and `out_3d` share one pen ring, so a stalled pull
  // costs every downstream consumer at once, including two outputs this
  // preview does not even show.
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

<div class="peakstate-output" data-testid="peakstate-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="peakstate-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="peakstate-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the mandala preview is collapsed and its space reclaimed. PEAKSTATE keeps tracing and keeps feeding all three outputs: switching it back on shows the LIVE figure, not a stale frame.'
        : 'SCREEN — turn the mandala preview off to collapse it and reclaim the vertical space. PEAKSTATE goes on tracing and feeding MONO, RGB and 3D either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<style>
  .peakstate-output {
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
