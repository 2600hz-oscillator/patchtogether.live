<script lang="ts">
  // packages/web/src/lib/ui/modules/acidwarp/AcidwarpScreenBody.svelte
  //
  // THE ACIDWARP SCREEN — the dock full-view body: the module's 320x240 plasma
  // display plus the SCREEN ON/OFF switch the 2026-08-18 ruling requires of
  // every video module.
  //
  // ⚠ WHY THIS FILE EXISTS (#1928 class). `AcidwarpCard.svelte` owns the only
  // picture this module has ever had, and promotion is exactly what stops that
  // card rendering. On most modules losing the preview costs you a monitor; on
  // THIS one it costs you the module — acidwarp has no input and no audio path,
  // it exists solely to synthesize a frame, so a faceplate without the picture
  // is four knobs steering something nobody can see.
  //
  // ⚠ WHAT THIS BODY DELIBERATELY DOES NOT CARRY. The card also printed two
  // resting readouts — `SCENE n/41` and the live speed multiplier (`2.4x` /
  // `STOPPED`). Both are DERIVED STATE IN A TEXT NODE, which the 2026-08-19
  // ruling removes from a faceplate, and neither is ported here. They are not
  // hidden: `scene`'s index is spoken by its own control's `aria-valuetext`,
  // and the speed mapping — whose one non-obvious fact is that NATIVE 1x sits
  // at the knob's MIDPOINT — moved onto the param as two LANDMARKS (`STILL`,
  // `NATIVE`), which are names rather than measurements and therefore permitted.
  //
  // ⚠ THE ENGINE RENDERS OFF THE MAIN THREAD. `acidwarpDef.renderLocus` is
  // `'worker'`, so the picture lives in a worker-owned texture and this body
  // samples it exactly like any downstream consumer — through the standard
  // `blitOutputForPreview` path, never a CPU snapshot poll. Nothing here needs
  // to know that, which is the point of the proxy; it is recorded so a future
  // reader does not go looking for a main-thread framebuffer that is not there.

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

  // The module's native buffer is 320x240 (NTSC 4:3) — the same figure the card
  // uses, and the aspect the engine upsamples from. The canvas is authored at
  // 2x that so the plasma's fine interference bands survive the downscale on a
  // HiDPI dock without shimmering.
  const CANVAS_W = 640;
  const CANVAS_H = 480;
  const SRC_ASPECT = 320 / 240;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT. This component unmounts on dock
  // collapse / LRU eviction (the #1531 / #1574 / #1583 class), and `node.data`
  // is what survives a tab switch (the owner's stated floor), a remount, a
  // reload, and collab sync.
  //
  // ⚠ IT IS THE SAME `previewCollapsed` KEY EVERY OTHER VIDEO SURFACE USES,
  // deliberately: a rack saved before this promotion already carries it, and
  // reading a different key would silently re-open every preview collapsed
  // before the promotion. Absent ⇒ false ⇒ ON.
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
      // `blitOutputForPreview` IS the engine's "someone is watching" signal —
      // it calls `markWatched` itself — and a node is a pull root only while
      // that mark is fresh. So a collapsed state that merely stopped blitting
      // would drop this node out of the pull set and the switch would become a
      // PRODUCER KILL SWITCH for everything downstream of `out`.
      //
      // ⚠ IT MATTERS MORE ON A SOURCE THAN ON A FILTER. acidwarp has NO INPUT:
      // it is the origin of the signal, so a lapsed mark does not stall a
      // preview, it MUTES the generator every downstream node is sampling. A
      // mid-chain filter at least passes something through; this passes nothing.
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
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > SRC_ASPECT) { h = ch; w = Math.round(h * SRC_ASPECT); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / SRC_ASPECT); y = Math.round((ch - h) / 2); }
      // The helper, never a bare drawImage (#1846) — a single resampling tap
      // from the engine buffer to this canvas aliases the plasma's fine
      // interference bands badly.
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

<div class="aw-screen" data-testid="acidwarp-screen-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={CANVAS_W}
        height={CANVAS_H}
        data-testid="acidwarp-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={toggleScreen}
      data-testid="acidwarp-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the plasma display is collapsed and its space reclaimed. ACIDWARP keeps generating: switching it back on shows the LIVE picture, not a stale frame, and everything patched to OUT was fed the whole time.'
        : 'SCREEN — turn the plasma display off to collapse it and reclaim the vertical space. ACIDWARP goes on generating either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<style>
  .aw-screen {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. A
     stacked row cost ~18.8 px on a card with ~11 px of slack and reddened the
     card sweep (spirographs). It OVERLAYS the picture's bottom-right corner.
     ⚠ AND THERE IS NO WIDTH TRANSITION HERE, deliberately: quadralogical's
     animated re-aspect made a one-shot boundingBox read a race that passed on a
     GPU and failed 3/3 under SwiftShader. This body collapses a canvas outright,
     which is instant and has no intermediate state to sample. */
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
    /* The source is a 320x240 index field upsampled by the engine; letting the
       browser smooth it again on the way down is what keeps the palette bands
       readable rather than stair-stepped. */
    image-rendering: auto;
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
