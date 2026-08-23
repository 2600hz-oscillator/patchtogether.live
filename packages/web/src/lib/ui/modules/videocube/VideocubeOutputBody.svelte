<script lang="ts">
  // packages/web/src/lib/ui/modules/videocube/VideocubeOutputBody.svelte
  //
  // The VIDEOCUBE dock full-view body: the volumetric ray-march, the SLICE
  // cross-section and the derived WAVE trace — the three surfaces
  // `VideocubeCard.svelte` draws — plus the SCREEN ON/OFF switch the 2026-08-18
  // owner ruling requires of every video module.
  //
  // The SCREEN mechanics are `ChromaOutputBody`'s deliberately: same node-data
  // key, same overlay geometry, same watch-mark handling. Copying them is the
  // point — a second spelling of `previewCollapsed` is how these fork. The
  // three-surface draw is `VideocubeCard`'s, kept in the same ORDER for the
  // reason its own comment gives (each per-port blit overwrites the shared
  // drawing buffer, so every blit must be consumed before the next one).
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
  let sliceCanvasEl: HTMLCanvasElement | null = $state(null);
  let waveCanvasEl: HTMLCanvasElement | null = $state(null);
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

  /** Aspect-fit blit of the engine's drawing buffer onto one card canvas. */
  function drawEngineCanvasInto(target: HTMLCanvasElement, src: CanvasImageSource, label: string): void {
    const ctx2d = target.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    const cw = target.width, ch = target.height;
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    const srcAspect = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    let w = cw, h = ch, x = 0, y = 0;
    if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
    else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
    drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    if (label) {
      ctx2d.fillStyle = 'rgba(255,255,255,0.55)';
      ctx2d.font = '9px ui-monospace, monospace';
      ctx2d.fillText(label, 4, 11);
    }
  }

  /** The derived surface-height wave — the SAME wave `audio_out` plays. */
  function drawWave(target: HTMLCanvasElement, wave: Float32Array | null): void {
    const ctx2d = target.getContext('2d');
    if (!ctx2d) return;
    const W = target.width, H = target.height;
    ctx2d.fillStyle = '#0a0c12';
    ctx2d.fillRect(0, 0, W, H);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx2d.beginPath(); ctx2d.moveTo(0, H / 2); ctx2d.lineTo(W, H / 2); ctx2d.stroke();
    if (wave && wave.length > 1) {
      ctx2d.strokeStyle = '#5ee08a';
      ctx2d.lineWidth = 1.4;
      ctx2d.beginPath();
      const n = wave.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = H / 2 - (wave[i] ?? 0) * (H / 2) * 0.92;
        if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();
    }
    ctx2d.fillStyle = 'rgba(255,255,255,0.5)';
    ctx2d.font = '9px ui-monospace, monospace';
    ctx2d.fillText('WAVE', 4, 11);
  }

  // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937 / #2015).
  // `blitOutputForPreview` IS the engine's "someone is watching" signal — it
  // calls `markWatched` itself, after the gate — and a node is a pull root only
  // while that mark is younger than `WATCH_TTL_MS = 1500`. A collapsed state
  // that merely stopped blitting would stop renewing the mark, and the switch
  // would become a PRODUCER KILL SWITCH wherever nothing downstream is watching.
  //
  // ⚠ ON THIS MODULE THAT WOULD BE THE WORST INSTANCE IN THE FLEET, because a
  // lapsed mark would not stall a preview — it would stall THREE 60-frame RINGS
  // and the AUDIO DRONE derived from them. The rings are accumulators: every
  // frame the node is not pulled is a frame that never enters the history you
  // later SCAN back through, and the same field feeds `audio_out`. So a control
  // labelled SCREEN would silently punch holes in the recording AND mute an
  // output it does not even show. That is why the mark is renewed in BOTH
  // branches below, and why this is not a copy-paste of the stateless case.
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
    const src = videoEngine.canvas as CanvasImageSource;
    // 1) the volumetric ray-march (#1802 — gated preview blit).
    let blitted = false;
    try { blitted = videoEngine.blitOutputForPreview(nodeId); } catch { /* never nuke the rAF loop */ }
    if (blitted) {
      drawEngineCanvasInto(canvasEl, src, '');
      // 2) the SLICE cross-section. ⚠ INSIDE the gate on purpose, exactly as on
      //    the card: its per-port blit is what keeps `slice_out` rendering while
      //    unpatched, so leaving it outside would mean a collapsed VIDEOCUBE
      //    still drove a port nobody can see.
      if (sliceCanvasEl) {
        let sliced = false;
        try { sliced = videoEngine.blitOutputPortForPreview(nodeId, 'slice_out'); } catch { /* */ }
        if (sliced) drawEngineCanvasInto(sliceCanvasEl, src, 'SLICE');
      }
    }
    // 3) the derived WAVE (Canvas2D — no drawing-buffer read, so it is outside
    //    the blit gate and stays legible even before the first blit lands).
    if (waveCanvasEl) {
      let wave: Float32Array | null = null;
      try { wave = videoEngine.read(nodeId, 'lastWave') as Float32Array | null; } catch { /* */ }
      drawWave(waveCanvasEl, wave);
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

<div class="videocube-output" data-testid="videocube-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <div class="stack">
        <canvas
          bind:this={canvasEl}
          width={420}
          height={315}
          data-testid="videocube-face-canvas"
          data-node-id={nodeId}
        ></canvas>
        <div class="viz-row">
          <canvas
            bind:this={sliceCanvasEl}
            class="viz"
            width={132}
            height={99}
            data-testid="videocube-face-slice"
            data-node-id={nodeId}
          ></canvas>
          <canvas
            bind:this={waveCanvasEl}
            class="viz"
            width={132}
            height={99}
            data-testid="videocube-face-wave"
            data-node-id={nodeId}
          ></canvas>
        </div>
      </div>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="videocube-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the ray-march, the slice and the wave are collapsed and their space reclaimed. VIDEOCUBE goes on capturing all three rings and goes on feeding every output, audio included: switching it back on shows the LIVE solid, with no gap in the recording.'
        : 'SCREEN — turn the three pictures off to collapse them and reclaim the vertical space. The rings keep filling and every output keeps feeding either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<style>
  .videocube-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. See the
     OVERLAY paragraph in module-faceplates.md: a stacked row cost ~18.8 px on a
     card with ~11 px of slack and reddened the card sweep. It OVERLAYS the
     picture's bottom-right corner, so the body is exactly the height the
     pictures are. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvases are gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the stack whenever the pictures show. */
    min-height: 18px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
  }
  .viz-row {
    display: flex;
    gap: 4px;
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
